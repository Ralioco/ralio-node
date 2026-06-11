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

/** Mock a registration that activates synchronously on submit. */
function activatedRegistration(mock: FetchMock, clientId = "cb_new"): void {
  mock.on(`POST ${REG}`, () => jsonResponse(201, { client_id: clientId }));
  mock.on(`POST ${TOKEN_URL}`, () => jsonResponse(200, tokenResponse));
}

describe("register", () => {
  it("activates in one call, mints a token, and persists credentials", async () => {
    const mock = installFetch();
    activatedRegistration(mock);

    const keyPath = await tempKeyPath();
    const binding = await register({
      ticket: "ralio-reg-x",
      privateKeyPath: keyPath,
      baseUrl: BASE_URL,
      requestedScopes: ["agents:execute"],
    });

    expect(binding.clientId).toBe("cb_new");
    expect(binding.keyPath).toBe(keyPath);
    // Scopes echo the token grant, not the request.
    expect(binding.scopes).toEqual(["agents:execute", "transactions:read"]);
    await expect(access(keyPath)).resolves.toBeUndefined();

    // One POST to the registration endpoint, no polling.
    const regCalls = mock.calls.filter((c) => c.url.startsWith(REG));
    expect(regCalls).toHaveLength(1);
    expect(regCalls[0]!.method).toBe("POST");
    expect(regCalls[0]!.body).toContain("public_key_jwk");

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
    activatedRegistration(mock);

    const binding = await register({ baseUrl: BASE_URL });

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

  it("surfaces a consumed ticket's description and context, and removes the key", async () => {
    const mock = installFetch();
    mock.on(`POST ${REG}`, () =>
      jsonResponse(409, {
        detail: {
          error: "ticket_already_consumed",
          error_description:
            "This ticket was already used. If that wasn't you, ask the owner " +
            "to revoke the resulting credential in the console.",
          used_at: "2026-06-10T09:00:00Z",
          used_by_host: "ci-runner-7",
        },
      }),
    );

    const keyPath = await tempKeyPath();
    const err = await register({
      ticket: "t",
      privateKeyPath: keyPath,
      baseUrl: BASE_URL,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RalioRegistrationError);
    expect((err as Error).message).toMatch(/already used/);
    expect((err as Error).message).toMatch(/revoke/);
    expect((err as Error).message).toContain("used at 2026-06-10T09:00:00Z");
    expect((err as Error).message).toContain("by ci-runner-7");
    await expect(access(keyPath)).rejects.toThrow();
    expect(await loadCredentials()).toBeNull();
  });

  it("maps ticket errors without a description to their error code", async () => {
    const mock = installFetch();
    mock.on(`POST ${REG}`, () => jsonResponse(410, { detail: { error: "ticket_expired" } }));

    await expect(register({ ticket: "t", baseUrl: BASE_URL })).rejects.toThrow(/ticket_expired/);
  });

  it("maps 422 validation errors into RalioRegistrationError", async () => {
    const mock = installFetch();
    mock.on(`POST ${REG}`, () =>
      jsonResponse(422, {
        detail: {
          error: "scope_exceeds_ticket_ceiling",
          error_description: "requested scope exceeds the ticket's ceiling",
        },
      }),
    );

    const err = await register({ ticket: "t", baseUrl: BASE_URL }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RalioRegistrationError);
    expect((err as Error).message).toMatch(/exceeds the ticket's ceiling/);
  });

  it("aborts on a fingerprint mismatch, naming the live binding to revoke", async () => {
    const mock = installFetch();
    mock.on(`POST ${REG}`, () =>
      jsonResponse(201, { fingerprint: "tampered", client_id: "cb_live" }),
    );

    const keyPath = await tempKeyPath();
    const err = await register({
      ticket: "t",
      privateKeyPath: keyPath,
      baseUrl: BASE_URL,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RalioRegistrationError);
    expect((err as Error).message).toMatch(/fingerprint mismatch/);
    expect((err as Error).message).toContain("cb_live");
    expect((err as Error).message).toMatch(/revoke/);
    await expect(access(keyPath)).rejects.toThrow();
    expect(await loadCredentials()).toBeNull();
  });

  it("fails on a pre-cutover server (no client_id), keeping the key", async () => {
    const mock = installFetch();
    mock.on(`POST ${REG}`, () => jsonResponse(202, { poll_token: "pt_1" }));

    const keyPath = await tempKeyPath();
    const err = await register({
      ticket: "t",
      privateKeyPath: keyPath,
      baseUrl: BASE_URL,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RalioRegistrationError);
    expect((err as Error).message).toMatch(/owner approval/);
    expect((err as Error).message).toMatch(/upgrade the server/);
    await expect(access(keyPath)).resolves.toBeUndefined();
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
