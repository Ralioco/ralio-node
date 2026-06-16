/** The top-level {@link RalioClient}. */

import { TokenManager } from "./auth.js";
import { loadPrivateJwk, loadPrivateKey, type KeyMaterial, type PublicJwk } from "./crypto.js";
import {
  LocalFileCredentialStore,
  type CredentialStore,
  type StoredCredentials,
} from "./credentials.js";
import { RalioConfigError } from "./errors.js";
import { DEFAULT_BASE_URL } from "./registration.js";
import {
  AgentsResource,
  ChatResource,
  PaymentIntentsResource,
  TransactionsResource,
} from "./resources/index.js";
import { Transport } from "./transport.js";

interface RalioClientBaseOptions {
  baseUrl?: string;
  scopes?: string[];
  /** Per-request timeout in ms (default 30000). Streams are not bounded. */
  timeoutMs?: number;
}

export interface RalioClientLocalCredentialOptions extends RalioClientBaseOptions {
  clientId: string;
  /** Path to the PKCS8 PEM private key written by {@link register}. */
  privateKeyPath: string;
  /** Optional per-instance refresh-token file. Omit to keep the token in memory. */
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
 * Obtain `clientId` and the private key once via {@link register}, then:
 *
 * ```ts
 * const client = await RalioClient.create({
 *   clientId: "cb_...",
 *   privateKeyPath: "ralio-key.pem",
 * });
 * const reply = await client.chat.send({ agentId: "...", message: "What's my balance?" });
 * ```
 */
export class RalioClient {
  readonly agents: AgentsResource;
  readonly chat: ChatResource;
  readonly transactions: TransactionsResource;
  readonly paymentIntents: PaymentIntentsResource;

  private constructor(transport: Transport) {
    this.agents = new AgentsResource(transport);
    this.chat = new ChatResource(transport, this.agents);
    this.transactions = new TransactionsResource(transport);
    this.paymentIntents = new PaymentIntentsResource(transport);
  }

  /** Load the private key and build a ready-to-use client. */
  static async create(opts: RalioClientOptions): Promise<RalioClient> {
    const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const credentialStore = storeFromOptions(opts);
    const credentials = await credentialStore.load();
    const { clientId, keyMaterial } = await loadCredentials(credentials);
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
    const transport = new Transport({
      baseUrl,
      tokens,
      privateKey,
      publicJwk,
      requestTimeoutMs: opts.timeoutMs ?? 30_000,
    });
    return new RalioClient(transport);
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

function storeFromOptions(opts: RalioClientOptions): CredentialStore {
  if ("credentialStore" in opts && opts.credentialStore) return opts.credentialStore;
  return new LocalFileCredentialStore({
    clientId: opts.clientId,
    privateKeyPath: opts.privateKeyPath,
    refreshTokenPath: opts.refreshTokenPath,
  });
}

async function loadCredentials(
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

function samePublicJwk(a: PublicJwk, b: PublicJwk): boolean {
  return a.crv === b.crv && a.kty === b.kty && a.x === b.x && a.y === b.y;
}
