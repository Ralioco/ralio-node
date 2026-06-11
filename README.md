# Ralio TypeScript SDK

[![npm version](https://img.shields.io/npm/v/@ralioco/sdk.svg)](https://www.npmjs.com/package/@ralioco/sdk)
[![CI](https://github.com/Ralioco/ralio-node/actions/workflows/ci.yml/badge.svg)](https://github.com/Ralioco/ralio-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The official TypeScript client for the [Ralio](https://ralio.co) agentic payment API.

It handles the machine-authentication path end to end — OAuth 2.1
`client_credentials` with `private_key_jwt` and DPoP-bound access tokens — so
your integration can talk to an agent without hand-rolling JWT signing, proof
generation, or token refresh.

> **Scope.** This SDK targets autonomous integrations (CI jobs, agent hosts,
> server-side callers). It authenticates as a **credential binding**, which can
> hold the `agents:execute` and `transactions:read` scopes. Agent and binding
> management (`agents:config`) is a human-only operation in the console and is
> intentionally not part of this SDK.

## Installation

```bash
npm install @ralioco/sdk
```

Requires Node.js 20.19+, 22.13+, or 24+ (matches our toolchain's
`engines.node` floor). The SDK is ESM-first and ships CommonJS too; types are
bundled.

## Authentication model

Ralio's machine path has no shared secrets. Each credential is a P-256 private
key that lives on exactly one host:

1. The **owner** mints a one-time registration ticket in the console
   (**Settings → Credentials → New credential**), choosing the target agent and
   a scope ceiling. They send you the `ralio-reg-…` ticket.
2. You call `register(...)` on the agent host. It generates a keypair locally,
   submits the public key, and waits until the owner approves the binding in the
   console. You get back a `clientId` (`cb_…`).
3. From then on, `RalioClient` mints and refreshes DPoP-bound access tokens
   transparently and signs a fresh proof for every request.

See the [API authentication guide](https://docs.ralio.co/api-reference/authentication)
for the protocol details.

## Register once

Run this on the host where the integration will live, after the owner sends you
a ticket:

```ts
import { register } from "@ralioco/sdk";

const binding = await register({
  ticket: "ralio-reg-...",
  privateKeyPath: "ralio-key.pem", // generated and written here
  requestedScopes: ["agents:execute", "transactions:read"],
});

console.log(binding.clientId); // cb_... — store this alongside the key
```

`register()` resolves once the owner approves (or rejects with a
`RalioRegistrationError` if the binding is rejected / expires / times out). The
private key never leaves the host.

## Use the client

```ts
import { RalioClient } from "@ralioco/sdk";

const client = await RalioClient.create({
  clientId: "cb_...",
  privateKeyPath: "ralio-key.pem",
});

// One-shot chat — agentId is resolved automatically for a single-agent
// credential; pass agentId explicitly to target one of several agents.
const reply = await client.chat.send({
  message: "What is my current balance?",
});
console.log(reply.reply);

// Streaming chat (server-sent events)
for await (const event of client.chat.stream({
  message: "List my recent payments",
})) {
  if (event.event === "text_delta") {
    process.stdout.write(event.text);
  } else if (event.event === "tool_started") {
    console.log(`\n[tool] ${event.data.tool_name}`);
  }
}

// Transactions — list endpoints are paginated.
const page = await client.transactions.list({ perPage: 20 });
console.log(`showing ${page.data.length} of ${page.total} transactions`);
for (const txn of page.data) {
  console.log(txn.date, txn.amount, txn.currency, txn.creditor, txn.status);
}

// Payment intents — what the agent proposed, with per-leg execution detail.
const intents = await client.paymentIntents.list({ perPage: 20 });
for (const intent of intents.data) {
  console.log(intent.createdAt, intent.totalAmount, intent.currency, intent.approvalStatus);
}
```

`RalioClient` also implements `Symbol.dispose`, so under `using` it is released
automatically:

```ts
using client = await RalioClient.create({ clientId: "cb_...", privateKeyPath: "ralio-key.pem" });
```

## Payments

There is no `payments.create()` method by design. Payments are executed by the
**agent**, not by direct REST calls: drive the agent with `chat.send` /
`chat.stream` ("Pay £500 to Bob for the April invoice") and it will create the
payment, subject to its spend limits and approval rules. Use
`transactions.list` (executed payments) and `paymentIntents.list` (what the
agent proposed, with per-leg status) to read what the agent did.

## Errors

All errors subclass `RalioError`:

| Class                        | When                                                            |
| ---------------------------- | --------------------------------------------------------------- |
| `RalioAuthError` (401)       | Missing/invalid token, failed assertion, or rejected DPoP proof |
| `RalioPermissionError` (403) | Token lacks the required scope, or resource not owned           |
| `RalioNotFoundError` (404)   | Resource doesn't exist                                          |
| `RalioValidationError` (422) | Invalid field values or business-rule violation                 |
| `RalioRateLimitError` (429)  | Rate limited — back off and retry                               |
| `RalioAPIError`              | Any other HTTP error (carries `statusCode`, `detail`)           |
| `RalioRegistrationError`     | Registration rejected, expired, or timed out                    |
| `RalioConfigError`           | Local configuration problem                                     |

```ts
import { RalioPermissionError } from "@ralioco/sdk";

try {
  await client.chat.send({ agentId: "...", message: "..." });
} catch (err) {
  if (err instanceof RalioPermissionError) {
    console.error("scope problem:", err.detail);
  } else {
    throw err;
  }
}
```

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

## License

MIT — see [LICENSE](LICENSE).
