import { randomBytes } from "node:crypto";
import { access, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PrivateJwk, PublicJwk } from "./crypto.js";
import { RalioConfigError } from "./errors.js";

/** Credential material loaded by a {@link CredentialStore}. */
export interface StoredCredentials {
  /** Stable credential-binding client id (`cb_...`). Required to create a client. */
  clientId?: string;
  /** PKCS8 PEM private key, matching the file written by `register()`. */
  privateKeyPem?: string;
  /** Private P-256 JWK, for stores that keep key material as JSON. */
  privateJwk?: PrivateJwk;
  /** Optional public key metadata if the backing store already keeps it. */
  publicJwk?: PublicJwk;
  /** Optional JWK thumbprint / key id if the backing store already keeps it. */
  kid?: string;
  /** The current refresh token for this SDK instance's token family. */
  refreshToken?: string | null;
}

/**
 * Explicit credential storage contract for the SDK.
 *
 * Implement this interface to back credentials with env vars, a secret manager,
 * mounted volume, database row, or another application-specific source.
 */
export interface CredentialStore {
  /** Load stable identity material and this instance's current refresh token. */
  load(): Promise<StoredCredentials>;
  /** Persist the rotated refresh token for this SDK instance. */
  saveRefreshToken(refreshToken: string | null): Promise<void>;
}

/** Credential store that can persist newly registered credential material. */
export interface WritableCredentialStore extends CredentialStore {
  saveCredentials(credentials: StoredCredentials): Promise<void>;
}

export interface LocalFileCredentialStoreOptions {
  /** Stable credential-binding client id. */
  clientId?: string;
  /** Optional file containing the stable credential-binding client id. */
  clientIdPath?: string;
  /** PKCS8 PEM private key file. */
  privateKeyPath: string;
  /** Optional public JWK metadata file, stored as JSON. */
  publicJwkPath?: string;
  /** Optional refresh-token file. Omit for per-process in-memory token storage. */
  refreshTokenPath?: string;
  /** Replace existing identity files when saving registration output. */
  overwrite?: boolean;
}

/**
 * Default local credential store.
 *
 * By default the refresh token is held in memory on this store instance. Pass a
 * distinct `refreshTokenPath` per running instance if you want refresh-token
 * families to survive restarts without being shared across concurrent clients.
 */
export class LocalFileCredentialStore implements WritableCredentialStore {
  private refreshTokenValue: string | null = null;
  private wrotePrivateKey = false;
  private wroteClientId = false;
  private wrotePublicJwk = false;

  constructor(private readonly opts: LocalFileCredentialStoreOptions) {}

  async load(): Promise<StoredCredentials> {
    const clientId = await this.loadClientId();
    const privateKeyPem = await readFile(this.opts.privateKeyPath, "utf8");
    const refreshToken = await this.loadRefreshToken();
    const metadata = await this.loadPublicJwkMetadata();
    return {
      clientId,
      privateKeyPem,
      refreshToken,
      ...metadata,
    };
  }

  async saveCredentials(credentials: StoredCredentials): Promise<void> {
    if (credentials.privateKeyPem && (!this.wrotePrivateKey || this.opts.overwrite)) {
      await writeAtomic(this.opts.privateKeyPath, credentials.privateKeyPem, {
        mode: 0o600,
        overwrite: this.opts.overwrite ?? false,
      });
      this.wrotePrivateKey = true;
    }
    if (
      credentials.clientId &&
      this.opts.clientIdPath &&
      (!this.wroteClientId || this.opts.overwrite)
    ) {
      await writeAtomic(this.opts.clientIdPath, `${credentials.clientId}\n`, {
        mode: 0o600,
        overwrite: this.opts.overwrite ?? false,
      });
      this.wroteClientId = true;
    }
    if (
      credentials.publicJwk &&
      this.opts.publicJwkPath &&
      (!this.wrotePublicJwk || this.opts.overwrite)
    ) {
      const body = credentials.kid
        ? { public_jwk: credentials.publicJwk, kid: credentials.kid }
        : credentials.publicJwk;
      await writeAtomic(this.opts.publicJwkPath, `${JSON.stringify(body, null, 2)}\n`, {
        mode: 0o600,
        overwrite: this.opts.overwrite ?? false,
      });
      this.wrotePublicJwk = true;
    }
    if (credentials.refreshToken !== undefined) {
      await this.saveRefreshToken(credentials.refreshToken);
    }
  }

  async saveRefreshToken(refreshToken: string | null): Promise<void> {
    this.refreshTokenValue = refreshToken;
    if (!this.opts.refreshTokenPath) return;
    if (refreshToken == null) {
      await rm(this.opts.refreshTokenPath, { force: true });
      return;
    }
    await writeAtomic(this.opts.refreshTokenPath, `${refreshToken}\n`, {
      mode: 0o600,
      overwrite: true,
    });
  }

  private async loadClientId(): Promise<string> {
    if (this.opts.clientId) return this.opts.clientId;
    if (!this.opts.clientIdPath) {
      throw new RalioConfigError("clientId or clientIdPath is required");
    }
    const clientId = (await readFile(this.opts.clientIdPath, "utf8")).trim();
    if (!clientId)
      throw new RalioConfigError(`${this.opts.clientIdPath} did not contain client_id`);
    return clientId;
  }

  private async loadRefreshToken(): Promise<string | null> {
    if (!this.opts.refreshTokenPath) return this.refreshTokenValue;
    if (!(await exists(this.opts.refreshTokenPath))) return null;
    const refreshToken = (await readFile(this.opts.refreshTokenPath, "utf8")).trim();
    this.refreshTokenValue = refreshToken || null;
    return this.refreshTokenValue;
  }

  private async loadPublicJwkMetadata(): Promise<Pick<StoredCredentials, "kid" | "publicJwk">> {
    if (!this.opts.publicJwkPath || !(await exists(this.opts.publicJwkPath))) return {};
    const payload = JSON.parse(await readFile(this.opts.publicJwkPath, "utf8")) as unknown;
    return parsePublicJwkMetadata(payload);
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

async function writeAtomic(
  path: string,
  contents: string,
  opts: { mode: number; overwrite: boolean },
): Promise<void> {
  if (!opts.overwrite && (await exists(path))) {
    throw new RalioConfigError(`${path} already exists; pass overwrite: true to replace it`);
  }

  const dir = dirname(path);
  const tmp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  const handle = await open(tmp, "wx", opts.mode);
  try {
    await handle.writeFile(contents);
    await handle.close();
    await rename(tmp, path);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw err;
  }
}

function parsePublicJwkMetadata(payload: unknown): Pick<StoredCredentials, "kid" | "publicJwk"> {
  if (!isRecord(payload)) return {};
  const rawJwk: unknown = isRecord(payload.public_jwk)
    ? payload.public_jwk
    : isRecord(payload.publicJwk)
      ? payload.publicJwk
      : payload;
  const metadata: Pick<StoredCredentials, "kid" | "publicJwk"> = {};
  if (isPublicJwk(rawJwk)) metadata.publicJwk = rawJwk;
  if (typeof payload.kid === "string") metadata.kid = payload.kid;
  return metadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function isPublicJwk(value: unknown): value is PublicJwk {
  if (!isRecord(value)) return false;
  return (
    value.crv === "P-256" &&
    value.kty === "EC" &&
    typeof value.x === "string" &&
    typeof value.y === "string"
  );
}
