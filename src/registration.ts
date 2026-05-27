/**
 * One-time credential-binding registration (the operator side).
 *
 * The owner mints a `ralio-reg-…` ticket in the console. The operator calls
 * {@link register} on the agent host: it generates a P-256 keypair locally,
 * submits the public key with the ticket, and polls until the owner approves
 * the binding in the console. The private key never leaves the host.
 */

import { randomBytes } from "node:crypto";
import { open, rename, rm, access } from "node:fs/promises";
import { dirname, join } from "node:path";

import { generateKeypair, privateKeyToPem, type PublicJwk } from "./crypto.js";
import { RalioRegistrationError, raiseForResponse } from "./errors.js";
import type { CredentialBinding } from "./types.js";

export const DEFAULT_BASE_URL = "https://api.ralio.co";
const TERMINAL = new Set(["active", "rejected", "expired"]);

export interface RegisterOptions {
  ticket: string;
  privateKeyPath: string;
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

  if (!opts.overwrite && (await exists(opts.privateKeyPath))) {
    throw new RalioRegistrationError(
      `${opts.privateKeyPath} already exists; pass overwrite: true to replace it`,
    );
  }

  const { privateKey, publicJwk, kid } = await generateKeypair();
  await savePrivateKey(opts.privateKeyPath, await privateKeyToPem(privateKey));

  const pollToken = await submit(base, opts, publicJwk, kid);
  const clientId = await poll(base, pollToken, pollIntervalMs, timeoutMs);

  return { clientId, scopes: opts.requestedScopes ?? [] };
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

/** Write `pem` at `path`, mode 0600, atomically (temp file + rename). */
async function savePrivateKey(path: string, pem: string): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(pem);
    await handle.close();
    await rename(tmp, path);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
