/** The top-level {@link RalioClient}. */

import { readFile } from "node:fs/promises";

import { TokenManager } from "./auth.js";
import { loadPrivateKey } from "./crypto.js";
import { RalioConfigError } from "./errors.js";
import { AgentsResource, ChatResource, TransactionsResource } from "./resources/index.js";
import { credentialsPath, keyPathFor, loadCredentials, resolveBaseUrl } from "./store.js";
import { Transport, type RequestOptions, type TransportLike } from "./transport.js";
import type { ChatStreamEvent } from "./types.js";

export interface RalioClientOptions {
  /**
   * The `cb_…` client id. Optional: when omitted (together with
   * `privateKeyPath`), the client reads the credentials persisted by
   * {@link register} or `ralio auth agent`.
   */
  clientId?: string;
  /** Path to the PKCS8 PEM private key written by {@link register}. */
  privateKeyPath?: string;
  /** API origin. Defaults to `RALIO_API_URL`, else production. */
  baseUrl?: string;
  scopes?: string[];
  /** Per-request timeout in ms (default 30000). Streams are not bounded. */
  timeoutMs?: number;
}

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
 * To manage credentials yourself, pass `clientId` + `privateKeyPath`.
 * Credentials load on the first request; use {@link RalioClient.create} to
 * load them eagerly and fail fast instead.
 */
export class RalioClient {
  readonly agents: AgentsResource;
  readonly chat: ChatResource;
  readonly transactions: TransactionsResource;

  private readonly transport: LazyTransport;

  constructor(opts: RalioClientOptions = {}) {
    this.transport = new LazyTransport(() => buildTransport(opts));
    this.agents = new AgentsResource(this.transport);
    this.chat = new ChatResource(this.transport, this.agents);
    this.transactions = new TransactionsResource(this.transport);
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
  const { clientId, pem } = await resolveCredentials(opts);
  const { privateKey, publicJwk, kid } = await loadPrivateKey(pem);

  const tokens = new TokenManager({
    clientId,
    privateKey,
    kid,
    tokenUrl: `${baseUrl}/oauth/token`,
    scopes: opts.scopes,
  });
  return new Transport({
    baseUrl,
    tokens,
    privateKey,
    publicJwk,
    requestTimeoutMs: opts.timeoutMs ?? 30_000,
  });
}

async function resolveCredentials(
  opts: RalioClientOptions,
): Promise<{ clientId: string; pem: string }> {
  if (opts.clientId && opts.privateKeyPath) {
    return { clientId: opts.clientId, pem: await readFile(opts.privateKeyPath, "utf8") };
  }
  if (opts.clientId || opts.privateKeyPath) {
    throw new RalioConfigError(
      "clientId and privateKeyPath must be passed together; omit both to use " +
        "the credentials persisted by register().",
    );
  }

  const stored = await loadCredentials();
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
        "(or `ralio auth agent`) on this host first, or pass clientId and " +
        "privateKeyPath explicitly.",
    );
  }
  let pem: string;
  try {
    pem = await readFile(keyPath, "utf8");
  } catch {
    throw new RalioConfigError(
      `Private key missing at ${keyPath} — the binding may have been revoked ` +
        "and the key removed. Re-run register() with a fresh ticket.",
    );
  }
  return { clientId, pem };
}
