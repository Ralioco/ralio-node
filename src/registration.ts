/**
 * One-time credential-binding registration (the operator side).
 *
 * The owner mints a `ralio-reg-…` ticket in the console. The operator calls
 * {@link register} on the agent host: it generates a P-256 keypair locally,
 * submits the public key with the ticket, and polls until the owner approves
 * the binding in the console. The private key never leaves the host.
 *
 * On approval the first access token is minted and the credentials are
 * persisted to `~/.ralio/` (same store as `ralio auth agent`), so a
 * no-argument `new RalioClient()` works from then on.
 */

import { access } from "node:fs/promises";

import {
  CLIENT_ASSERTION_TYPE,
  generateKeypair,
  privateKeyToPem,
  signClientAssertion,
  type CryptoKey,
  type PublicJwk,
} from "./crypto.js";
import { RalioConfigError, RalioRegistrationError, raiseForResponse } from "./errors.js";
import {
  deletePrivateKey,
  ensureKeysDir,
  keyPathFor,
  resolveBaseUrl,
  saveCredentials,
  savePrivateKey,
} from "./store.js";
import type { CredentialBinding } from "./types.js";

export { DEFAULT_BASE_URL } from "./store.js";

export interface RegisterOptions {
  /**
   * Registration ticket (`ralio-reg-…`) from the console. Defaults to the
   * `RALIO_REGISTRATION_TICKET` environment variable — the same one the CLI
   * and Python SDK read.
   */
  ticket?: string;
  /**
   * Where to write the private key. Defaults to `~/.ralio/keys/<jkt>.pem`
   * inside the shared credential store.
   */
  privateKeyPath?: string;
  /** API origin. Defaults to `RALIO_API_URL`, else production. */
  baseUrl?: string;
  requestedScopes?: string[];
  clientMetadata?: Record<string, unknown>;
  /** Poll interval in milliseconds (default 3000). */
  pollIntervalMs?: number;
  /** Overall timeout in milliseconds (default 900000 = 15 min). */
  timeoutMs?: number;
  /** Replace an existing key file. Off by default to avoid clobbering. */
  overwrite?: boolean;
}

type PollOutcome =
  | { status: "active"; clientId: string }
  | { status: "rejected" | "expired" | "invalid"; message: string }
  | { status: "timeout" };

/**
 * Run the registration flow and return the approved binding.
 *
 * Generates a keypair, writes the private key to disk, and blocks until the
 * owner approves (up to `timeoutMs`). On approval it mints the first access
 * token and persists the credentials, so `new RalioClient()` needs no
 * arguments afterwards. Rejects with a {@link RalioRegistrationError} if the
 * binding is rejected, expires, or the timeout elapses.
 */
export async function register(opts: RegisterOptions = {}): Promise<CredentialBinding> {
  const ticket = (opts.ticket ?? process.env.RALIO_REGISTRATION_TICKET ?? "").trim();
  if (!ticket) {
    throw new RalioConfigError(
      "Missing registration ticket: pass `ticket` or set RALIO_REGISTRATION_TICKET. " +
        "Mint one in the console at Settings → Credentials.",
    );
  }
  const base = resolveBaseUrl(opts.baseUrl);
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 900_000;

  const { privateKey, publicJwk, kid } = await generateKeypair();

  let keyPath: string;
  if (opts.privateKeyPath) {
    if (!opts.overwrite && (await exists(opts.privateKeyPath))) {
      throw new RalioRegistrationError(
        `${opts.privateKeyPath} already exists; pass overwrite: true to replace it`,
      );
    }
    keyPath = opts.privateKeyPath;
  } else {
    // Thumbprint-named keys in the store are unique per keypair, so there is
    // nothing to clobber.
    await ensureKeysDir();
    keyPath = keyPathFor(kid);
  }
  await savePrivateKey(keyPath, await privateKeyToPem(privateKey));

  let pollToken: string;
  try {
    pollToken = await submit(base, ticket, opts, publicJwk, kid);
  } catch (err) {
    // No binding to bind it to — a key bound to nothing is dead weight.
    await deletePrivateKey(keyPath);
    throw err;
  }

  const outcome = await poll(base, pollToken, pollIntervalMs, timeoutMs);
  if (outcome.status === "timeout") {
    // The owner may still approve after we stop polling, so the key stays:
    // the binding's client_id is visible in the console and can be paired
    // with this key via explicit RalioClient options.
    throw new RalioRegistrationError(
      `timed out waiting for owner approval; the private key remains at ${keyPath}`,
    );
  }
  if (outcome.status !== "active") {
    await deletePrivateKey(keyPath);
    throw new RalioRegistrationError(outcome.message);
  }
  const clientId = outcome.clientId;

  const token = await mintFirstToken(base, clientId, privateKey, kid);
  await saveCredentials({
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? "",
    expires_in: token.expires_in ?? 1800,
    obtained_at: Date.now() / 1000,
    client_id: clientId,
    key_jkt: kid,
    key_path: keyPath,
    scope: token.scope ?? "",
    auth_method: "private_key_jwt",
  });

  const scopes = token.scope
    ? token.scope.split(" ").filter(Boolean)
    : (opts.requestedScopes ?? []);
  return { clientId, scopes, keyPath };
}

