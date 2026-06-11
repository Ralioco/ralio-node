/**
 * On-disk credential store, shared with the Ralio CLI.
 *
 * The layout mirrors the CLI byte-for-byte so {@link register} here and
 * `ralio auth agent` are interchangeable — either one can write the
 * credentials and the other (or {@link RalioClient}) can consume them:
 *
 * - `~/.ralio/credentials.json` (0600) — `client_id`, `key_jkt`, tokens.
 * - `~/.ralio/keys/<jkt>.pem`   (0600) — the P-256 private key, PKCS8 PEM,
 *   named by its RFC 7638 thumbprint.
 *
 * `RALIO_CONFIG_DIR` overrides `~/.ralio` (tests, multi-tenant hosts).
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_BASE_URL = "https://api.ralio.co";

/** Explicit value, else `RALIO_API_URL`, else production. Trailing slashes stripped. */
export function resolveBaseUrl(explicit?: string): string {
  return (explicit ?? env("RALIO_API_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function configDir(): string {
  return env("RALIO_CONFIG_DIR") ?? join(homedir(), ".ralio");
}

/** Env var value, with the empty string treated as unset. */
function env(name: string): string | undefined {
  return process.env[name] || undefined;
}

export function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

/** Default on-disk location for the key whose RFC 7638 thumbprint is `jkt`. */
export function keyPathFor(jkt: string): string {
  return join(configDir(), "keys", jkt + ".pem");
}

/**
 * The persisted credential shape. Field names match the CLI's
 * `credentials.json` exactly; `key_path` is an SDK extension recording where
 * the key actually lives when the caller chose a custom `privateKeyPath`
 * (the CLI ignores unknown fields).
 */
export interface StoredCredentials {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  /** Unix time (seconds) the tokens were obtained. */
  obtained_at?: number;
  client_id?: string;
  key_jkt?: string;
  key_path?: string;
  scope?: string;
  auth_method?: string;
}

export async function saveCredentials(creds: StoredCredentials): Promise<void> {
  await ensureSecretDir(configDir());
  await writeSecretFile(credentialsPath(), JSON.stringify(creds, null, 2) + "\n");
}

/** Load persisted credentials, or `null` when absent or unreadable. */
export async function loadCredentials(): Promise<StoredCredentials | null> {
  let raw: string;
  try {
    raw = await readFile(credentialsPath(), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as StoredCredentials)
      : null;
  } catch {
    return null;
  }
}

/** Create the keys directory (and config dir) with owner-only permissions. */
export async function ensureKeysDir(): Promise<void> {
  await ensureSecretDir(configDir());
  await ensureSecretDir(join(configDir(), "keys"));
}

/**
 * Write `pem` at `path`, mode 0600, atomically. The parent directory must
 * already exist — callers writing into the store go through
 * {@link ensureKeysDir} first; callers with a custom path manage their own.
 */
export async function savePrivateKey(path: string, pem: string): Promise<void> {
  await writeSecretFile(path, pem);
}

/** Remove a private key file, if present. Idempotent. */
export async function deletePrivateKey(path: string): Promise<void> {
  await rm(path, { force: true });
}

async function ensureSecretDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by the umask and skipped for pre-existing dirs.
  await chmod(dir, 0o700).catch(() => undefined);
}

/** Atomic secret write: temp file opened 0600, then rename over `path`. */
async function writeSecretFile(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.close();
    await rename(tmp, path);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw err;
  }
}
