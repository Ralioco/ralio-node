/** The top-level {@link RalioClient}. */

import { readFile } from "node:fs/promises";

import { TokenManager } from "./auth.js";
import { loadPrivateKey } from "./crypto.js";
import { DEFAULT_BASE_URL } from "./registration.js";
import { ChatResource, TransactionsResource } from "./resources/index.js";
import { Transport } from "./transport.js";

export interface RalioClientOptions {
  clientId: string;
  /** Path to the PKCS8 PEM private key written by {@link register}. */
  privateKeyPath: string;
  baseUrl?: string;
  scopes?: string[];
  /** Per-request timeout in ms (default 30000). Streams are not bounded. */
  timeoutMs?: number;
}

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
  readonly chat: ChatResource;
  readonly transactions: TransactionsResource;

  private constructor(transport: Transport) {
    this.chat = new ChatResource(transport);
    this.transactions = new TransactionsResource(transport);
  }

  /** Load the private key and build a ready-to-use client. */
  static async create(opts: RalioClientOptions): Promise<RalioClient> {
    const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const pem = await readFile(opts.privateKeyPath, "utf8");
    const { privateKey, publicJwk, kid } = await loadPrivateKey(pem);

    const tokens = new TokenManager({
      clientId: opts.clientId,
      privateKey,
      kid,
      tokenUrl: `${baseUrl}/oauth/token`,
      scopes: opts.scopes,
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
