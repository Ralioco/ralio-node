/**
 * One-time credential-binding registration (the operator side).
 *
 * The owner mints a `ralio-reg-…` ticket in the console. The operator calls
 * {@link register}: it generates a P-256 keypair locally, submits the public
 * key with the ticket, and polls until the owner approves the binding in the
 * console. The private key never leaves your environment.
 */

import { access } from "node:fs/promises";

import { generateKeypair, privateKeyToPem, type PublicJwk } from "./crypto.js";
import { LocalFileCredentialStore, type WritableCredentialStore } from "./credentials.js";
import { RalioRegistrationError, raiseForResponse } from "./errors.js";
import type { CredentialBinding } from "./types.js";

export const DEFAULT_BASE_URL = "https://api.ralio.co";
const TERMINAL = new Set(["active", "rejected", "expired"]);

export interface RegisterOptions {
  ticket: string;
  /** Path to write the PKCS8 PEM private key. Preserved for the default local-file flow. */
  privateKeyPath?: string;
  /** Optional store for generated identity material. */
  credentialStore?: WritableCredentialStore;
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

/**
 * Run the registration flow and return the approved binding.
 *
 * Generates a keypair, writes the private key to `privateKeyPath`, and blocks
 * until the owner approves (up to `timeoutMs`). Rejects with a
 * {@link RalioRegistrationError} if the binding is rejected, expires, or the
 * timeout elapses.
 */
export async function register(opts: RegisterOptions): Promise<CredentialBinding> {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 900_000;
  const credentialStore = storeFromOptions(opts);

  if (
    !opts.credentialStore &&
    opts.privateKeyPath &&
    !opts.overwrite &&
    (await exists(opts.privateKeyPath))
  ) {
    throw new RalioRegistrationError(
      `${opts.privateKeyPath} already exists; pass overwrite: true to replace it`,
    );
  }

  const { privateKey, publicJwk, kid } = await generateKeypair();
  const privateKeyPem = await privateKeyToPem(privateKey);
  await credentialStore.saveCredentials({ privateKeyPem, publicJwk, kid });

  const pollToken = await submit(base, opts, publicJwk, kid);
  const clientId = await poll(base, pollToken, pollIntervalMs, timeoutMs);
  await credentialStore.saveCredentials({ clientId, privateKeyPem, publicJwk, kid });

  return { clientId, scopes: opts.requestedScopes ?? [] };
}

function storeFromOptions(opts: RegisterOptions): WritableCredentialStore {
  if (opts.credentialStore) return opts.credentialStore;
  if (!opts.privateKeyPath) {
    throw new RalioRegistrationError("privateKeyPath or credentialStore is required");
  }
  return new LocalFileCredentialStore({
    privateKeyPath: opts.privateKeyPath,
    overwrite: opts.overwrite,
  });
}

async function submit(
  base: string,
  opts: RegisterOptions,
  publicJwk: PublicJwk,
  fingerprint: string,
): Promise<string> {
  const body: Record<string, unknown> = { ticket: opts.ticket, public_key_jwk: publicJwk };
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
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const url = `${base}/api/credential-bindings/registrations/${pollToken}`;
  for (;;) {
    const response = await fetch(url);
    if (response.status === 404) {
      throw new RalioRegistrationError("registration expired before approval");
    }
    await raiseForResponse(response);
    const body = (await response.json()) as { status?: string; client_id?: string };
    const status = body.status ?? "";
    if (status === "active") {
      if (typeof body.client_id !== "string" || !body.client_id) {
        throw new RalioRegistrationError("binding active but no client_id returned");
      }
      return body.client_id;
    }
    if (TERMINAL.has(status)) {
      throw new RalioRegistrationError(`registration ${status}`);
    }
    if (Date.now() >= deadline) {
      throw new RalioRegistrationError("timed out waiting for owner approval");
    }
    await sleep(intervalMs);
  }
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
