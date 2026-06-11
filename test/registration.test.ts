import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";

import { register } from "../src/registration";
import { RalioConfigError, RalioRegistrationError } from "../src/errors";
import { keyPathFor, loadCredentials } from "../src/store";
import {
  BASE_URL,
  installFetch,
  jsonResponse,
  stubConfigDir,
  tempKeyPath,
  tokenResponse,
  type FetchMock,
} from "./helpers";

const REG = `${BASE_URL}/api/credential-bindings/registrations`;
const TOKEN_URL = `${BASE_URL}/oauth/token`;

let configDir: string;

beforeEach(async () => {
  configDir = await stubConfigDir();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Mock a registration that the owner approves after one pending poll. */
function approvedRegistration(mock: FetchMock, clientId = "cb_new"): void {
  mock.on(`POST ${REG}`, () => jsonResponse(202, { poll_token: "pt_1" }));
  mock.on(
    `GET ${REG}/pt_1`,
    () => jsonResponse(200, { status: "pending_approval" }),
    () => jsonResponse(200, { status: "active", client_id: clientId }),
  );
  mock.on(`POST ${TOKEN_URL}`, () => jsonResponse(200, tokenResponse));
}

describe("register", () => {
  it("completes the happy path, mints a token, and persists credentials", async () => {
    const mock = installFetch();
    approvedRegistration(mock);

    const keyPath = await tempKeyPath();
    const binding = await register({
      ticket: "ralio-reg-x",
      privateKeyPath: keyPath,
      baseUrl: BASE_URL,
      requestedScopes: ["agents:execute"],
      pollIntervalMs: 0,
    });

    expect(binding.clientId).toBe("cb_new");
    expect(binding.keyPath).toBe(keyPath);
    // Scopes echo the token grant, not the request.
    expect(binding.scopes).toEqual(["agents:execute", "transactions:read"]);
    await expect(access(keyPath)).resolves.toBeUndefined();

    const submitted = mock.calls.find((c) => c.method === "POST" && c.url === REG)!;
    expect(submitted.body).toContain("public_key_jwk");

    // First mint: client_credentials with a private_key_jwt assertion.
    const mint = mock.calls.find((c) => c.url === TOKEN_URL)!;
    const form = new URLSearchParams(mint.body!);
    expect(form.get("grant_type")).toBe("client_credentials");
    const assertion = decodeJwt(form.get("client_assertion")!);
    expect(assertion.iss).toBe("cb_new");
    expect(assertion.sub).toBe("cb_new");
    expect(assertion.aud).toBe(TOKEN_URL);

    // Persisted credentials are the CLI-compatible shape.
    const stored = (await loadCredentials())!;
    expect(stored.client_id).toBe("cb_new");
    expect(stored.access_token).toBe("access-1");
    expect(stored.refresh_token).toBe("rrt-1");
    expect(stored.auth_method).toBe("private_key_jwt");
    expect(stored.key_path).toBe(keyPath);
    expect(stored.key_jkt).toBeTruthy();
  });

  it("falls back to RALIO_REGISTRATION_TICKET and the default key path", async () => {
    vi.stubEnv("RALIO_REGISTRATION_TICKET", "ralio-reg-env");
    const mock = installFetch();
    approvedRegistration(mock);

    const binding = await register({ baseUrl: BASE_URL, pollIntervalMs: 0 });

    expect(binding.clientId).toBe("cb_new");
    expect(binding.keyPath).toBe(keyPathFor((await loadCredentials())!.key_jkt!));
    expect(binding.keyPath.startsWith(join(configDir, "keys"))).toBe(true);
    await expect(access(binding.keyPath)).resolves.toBeUndefined();

    const submitted = mock.calls.find((c) => c.method === "POST" && c.url === REG)!;
    expect(JSON.parse(submitted.body!).ticket).toBe("ralio-reg-env");
  });

  it("throws a config error when no ticket is given and the env var is unset", async () => {
    installFetch();
    const err = await register({ baseUrl: BASE_URL }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RalioConfigError);
    expect((err as Error).message).toMatch(/RALIO_REGISTRATION_TICKET/);
  });

  it("rejects when the binding is rejected, and removes the key", async () => {
    const mock = installFetch();
    mock.on(`POST ${REG}`, () => jsonResponse(202, { poll_token: "pt_1" }));
    mock.on(`GET ${REG}/pt_1`, () => jsonResponse(200, { status: "rejected" }));

    const keyPath = await tempKeyPath();
    await expect(
      register({ ticket: "t", privateKeyPath: keyPath, baseUrl: BASE_URL, pollIntervalMs: 0 }),
    ).rejects.toThrow(/rejected/);
    await expect(access(keyPath)).rejects.toThrow();
    expect(await loadCredentials()).toBeNull();
  });

  it("treats a 404 poll as expiry", async () => {
    const mock = installFetch();
    mock.on(`POST ${REG}`, () => jsonResponse(202, { poll_token: "pt_1" }));
    mock.on(`GET ${REG}/pt_1`, () => jsonResponse(404, { detail: "gone" }));

    await expect(register({ ticket: "t", baseUrl: BASE_URL, pollIntervalMs: 0 })).rejects.toThrow(
      /expired/,
    );
  });

  it("times out while pending, keeping the key for a late approval", async () => {
    const mock = installFetch();
    mock.on(`POST ${REG}`, () => jsonResponse(202, { poll_token: "pt_1" }));
    mock.on(`GET ${REG}/pt_1`, () => jsonResponse(200, { status: "pending_approval" }));

    const keyPath = await tempKeyPath();
    const err = await register({
      ticket: "t",
      privateKeyPath: keyPath,
      baseUrl: BASE_URL,
      pollIntervalMs: 0,
      timeoutMs: 0,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RalioRegistrationError);
    expect((err as Error).message).toMatch(/timed out/);
    await expect(access(keyPath)).resolves.toBeUndefined();
  });

  it("aborts on a fingerprint mismatch and removes the key", async () => {
    const mock = installFetch();
    mock.on(`POST ${REG}`, () =>
      jsonResponse(202, { fingerprint: "tampered", poll_token: "pt_1" }),
    );

    const keyPath = await tempKeyPath();
    await expect(
      register({ ticket: "t", privateKeyPath: keyPath, baseUrl: BASE_URL, pollIntervalMs: 0 }),
    ).rejects.toThrow(/fingerprint mismatch/);
    await expect(access(keyPath)).rejects.toThrow();
  });

  it("refuses to overwrite an existing key", async () => {
    const keyPath = await tempKeyPath();
    await writeFile(keyPath, "existing");
    installFetch();

    await expect(
      register({ ticket: "t", privateKeyPath: keyPath, baseUrl: BASE_URL }),
    ).rejects.toBeInstanceOf(RalioRegistrationError);
    // The pre-existing file is untouched.
    expect(await readFile(keyPath, "utf8")).toBe("existing");
  });
});
