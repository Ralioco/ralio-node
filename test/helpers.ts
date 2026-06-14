import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import { generateKeypair, privateKeyToPem } from "../src/crypto";

export const BASE_URL = "https://api.ralio.co";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

type ResponseMaker = () => Response;

export interface FetchMock {
  calls: RecordedCall[];
  on(key: string, ...makers: ResponseMaker[]): void;
}

/** Install a routing `fetch` mock keyed by `"<METHOD> <origin><pathname>"`. */
export function installFetch(): FetchMock {
  const calls: RecordedCall[] = [];
  const handlers = new Map<string, ResponseMaker[]>();

  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const u = new URL(url);
    const key = `${method} ${u.origin}${u.pathname}`;
    const body = init?.body == null ? null : String(init.body);
    calls.push({ url, method, headers: new Headers(init?.headers), body });

    const queue = handlers.get(key);
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected request: ${key}`);
    }
    const maker = queue.length === 1 ? queue[0]! : queue.shift()!;
    return maker();
  });

  vi.stubGlobal("fetch", fn);

  return {
    calls,
    on(key: string, ...makers: ResponseMaker[]) {
      handlers.set(key, makers);
    },
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function sseResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export const tokenResponse = {
  access_token: "access-1",
  token_type: "DPoP",
  expires_in: 1800,
  refresh_token: "rrt-1",
  scope: "agents:execute transactions:read",
};

/**
 * Point the credential store at a fresh temp directory (and neutralize any
 * ambient RALIO_* env config). Undone by `vi.unstubAllEnvs()`.
 */
export async function stubConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ralio-config-"));
  vi.stubEnv("RALIO_CONFIG_DIR", dir);
  vi.stubEnv("RALIO_API_URL", "");
  vi.stubEnv("RALIO_REGISTRATION_TICKET", "");
  return dir;
}

/** Write a fresh P-256 key to a temp file and return its path. */
export async function writeKeyFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ralio-test-"));
  const path = join(dir, "ralio-key.pem");
  const { privateKey } = await generateKeypair();
  await writeFile(path, await privateKeyToPem(privateKey), { mode: 0o600 });
  return path;
}

export async function tempKeyPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ralio-test-"));
  return join(dir, "k.pem");
}
