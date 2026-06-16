/** The top-level {@link RalioClient}. */

import { readFile, rm, writeFile } from "node:fs/promises";

import { TokenManager } from "./auth.js";
import { loadPrivateJwk, loadPrivateKey, type KeyMaterial, type PublicJwk } from "./crypto.js";
import {
  LocalFileCredentialStore,
  type CredentialStore,
  type StoredCredentials,
} from "./credentials.js";
import { RalioConfigError } from "./errors.js";
import {
  AgentsResource,
  ChatResource,
  PaymentIntentsResource,
  TransactionsResource,
} from "./resources/index.js";
import {
  credentialsPath,
  keyPathFor,
  loadCredentials as loadPersistedCredentials,
  resolveBaseUrl,
  saveCredentials as savePersistedCredentials,
} from "./store.js";
import { Transport, type RequestOptions, type TransportLike } from "./transport.js";
import type { ChatStreamEvent } from "./types.js";

interface RalioClientBaseOptions {
  /** API origin. Defaults to `RALIO_API_URL`, else production. */
  baseUrl?: string;
  scopes?: string[];
  /** Per-request timeout in ms (default 30000). Streams are not bounded. */
  timeoutMs?: number;
}

export interface RalioClientLocalCredentialOptions extends RalioClientBaseOptions {
  /**
   * The `cb_...` client id. Optional: when omitted (together with
   * `privateKeyPath`), the client reads the credentials persisted by
   * {@link register}.
   */
  clientId?: string;
  /** Path to the PKCS8 PEM private key written by {@link register}. */
  privateKeyPath?: string;
  /** Optional per-instance refresh-token file. Omit to use the selected store's default. */
  refreshTokenPath?: string;
  credentialStore?: never;
}

export interface RalioClientStoreOptions extends RalioClientBaseOptions {
  /** Custom credential store for identity material and this instance's refresh token. */
  credentialStore: CredentialStore;
  clientId?: never;
  privateKeyPath?: never;
  refreshTokenPath?: never;
}

export type RalioClientOptions = RalioClientLocalCredentialOptions | RalioClientStoreOptions;

/**
 * Client for the Ralio API, authenticated via a credential binding (OAuth 2.1
 * `client_credentials` + `private_key_jwt` + DPoP).
 *
 * After a one-time {@link register} on this host, no configuration is needed:
 *
 * ```ts
 * const client = new RalioClient(); // reads the persisted credentials
 * const reply = await client.chat.send({ message: "What's my balance?" });
 * ```
 *
 * To manage credentials yourself, pass `clientId` + `privateKeyPath` or a
 * custom `credentialStore`. Credentials load on the first request; use
 * {@link RalioClient.create} to load them eagerly and fail fast instead.
 */
export class RalioClient {
  readonly agents: AgentsResource;
  readonly chat: ChatResource;
  readonly transactions: TransactionsResource;
  readonly paymentIntents: PaymentIntentsResource;

  private readonly transport: LazyTransport;

  constructor(opts: RalioClientOptions = {}) {
    this.transport = new LazyTransport(() => buildTransport(opts));
    this.agents = new AgentsResource(this.transport);
    this.chat = new ChatResource(this.transport, this.agents);
    this.transactions = new TransactionsResource(this.transport);
    this.paymentIntents = new PaymentIntentsResource(this.transport);
  }

  /** Build a client and load its credentials eagerly, failing fast. */
  static async create(opts: RalioClientOptions = {}): Promise<RalioClient> {
    const client = new RalioClient(opts);
    await client.transport.resolve();
    return client;
  }

