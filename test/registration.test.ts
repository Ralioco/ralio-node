import { access, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { register } from "../src/registration";
import { RalioRegistrationError } from "../src/errors";
import { BASE_URL, installFetch, jsonResponse, tempKeyPath } from "./helpers";

const REG = `${BASE_URL}/api/credential-bindings/registrations`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("register", () => {
  it("completes the happy path and writes the key", async () => {
    const mock = installFetch();
    mock.on(`POST ${REG}`, () => jsonResponse(202, { poll_token: "pt_1" }));
    mock.on(
      `GET ${REG}/pt_1`,
      () => jsonResponse(200, { status: "pending_approval" }),
      () => jsonResponse(200, { status: "active", client_id: "cb_new" }),
    );

    const keyPath = await tempKeyPath();
    const binding = await register({
      ticket: "ralio-reg-x",
      privateKeyPath: keyPath,
      baseUrl: BASE_URL,
      requestedScopes: ["agents:execute"],
      pollIntervalMs: 0,
    });

    expect(binding.clientId).toBe("cb_new");
    expect(binding.scopes).toEqual(["agents:execute"]);
    await expect(access(keyPath)).resolves.toBeUndefined();

    const submitted = mock.calls.find((c) => c.method === "POST" && c.url === REG)!;
    expect(submitted.body).toContain("public_key_jwk");
  });

  it("rejects when the binding is rejected", async () => {
    const mock = installFetch();
    mock.on(`POST ${REG}`, () => jsonResponse(202, { poll_token: "pt_1" }));
    mock.on(`GET ${REG}/pt_1`, () => jsonResponse(200, { status: "rejected" }));

    await expect(
      register({
        ticket: "t",
        privateKeyPath: await tempKeyPath(),
        baseUrl: BASE_URL,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(/rejected/);
  });

  it("aborts on a fingerprint mismatch", async () => {
    const mock = installFetch();
    mock.on(`POST ${REG}`, () =>
      jsonResponse(202, { fingerprint: "tampered", poll_token: "pt_1" }),
    );

    await expect(
      register({
        ticket: "t",
        privateKeyPath: await tempKeyPath(),
        baseUrl: BASE_URL,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(/fingerprint mismatch/);
  });

  it("refuses to overwrite an existing key", async () => {
    const keyPath = await tempKeyPath();
    await writeFile(keyPath, "existing");
    installFetch();

    await expect(
      register({ ticket: "t", privateKeyPath: keyPath, baseUrl: BASE_URL }),
    ).rejects.toBeInstanceOf(RalioRegistrationError);
  });
});
