import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK } from "jose";

import { RalioClient } from "../src/client";
import {
  LocalFileCredentialStore,
  type CredentialStore,
  type PrivateJwk,
  type StoredCredentials,
} from "../src";
import { generateKeypair, privateKeyToPem } from "../src/crypto";
import { BASE_URL, installFetch, jsonResponse, writeKeyFile } from "./helpers";

class MemoryCredentialStore implements CredentialStore {
  readonly savedRefreshTokens: Array<string | null> = [];

  constructor(private credentials: StoredCredentials) {}

  async load(): Promise<StoredCredentials> {
    return { ...this.credentials };
  }

  async saveRefreshToken(refreshToken: string | null): Promise<void> {
    this.credentials = { ...this.credentials, refreshToken };
    this.savedRefreshTokens.push(refreshToken);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("credential stores", () => {
  it("loads the default local PEM credentials and keeps refresh tokens per store instance", async () => {
    const privateKeyPath = await writeKeyFile();
    const first = new LocalFileCredentialStore({
      clientId: "cb_local",
      privateKeyPath,
    });
    const second = new LocalFileCredentialStore({
      clientId: "cb_local",
      privateKeyPath,
    });

    await first.saveRefreshToken("rrt-first");

    const firstCredentials = await first.load();
    const secondCredentials = await second.load();

    expect(firstCredentials.clientId).toBe("cb_local");
    expect(firstCredentials.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(firstCredentials.refreshToken).toBe("rrt-first");
    expect(secondCredentials.refreshToken).toBeNull();
  });

  it("uses a custom credential store implementation", async () => {
    const store = new MemoryCredentialStore({
      clientId: "cb_custom",
      privateJwk: await newPrivateJwk(),
    });
    const mock = installFetch();
    mock.on(`POST ${BASE_URL}/oauth/token`, () =>
      jsonResponse(200, {
        access_token: "access-custom",
        expires_in: 1800,
        refresh_token: "rrt-custom",
      }),
    );
    mock.on(`GET ${BASE_URL}/api/agents`, () => jsonResponse(200, []));

    const client = await RalioClient.create({ credentialStore: store, baseUrl: BASE_URL });
    const agents = await client.agents.list();

    expect(agents).toEqual([]);
    expect(store.savedRefreshTokens).toEqual(["rrt-custom"]);
  });

  it("writes a rotated refresh token back through the store", async () => {
    const store = new MemoryCredentialStore({
      clientId: "cb_refresh",
      privateKeyPem: await newPrivateKeyPem(),
      refreshToken: "rrt-old",
    });
    const mock = installFetch();
    mock.on(`POST ${BASE_URL}/oauth/token`, () =>
      jsonResponse(200, {
        access_token: "access-refresh",
        expires_in: 1800,
        refresh_token: "rrt-new",
      }),
    );
    mock.on(`GET ${BASE_URL}/api/agents`, () => jsonResponse(200, []));

    const client = await RalioClient.create({ credentialStore: store, baseUrl: BASE_URL });
    await client.agents.list();

    const tokenCall = mock.calls.find((call) => call.url === `${BASE_URL}/oauth/token`)!;
    const tokenBody = new URLSearchParams(tokenCall.body ?? "");
    expect(tokenBody.get("grant_type")).toBe("refresh_token");
    expect(tokenBody.get("refresh_token")).toBe("rrt-old");
    expect(store.savedRefreshTokens).toEqual(["rrt-new"]);
  });

  it("lets clients share client_id and private key while using separate refresh tokens", async () => {
    const privateKeyPem = await newPrivateKeyPem();
    const firstStore = new MemoryCredentialStore({
      clientId: "cb_shared",
      privateKeyPem,
      refreshToken: "rrt-first",
    });
    const secondStore = new MemoryCredentialStore({
      clientId: "cb_shared",
      privateKeyPem,
      refreshToken: "rrt-second",
    });
    const mock = installFetch();
    mock.on(
      `POST ${BASE_URL}/oauth/token`,
      () =>
        jsonResponse(200, {
          access_token: "access-first",
          expires_in: 1800,
          refresh_token: "rrt-first-next",
        }),
      () =>
        jsonResponse(200, {
          access_token: "access-second",
          expires_in: 1800,
          refresh_token: "rrt-second-next",
        }),
    );
    mock.on(`GET ${BASE_URL}/api/agents`, () => jsonResponse(200, []));

    const firstClient = await RalioClient.create({
      credentialStore: firstStore,
      baseUrl: BASE_URL,
    });
    const secondClient = await RalioClient.create({
      credentialStore: secondStore,
      baseUrl: BASE_URL,
    });
    await firstClient.agents.list();
    await secondClient.agents.list();

    const tokenBodies = mock.calls
      .filter((call) => call.url === `${BASE_URL}/oauth/token`)
      .map((call) => new URLSearchParams(call.body ?? ""));
    expect(tokenBodies.map((body) => body.get("client_id"))).toEqual(["cb_shared", "cb_shared"]);
    expect(tokenBodies.map((body) => body.get("refresh_token"))).toEqual([
      "rrt-first",
      "rrt-second",
    ]);
    expect(firstStore.savedRefreshTokens).toEqual(["rrt-first-next"]);
    expect(secondStore.savedRefreshTokens).toEqual(["rrt-second-next"]);
  });
});

async function newPrivateKeyPem(): Promise<string> {
  const { privateKey } = await generateKeypair();
  return privateKeyToPem(privateKey);
}

async function newPrivateJwk(): Promise<PrivateJwk> {
  const { privateKey } = await generateKeypair();
  return (await exportJWK(privateKey)) as PrivateJwk;
}