  /**
   * Release resources. Present for API symmetry and forward compatibility;
   * the native `fetch` transport holds no long-lived connections of its own.
   */
  close(): void {
    // no-op today
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/** Defers credential loading and key import to the first request. */
class LazyTransport implements TransportLike {
  private inner?: Promise<Transport>;

  constructor(private readonly factory: () => Promise<Transport>) {}

  resolve(): Promise<Transport> {
    this.inner ??= this.factory().catch((err: unknown) => {
      // Don't cache the failure — a later call may find credentials that
      // didn't exist yet (e.g. register() ran in the meantime).
      this.inner = undefined;
      throw err;
    });
    return this.inner;
  }

  async request(method: string, path: string, opts?: RequestOptions): Promise<Response> {
    return (await this.resolve()).request(method, path, opts);
  }

  async *streamSse(
    method: string,
    path: string,
    opts?: { jsonBody?: Record<string, unknown> },
  ): AsyncGenerator<ChatStreamEvent> {
    const transport = await this.resolve();
    yield* transport.streamSse(method, path, opts);
  }
}

async function buildTransport(opts: RalioClientOptions): Promise<Transport> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const credentialStore = credentialStoreFromOptions(opts);
  const credentials = await credentialStore.load();
  const { clientId, keyMaterial } = await loadCredentialMaterial(credentials);
  const { privateKey, publicJwk, kid } = keyMaterial;

  const tokens = new TokenManager({
    clientId,
    privateKey,
    kid,
    tokenUrl: `${baseUrl}/oauth/token`,
    scopes: opts.scopes,
    refreshToken: credentials.refreshToken ?? null,
    saveRefreshToken: (refreshToken) => credentialStore.saveRefreshToken(refreshToken),
  });
  return new Transport({
    baseUrl,
    tokens,
    privateKey,
    publicJwk,
    requestTimeoutMs: opts.timeoutMs ?? 30_000,
  });
}

function credentialStoreFromOptions(opts: RalioClientOptions): CredentialStore {
  if ("credentialStore" in opts && opts.credentialStore) return opts.credentialStore;
  if (opts.clientId && opts.privateKeyPath) {
    return new LocalFileCredentialStore({
      clientId: opts.clientId,
      privateKeyPath: opts.privateKeyPath,
      refreshTokenPath: opts.refreshTokenPath,
    });
  }
  if (opts.clientId || opts.privateKeyPath) {
    throw new RalioConfigError(
      "clientId and privateKeyPath must be passed together; omit both to use " +
        "the credentials persisted by register().",
    );
  }
  return new PersistedCredentialStore(opts.refreshTokenPath);
}

async function loadCredentialMaterial(
  credentials: StoredCredentials,
): Promise<{ clientId: string; keyMaterial: KeyMaterial }> {
  if (!credentials.clientId) {
    throw new RalioConfigError("credential store did not provide client_id");
  }
  const keyMaterial = credentials.privateKeyPem
    ? await loadPrivateKey(credentials.privateKeyPem)
    : credentials.privateJwk
      ? await loadPrivateJwk(credentials.privateJwk)
      : null;
  if (!keyMaterial) {
    throw new RalioConfigError("credential store did not provide private key material");
  }
  if (credentials.publicJwk && !samePublicJwk(credentials.publicJwk, keyMaterial.publicJwk)) {
    throw new RalioConfigError("stored public JWK does not match the private key");
  }
  if (credentials.kid && credentials.kid !== keyMaterial.kid) {
    throw new RalioConfigError("stored key id does not match the private key");
  }
  return { clientId: credentials.clientId, keyMaterial };
}

class PersistedCredentialStore implements CredentialStore {
  constructor(private readonly refreshTokenPath?: string) {}

  async load(): Promise<StoredCredentials> {
    const stored = await loadPersistedCredentials();
    const clientId = typeof stored?.client_id === "string" ? stored.client_id : "";
    const jkt = typeof stored?.key_jkt === "string" ? stored.key_jkt : "";
    const keyPath =
      typeof stored?.key_path === "string" && stored.key_path
        ? stored.key_path
        : jkt
          ? keyPathFor(jkt)
          : "";
    if (!clientId || !keyPath) {
      throw new RalioConfigError(
        `No Ralio credentials found at ${credentialsPath()}. Run register() ` +
          "on this host first, or pass clientId and privateKeyPath explicitly.",
      );
    }

    let privateKeyPem: string;
    try {
      privateKeyPem = await readFile(keyPath, "utf8");
    } catch {
      throw new RalioConfigError(
        `Private key missing at ${keyPath} — the binding may have been revoked ` +
          "and the key removed. Re-run register() with a fresh ticket.",
      );
    }

    const instanceRefreshToken = this.refreshTokenPath
      ? await loadRefreshTokenFile(this.refreshTokenPath)
      : stored?.refresh_token || null;
    return {
      clientId,
      privateKeyPem,
      kid: jkt || undefined,
      refreshToken: instanceRefreshToken,
    };
  }

  async saveRefreshToken(refreshToken: string | null): Promise<void> {
    if (this.refreshTokenPath) {
      await saveRefreshTokenFile(this.refreshTokenPath, refreshToken);
      return;
    }
    const stored = await loadPersistedCredentials();
    if (!stored) {
      throw new RalioConfigError(
        `No Ralio credentials found at ${credentialsPath()}; cannot save refresh token`,
      );
    }
    await savePersistedCredentials({ ...stored, refresh_token: refreshToken ?? "" });
  }
}

async function loadRefreshTokenFile(path: string): Promise<string | null> {
  try {
    const token = (await readFile(path, "utf8")).trim();
    return token || null;
  } catch {
    return null;
  }
}

async function saveRefreshTokenFile(path: string, refreshToken: string | null): Promise<void> {
  if (refreshToken == null) {
    await rm(path, { force: true });
    return;
  }
  await writeFile(path, `${refreshToken}\n`, { mode: 0o600 });
}

function samePublicJwk(a: PublicJwk, b: PublicJwk): boolean {
  return a.crv === b.crv && a.kty === b.kty && a.x === b.x && a.y === b.y;
}