async function submit(
  base: string,
  ticket: string,
  opts: RegisterOptions,
  publicJwk: PublicJwk,
  fingerprint: string,
): Promise<string> {
  const body: Record<string, unknown> = { ticket, public_key_jwk: publicJwk };
  if (opts.requestedScopes) body.requested_scopes = opts.requestedScopes;
  if (opts.clientMetadata) body.client_metadata = opts.clientMetadata;

  const response = await fetch(`${base}/api/credential-bindings/registrations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await raiseForResponse(response);
  const payload = (await response.json()) as { fingerprint?: string; poll_token?: string };

  // The server echoes the JWK thumbprint it computed. A mismatch means our
  // public key was rewritten in flight — refuse to proceed rather than let the
  // owner approve a binding for a key we don't hold.
  if (payload.fingerprint && payload.fingerprint !== fingerprint) {
    throw new RalioRegistrationError(
      "fingerprint mismatch between local key and server response; aborting",
    );
  }
  if (typeof payload.poll_token !== "string" || !payload.poll_token) {
    throw new RalioRegistrationError("registration response did not include a poll_token");
  }
  return payload.poll_token;
}

async function poll(
  base: string,
  pollToken: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<PollOutcome> {
  const deadline = Date.now() + timeoutMs;
  const url = `${base}/api/credential-bindings/registrations/${pollToken}`;
  for (;;) {
    const response = await fetch(url);
    if (response.status === 404) {
      // The poll token was wiped or aged out — terminal, same as expiry.
      return { status: "expired", message: "registration expired before approval" };
    }
    await raiseForResponse(response);
    const body = (await response.json()) as { status?: string; client_id?: string };
    const status = body.status ?? "";
    if (status === "active") {
      if (typeof body.client_id !== "string" || !body.client_id) {
        return { status: "invalid", message: "binding active but no client_id returned" };
      }
      return { status: "active", clientId: body.client_id };
    }
    if (status === "rejected" || status === "expired") {
      return { status, message: `registration ${status}` };
    }
    if (Date.now() >= deadline) {
      return { status: "timeout" };
    }
    await sleep(intervalMs);
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/**
 * Mint the first access token via `client_credentials` + `private_key_jwt`.
 * No `scope` parameter: the grant inherits the binding's full scope ceiling,
 * which the response echoes back.
 */
async function mintFirstToken(
  base: string,
  clientId: string,
  privateKey: CryptoKey,
  kid: string,
): Promise<TokenResponse> {
  const tokenUrl = `${base}/oauth/token`;
  const assertion = await signClientAssertion(privateKey, {
    clientId,
    audience: tokenUrl,
    kid,
  });
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: assertion,
    }).toString(),
  });
  await raiseForResponse(response);
  const token = (await response.json()) as TokenResponse;
  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new RalioRegistrationError("token endpoint returned no access_token");
  }
  return token;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
