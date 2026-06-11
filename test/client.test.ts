import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";

import { RalioClient } from "../src/client";
import { generateKeypair, privateKeyToPem } from "../src/crypto";
import { RalioConfigError, RalioPermissionError, RalioValidationError } from "../src/errors";
import { register } from "../src/registration";
import { ensureKeysDir, keyPathFor, saveCredentials, savePrivateKey } from "../src/store";
import {
  BASE_URL,
  installFetch,
  jsonResponse,
  sseResponse,
  stubConfigDir,
  tokenResponse,
  writeKeyFile,
  type FetchMock,
} from "./helpers";

async function makeClient(): Promise<RalioClient> {
  const keyPath = await writeKeyFile();
  return RalioClient.create({ clientId: "cb_test", privateKeyPath: keyPath, baseUrl: BASE_URL });
}

function withToken(mock: FetchMock): void {
  mock.on(`POST ${BASE_URL}/oauth/token`, () => jsonResponse(200, tokenResponse));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Persist a binding to the (stubbed) store, as register() would. */
async function seedStore(clientId = "cb_stored"): Promise<void> {
  const { privateKey, kid } = await generateKeypair();
  await ensureKeysDir();
  await savePrivateKey(keyPathFor(kid), await privateKeyToPem(privateKey));
  await saveCredentials({ client_id: clientId, key_jkt: kid, auth_method: "private_key_jwt" });
}

describe("RalioClient", () => {
  it("chat.send carries DPoP auth headers and parses the reply", async () => {
    const mock = installFetch();
    withToken(mock);
    mock.on(`POST ${BASE_URL}/api/chat`, () =>
      jsonResponse(200, {
        reply: "Your balance is GBP 10,000.",
        conversation_id: "conv-1",
        new_messages: [
          { id: "m1", role: "user", content: "balance?", created_at: "t" },
          { id: "m2", role: "assistant", content: "10k", created_at: "t" },
        ],
      }),
    );

    const client = await makeClient();
    const reply = await client.chat.send({ agentId: "a1", message: "balance?" });

    expect(reply.reply).toMatch(/^Your balance/);
    expect(reply.conversationId).toBe("conv-1");
    expect(reply.newMessages).toHaveLength(2);
    expect(reply.newMessages[0]!.role).toBe("user");

    const chatCall = mock.calls.find((c) => c.url === `${BASE_URL}/api/chat`)!;
    expect(chatCall.headers.get("Authorization")).toBe("DPoP access-1");
    const proof = decodeJwt(chatCall.headers.get("DPoP")!);
    expect(proof.htm).toBe("POST");
    expect(proof.htu).toBe(`${BASE_URL}/api/chat`);
    expect(proof.jti).toBeDefined();
    expect(proof.ath).toBeDefined();
  });

  it("retries once on 401 with a fresh proof", async () => {
    const mock = installFetch();
    withToken(mock);
    mock.on(
      `POST ${BASE_URL}/api/chat`,
      () => jsonResponse(401, { detail: "expired" }),
      () => jsonResponse(200, { reply: "ok", conversation_id: "c" }),
    );

    const client = await makeClient();
    const reply = await client.chat.send({ agentId: "a1", message: "hi" });
    expect(reply.reply).toBe("ok");

    const chatCalls = mock.calls.filter((c) => c.url === `${BASE_URL}/api/chat`);
    expect(chatCalls).toHaveLength(2);
    const jti1 = decodeJwt(chatCalls[0]!.headers.get("DPoP")!).jti;
    const jti2 = decodeJwt(chatCalls[1]!.headers.get("DPoP")!).jti;
    expect(jti1).not.toBe(jti2);
  });

  it("transactions.list parses results and passes query params", async () => {
    const mock = installFetch();
    withToken(mock);
    mock.on(`GET ${BASE_URL}/api/transactions`, () =>
      jsonResponse(200, [
        {
          id: "txn_1",
          amount: "500.00",
          currency: "GBP",
          status: "submitted",
          creditor: "Bob",
          date: "2026-04-04T10:05:00Z",
        },
      ]),
    );

    const client = await makeClient();
    const txns = await client.transactions.list({ agentId: "a1", limit: 10 });

    expect(txns).toHaveLength(1);
    expect(txns[0]!.id).toBe("txn_1");
    expect(txns[0]!.amount).toBe("500.00");

    const call = mock.calls.find((c) => c.url.startsWith(`${BASE_URL}/api/transactions`))!;
    const params = new URL(call.url).searchParams;
    expect(params.get("limit")).toBe("10");
    expect(params.get("agent_id")).toBe("a1");
  });

  it("chat.stream parses server-sent events", async () => {
    const mock = installFetch();
    withToken(mock);
    const sse =
      "event: conversation\n" +
      'data: {"conversation_id": "conv-1"}\n' +
      "\n" +
      "event: text_delta\n" +
      'data: {"text": "Hello "}\n' +
      "\n" +
      "event: reply\n" +
      'data: {"text": "Hello world"}\n' +
      "\n";
    mock.on(`POST ${BASE_URL}/api/chat/stream`, () => sseResponse(sse));

    const client = await makeClient();
    const events = [];
    for await (const event of client.chat.stream({ agentId: "a1", message: "hi" })) {
      events.push(event);
    }

    expect(events.map((e) => e.event)).toEqual(["conversation", "text_delta", "reply"]);
    expect(events[1]!.text).toBe("Hello ");
    expect(events[2]!.text).toBe("Hello world");
  });

  it("maps a 403 to RalioPermissionError", async () => {
    const mock = installFetch();
    withToken(mock);
    mock.on(`POST ${BASE_URL}/api/chat`, () => jsonResponse(403, { detail: "insufficient_scope" }));

    const client = await makeClient();
    const err = await client.chat.send({ agentId: "a1", message: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(RalioPermissionError);
    expect(err.statusCode).toBe(403);
    expect(err.detail).toBe("insufficient_scope");
  });

  it("maps a 422 to RalioValidationError", async () => {
    const mock = installFetch();
    withToken(mock);
    mock.on(`GET ${BASE_URL}/api/transactions`, () => jsonResponse(422, { detail: "bad limit" }));

    const client = await makeClient();
    await expect(client.transactions.list({ limit: -1 })).rejects.toBeInstanceOf(
      RalioValidationError,
    );
  });

  it("agents.list parses the bound agent", async () => {
    const mock = installFetch();
    withToken(mock);
    mock.on(`GET ${BASE_URL}/api/agents`, () =>
      jsonResponse(200, [
        {
          id: "a1",
          name: "Payments",
          agent_number: 1,
          banking_provider: "griffin",
          created_at: "t",
        },
      ]),
    );

    const client = await makeClient();
    const agents = await client.agents.list();

    expect(agents).toHaveLength(1);
    expect(agents[0]!.id).toBe("a1");
    expect(agents[0]!.name).toBe("Payments");
    expect(agents[0]!.agentNumber).toBe(1);
    expect(agents[0]!.bankingProvider).toBe("griffin");
  });

  it("chat.send without agentId resolves the bound agent and sends it", async () => {
    const mock = installFetch();
    withToken(mock);
    mock.on(`GET ${BASE_URL}/api/agents`, () =>
      jsonResponse(200, [{ id: "bound-agent", name: "Only" }]),
    );
    mock.on(`POST ${BASE_URL}/api/chat`, () =>
      jsonResponse(200, { reply: "ok", conversation_id: "c1", new_messages: [] }),
    );

    const client = await makeClient();
    const reply = await client.chat.send({ message: "hi" });

    expect(reply.reply).toBe("ok");
    const chatCall = mock.calls.find((c) => c.url === `${BASE_URL}/api/chat`)!;
    expect(JSON.parse(chatCall.body!).agent_id).toBe("bound-agent");
  });

  it("chat.send caches the resolved agent across calls", async () => {
    const mock = installFetch();
    withToken(mock);
    mock.on(`GET ${BASE_URL}/api/agents`, () =>
      jsonResponse(200, [{ id: "bound-agent", name: "Only" }]),
    );
    mock.on(`POST ${BASE_URL}/api/chat`, () =>
      jsonResponse(200, { reply: "ok", conversation_id: "c1", new_messages: [] }),
    );

    const client = await makeClient();
    await client.chat.send({ message: "one" });
    await client.chat.send({ message: "two" });

    const listCalls = mock.calls.filter((c) => c.url === `${BASE_URL}/api/agents`);
    expect(listCalls).toHaveLength(1);
  });

  it("chat.send throws RalioConfigError when the credential reaches multiple agents", async () => {
    const mock = installFetch();
    withToken(mock);
    mock.on(`GET ${BASE_URL}/api/agents`, () =>
      jsonResponse(200, [
        { id: "a1", name: "One" },
        { id: "a2", name: "Two" },
      ]),
    );

    const client = await makeClient();
    await expect(client.chat.send({ message: "hi" })).rejects.toBeInstanceOf(RalioConfigError);
  });
});

describe("RalioClient zero-config", () => {
  it("new RalioClient() reads the persisted credentials and authenticates", async () => {
    await stubConfigDir();
    await seedStore("cb_stored");
    const mock = installFetch();
    withToken(mock);
    mock.on(`POST ${BASE_URL}/api/chat`, () =>
      jsonResponse(200, { reply: "ok", conversation_id: "c1", new_messages: [] }),
    );

    const client = new RalioClient();
    const reply = await client.chat.send({ agentId: "a1", message: "hi" });
    expect(reply.reply).toBe("ok");

    // The minted assertion is for the stored client_id.
    const mint = mock.calls.find((c) => c.url === `${BASE_URL}/oauth/token`)!;
    const assertion = decodeJwt(new URLSearchParams(mint.body!).get("client_assertion")!);
    expect(assertion.iss).toBe("cb_stored");
  });

  it("fails with RalioConfigError when nothing is persisted", async () => {
    await stubConfigDir();
    installFetch();

    await expect(RalioClient.create()).rejects.toBeInstanceOf(RalioConfigError);

    const client = new RalioClient();
    const err = await client.chat.send({ agentId: "a1", message: "hi" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RalioConfigError);
    expect((err as Error).message).toMatch(/register\(\)/);
  });

  it("rejects clientId without privateKeyPath (and vice versa)", async () => {
    await stubConfigDir();
    installFetch();
    await expect(RalioClient.create({ clientId: "cb_x" })).rejects.toBeInstanceOf(RalioConfigError);
    await expect(RalioClient.create({ privateKeyPath: "k.pem" })).rejects.toBeInstanceOf(
      RalioConfigError,
    );
  });

  it("register() with only the env ticket, then new RalioClient(), end to end", async () => {
    await stubConfigDir();
    vi.stubEnv("RALIO_REGISTRATION_TICKET", "ralio-reg-e2e");
    const mock = installFetch();
    withToken(mock);
    const REG = `${BASE_URL}/api/credential-bindings/registrations`;
    mock.on(`POST ${REG}`, () => jsonResponse(201, { client_id: "cb_e2e" }));
    mock.on(`POST ${BASE_URL}/api/chat`, () =>
      jsonResponse(200, { reply: "done", conversation_id: "c1", new_messages: [] }),
    );

    const binding = await register();
    expect(binding.clientId).toBe("cb_e2e");

    const client = new RalioClient();
    const reply = await client.chat.send({ agentId: "a1", message: "hi" });
    expect(reply.reply).toBe("done");
  });
});
