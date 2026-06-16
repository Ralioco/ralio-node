/**
 * One-time credential-binding registration (the operator side).
 *
 * The owner mints a `ralio-reg-...` ticket in the console — that is where
 * consent happens. The operator calls {@link register}: it generates a P-256
 * keypair locally and submits the public key with the ticket; the binding is
 * active as soon as the server responds. The owner gets an email receipt with
 * a revoke link. The private key never leaves your environment.
 *
 * By default activation mints the first access token and persists credentials
 * to `~/.ralio/` (same store as `ralio auth agent`), so a no-argument
 * `new RalioClient()` works from then on. Pass a writable credential store to
 * persist identity material somewhere else.
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
import type { WritableCredentialStore } from "./credentials.js";
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
   * Registration ticket (`ralio-reg-...`) from the console. Defaults to the
   * `RALIO_REGISTRATION_TICKET` environment variable — the same one the CLI
   * and Python SDK read.
   */
  ticket?: string;
  /**
   * Where to write the private key. Defaults to `~/.ralio/keys/<jkt>.pem`
   * inside the shared credential store.
   */
  privateKeyPath?: string;
  /** Optional store for generated identity material. */
  credentialStore?: WritableCredentialStore;
  /** API origin. Defaults to `RALIO_API_URL`, else production. */
  baseUrl?: string;
  requestedScopes?: string[];
  clientMetadata?: Record<string, unknown>;
  /** Replace an existing key file. Off by default to avoid clobbering. */
  overwrite?: boolean;
}

interface RegistrationResponse {
  fingerprint?: string;
  client_id?: string;
}

/**
 * Register this host and return the active binding.
 *
 * One call, immediate activation: generates a keypair, writes/stores the
 * private key, and submits the public key with the ticket. The binding is
 * active when the server responds — there is no owner-approval step (consent
 * happened when the owner minted the ticket; they receive an email receipt
 * with a revoke link). The first access token is then minted and the
 * credentials persisted, so `new RalioClient()` needs no arguments afterwards
 * when the default store is used.
 *
 * Rejects with a {@link RalioRegistrationError} when the ticket is invalid,
 * expired, or already consumed, or the public key is unusable.
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

  const { privateKey, publicJwk, kid } = await generateKeypair();
  const privateKeyPem = await privateKeyToPem(privateKey);
  const credentialStore = opts.credentialStore;

  let keyPath = "";
  if (credentialStore) {
    await credentialStore.saveCredentials({ privateKeyPem, publicJwk, kid });
  } else if (opts.privateKeyPath) {
    if (!opts.overwrite && (await exists(opts.privateKeyPath))) {
      throw new RalioRegistrationError(
        `${opts.privateKeyPath} already exists; pass overwrite: true to replace it`,
      );
    }
    keyPath = opts.privateKeyPath;
    await savePrivateKey(keyPath, privateKeyPem);
  } else {
    // Thumbprint-named keys in the store are unique per keypair, so there is
    // nothing to clobber.
    await ensureKeysDir();
    keyPath = keyPathFor(kid);
    await savePrivateKey(keyPath, privateKeyPem);
  }

  let payload: RegistrationResponse;
  try {
    payload = await submit(base, ticket, opts, publicJwk);
  } catch (err) {
    if (keyPath) await deletePrivateKey(keyPath);
    throw err;
  }

  // The server echoes the RFC 7638 thumbprint it computed. A mismatch means
  // the binding went live under a key this host does not hold (our public
  // key was rewritten in flight, or a server bug) — the credential must be
  // revoked, not used.
  if (payload.fingerprint && payload.fingerprint !== kid) {
    if (keyPath) await deletePrivateKey(keyPath);
    const handle = payload.client_id ? ` ${payload.client_id}` : "";
    throw new RalioRegistrationError(
      "fingerprint mismatch between local key and server response: the " +
        `binding${handle} is live under a key this host does not hold — ` +
        "revoke it in the console at Settings → Credentials",
    );
  }

  if (typeof payload.client_id !== "string" || !payload.client_id) {
    // Pre-cutover server: it created a pending binding for our public key
    // and expects owner approval + polling. Keep the key — the owner may
    // still approve the pending binding on the old flow.
    const location = keyPath ? keyPath : "the credential store";
    throw new RalioRegistrationError(
      "registration response did not include a client_id — this server " +
        "still requires owner approval; upgrade the server to synchronous " +
        `activation (the private key was kept at ${location})`,
    );
  }
  const clientId = payload.client_id;

  const token = await mintFirstToken(base, clientId, privateKey, kid);
  if (credentialStore) {
    await credentialStore.saveCredentials({
      clientId,
      privateKeyPem,
      publicJwk,
      kid,
      refreshToken: token.refresh_token ?? null,
    });
  } else {
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
  }

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
): Promise<RegistrationResponse> {
  const body: Record<string, unknown> = { ticket, public_key_jwk: publicJwk };
  if (opts.requestedScopes) body.requested_scopes = opts.requestedScopes;
  if (opts.clientMetadata) body.client_metadata = opts.clientMetadata;

  const response = await fetch(`${base}/api/credential-bindings/registrations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new RalioRegistrationError(await registrationErrorMessage(response));
  }
  return (await response.json()) as RegistrationResponse;
}

/**
 * Render the registration endpoint's error detail — `invalid_ticket`,
 * `ticket_expired`, `ticket_already_consumed`, `public_key_already_in_use`,
 * `invalid_public_key`, `invalid_scope`, `scope_exceeds_ticket_ceiling` —
 * preferring `error_description`. For a consumed ticket the description
 * tells a legitimate operator that someone else spent it and the owner
 * should revoke the resulting credential; `used_at` / `used_by_host` are
 * appended when the server knows them.
 */
async function registrationErrorMessage(response: Response): Promise<string> {
  let detail: unknown;
  try {
    detail = ((await response.json()) as { detail?: unknown }).detail;
  } catch {
    detail = undefined;
  }
  if (typeof detail === "string" && detail) return detail;
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    const message =
      typeof d.error_description === "string" && d.error_description
        ? d.error_description
        : typeof d.error === "string"
          ? d.error
          : "";
    if (message) {
      const context: string[] = [];
      if (typeof d.used_at === "string" && d.used_at) context.push(`used at ${d.used_at}`);
      if (typeof d.used_by_host === "string" && d.used_by_host) {
        context.push(`by ${d.used_by_host}`);
      }
      return context.length > 0 ? `${message} (${context.join(", ")})` : message;
    }
  }
  return `registration failed: HTTP ${response.status}`;
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
