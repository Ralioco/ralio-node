/**
 * DPoP-bound HTTP transport.
 *
 * Every request carries `Authorization: DPoP <token>` plus a freshly-signed
 * `DPoP` proof for that exact method + URL + token. On a 401 the transport
 * refreshes the token once and retries with a brand-new proof (the proof `jti`
 * is single-use server-side, so the retry must re-sign).
 */

import type { TokenManager } from "./auth.js";
import { signDpopProof, type CryptoKey, type PublicJwk } from "./crypto.js";
import { RalioAPIError, raiseForResponse } from "./errors.js";
import { buildStreamEvent, type ChatStreamEvent } from "./types.js";

export interface TransportOptions {
  baseUrl: string;
  tokens: TokenManager;
  privateKey: CryptoKey;
  publicJwk: PublicJwk;
  /** Per-request timeout in ms. Applies to `request`, not to SSE streams. */
  requestTimeoutMs?: number;
}

export interface RequestOptions {
  jsonBody?: Record<string, unknown>;
  params?: Record<string, string | number | undefined>;
}

/**
 * The surface resources call. Implemented by {@link Transport} and by the
 * client's lazy wrapper that defers credential loading to the first request.
 */
export interface TransportLike {
  request(method: string, path: string, opts?: RequestOptions): Promise<Response>;
  streamSse(
    method: string,
    path: string,
    opts?: { jsonBody?: Record<string, unknown> },
  ): AsyncGenerator<ChatStreamEvent>;
}

export class Transport implements TransportLike {
  private readonly baseUrl: string;
  private readonly tokens: TokenManager;
  private readonly privateKey: CryptoKey;
  private readonly publicJwk: PublicJwk;
  private readonly requestTimeoutMs?: number;

  constructor(opts: TransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.tokens = opts.tokens;
    this.privateKey = opts.privateKey;
    this.publicJwk = opts.publicJwk;
    this.requestTimeoutMs = opts.requestTimeoutMs;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = this.buildUrl(path, opts.params);
    const init = (headers: Record<string, string>): RequestInit => ({
      method,
      headers: opts.jsonBody ? { ...headers, "Content-Type": "application/json" } : headers,
      body: opts.jsonBody ? JSON.stringify(opts.jsonBody) : undefined,
      signal: this.requestTimeoutMs ? AbortSignal.timeout(this.requestTimeoutMs) : undefined,
    });

    let response = await fetch(url, init(await this.authHeaders(method, url)));
    if (response.status === 401) {
      await this.tokens.forceRefresh();
      response = await fetch(url, init(await this.authHeaders(method, url)));
    }
    await raiseForResponse(response);
    return response;
  }

  async *streamSse(
    method: string,
    path: string,
    opts: { jsonBody?: Record<string, unknown> } = {},
  ): AsyncGenerator<ChatStreamEvent> {
    const url = this.buildUrl(path);
    const init = async (): Promise<RequestInit> => ({
      method,
      headers: {
        ...(await this.authHeaders(method, url)),
        Accept: "text/event-stream",
        ...(opts.jsonBody ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.jsonBody ? JSON.stringify(opts.jsonBody) : undefined,
    });

    let response = await fetch(url, await init());
    if (response.status === 401) {
      await response.body?.cancel();
      await this.tokens.forceRefresh();
      response = await fetch(url, await init());
    }
    await raiseForResponse(response);
    yield* parseSse(response);
  }

  private buildUrl(path: string, params?: RequestOptions["params"]): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async authHeaders(method: string, url: string): Promise<Record<string, string>> {
    const token = await this.tokens.accessToken();
    const proof = await signDpopProof(this.privateKey, {
      method,
      url: htu(url),
      accessToken: token,
      jwk: this.publicJwk,
    });
    return { Authorization: `DPoP ${token}`, DPoP: proof };
  }
}

/** Strip query and fragment — the `htu` claim must be scheme+host+path. */
function htu(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

/** Yield one {@link ChatStreamEvent} per SSE record (blank-line delimited). */
async function* parseSse(response: Response): AsyncGenerator<ChatStreamEvent> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const flush = (): ChatStreamEvent | null => {
    if (dataLines.length === 0) return null;
    const event = buildEvent(eventName, dataLines);
    eventName = "message";
    dataLines = [];
    return event;
  };

  const handleLine = (line: string): ChatStreamEvent | null => {
    if (line === "") return flush();
    if (line.startsWith(":")) return null; // comment / keep-alive
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    return null;
  };

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const raw = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const event = handleLine(line);
      if (event) yield event;
    }
  }
  // Trailing record with no terminating blank line.
  const tail = flush();
  if (tail) yield tail;
}

function buildEvent(eventName: string, dataLines: string[]): ChatStreamEvent {
  const raw = dataLines.join("\n");
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    payload =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed };
  } catch {
    payload = { raw };
  }
  if (eventName === "error") {
    const message = typeof payload.message === "string" ? payload.message : "stream error";
    throw new RalioAPIError(message, { statusCode: 200, detail: message });
  }
  return buildStreamEvent(eventName, payload);
}
