import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";

import { RalioClient } from "../src/client";
import { RalioConfigError, RalioPermissionError, RalioValidationError } from "../src/errors";
import {
  BASE_URL,
  installFetch,
  jsonResponse,
  sseResponse,
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
});

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

  it("transactions.list parses the page envelope and passes query params", async () => {
    const mock = installFetch();
    withToken(mock);
    mock.on(`GET ${BASE_URL}/api/transactions`, () =>
      jsonResponse(200, {
        transactions: [
          {
            id: "txn_1",
            amount: "500.00",
            currency: "GBP",
            status: "submitted",
            creditor: "Bob",
            date: "2026-04-04T10:05:00Z",
          },
        ],
        total: 42,
        page: 1,
        per_page: 10,
      }),
    );

    const client = await makeClient();
    const page = await client.transactions.list({ agentId: "a1", page: 1, perPage: 10 });

    expect(page.total).toBe(42);
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(10);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]!.id).toBe("txn_1");
    expect(page.data[0]!.amount).toBe("500.00");

    const call = mock.calls.find((c) => c.url.startsWith(`${BASE_URL}/api/transactions`))!;
    const params = new URL(call.url).searchParams;
    expect(params.get("page")).toBe("1");
    expect(params.get("per_page")).toBe("10");
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
    await expect(client.transactions.list({ perPage: -1 })).rejects.toBeInstanceOf(
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

  it("paymentIntents.list parses the envelope, per-leg instructions, and params", async () => {
    const mock = installFetch();
    withToken(mock);
    mock.on(`GET ${BASE_URL}/api/payment-intents`, () =>
      jsonResponse(200, {
        payment_intents: [
          {
            id: "pi_1",
            agent_id: "a1",
            agent_name: "Payments",
            approval_status: "approved_by_user",
            execution_status: "completed",
            total_amount: "75.00",
            currency: "GBP",
            instruction_count: 2,
            instructions: [
              {
                amount: "30.00",
                currency: "GBP",
                status: "completed",
                creditor_name: "Acme",
                transaction_id: "txn_1",
                transaction_status: "delivered",
              },
              {
                amount: "45.00",
                currency: "GBP",
                status: "failed",
                creditor_name: "Beta",
                execution_error: "insufficient funds",
              },
            ],
          },
        ],
        total: 3,
        page: 2,
        per_page: 1,
      }),
    );

    const client = await makeClient();
    const page = await client.paymentIntents.list({ agentId: "a1", page: 2, perPage: 1 });

    expect(page.total).toBe(3);
    expect(page.page).toBe(2);
    expect(page.perPage).toBe(1);
    expect(page.data).toHaveLength(1);
    const intent = page.data[0]!;
    expect(intent.id).toBe("pi_1");
    expect(intent.approvalStatus).toBe("approved_by_user");
    expect(intent.executionStatus).toBe("completed");
    expect(intent.totalAmount).toBe("75.00");
    expect(intent.instructionCount).toBe(2);
    expect(intent.instructions).toHaveLength(2);
    expect(intent.instructions[0]!.creditorName).toBe("Acme");
    expect(intent.instructions[0]!.transactionStatus).toBe("delivered");
    expect(intent.instructions[1]!.status).toBe("failed");
    expect(intent.instructions[1]!.executionError).toBe("insufficient funds");

    const call = mock.calls.find((c) => c.url.startsWith(`${BASE_URL}/api/payment-intents`))!;
    const params = new URL(call.url).searchParams;
    expect(params.get("page")).toBe("2");
    expect(params.get("per_page")).toBe("1");
    expect(params.get("agent_id")).toBe("a1");
  });
});
