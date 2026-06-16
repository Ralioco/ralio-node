# Ralio TypeScript SDK

[![npm version](https://img.shields.io/npm/v/@ralioco/sdk.svg)](https://www.npmjs.com/package/@ralioco/sdk)
[![CI](https://github.com/Ralioco/ralio-node/actions/workflows/ci.yml/badge.svg)](https://github.com/Ralioco/ralio-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The official TypeScript client for the [Ralio](https://ralio.co) agentic payment API.

It handles the machine-authentication path end to end — OAuth 2.1
`client_credentials` with `private_key_jwt` and DPoP-bound access tokens — so
your integration can talk to an agent without hand-rolling JWT signing, proof
generation, or token refresh.

> **Scope.** This SDK targets autonomous integrations such as agent hosts,
> backend services, and other server-side automation. It authenticates as a
> **credential binding**, which can hold the `agents:execute` and
> `transactions:read` scopes. Agent and binding
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

Ralio's machine path has no shared client secret. Each credential is a P-256
private key controlled by your integration:

1. The **owner** mints a one-time registration ticket in the console
   (**Settings → Credentials → New credential**), choosing the target agent and
   a scope ceiling. That is where consent happens. They send you the
   `ralio-reg-…` ticket.
2. You call `register()` once on the agent host. It generates a keypair
   locally and submits the public key with the ticket; the binding is active
   as soon as the server responds — no approval step, no polling. The owner
   gets an email receipt with a revoke link. The credentials are persisted to
   `~/.ralio/` — the same store the `ralio` CLI uses, so `register()` and
   `ralio auth agent` are interchangeable.
3. From then on, `RalioClient` mints and refreshes DPoP-bound access tokens
   transparently and signs a fresh proof for every request.

See the [API authentication guide](https://docs.ralio.co/api-reference/authentication)
for the protocol details.

## Quickstart

With the owner's ticket in `RALIO_REGISTRATION_TICKET`, onboarding is two
calls:

```ts
import { register, RalioClient } from "@ralioco/sdk";

await register(); // run once; the binding is active when this returns

const client = new RalioClient(); // zero-config: reads the persisted credentials
const reply = await client.chat.send({ message: "What is my current balance?" });
```

`register()` activates the binding in a single call (or rejects with a
`RalioRegistrationError` if the ticket is invalid, expired, or already
consumed). The private key is generated locally, written to
`~/.ralio/keys/<jkt>.pem`, and never leaves the host.

Everything is overridable when you want to manage credentials yourself:

```ts
import { register } from "@ralioco/sdk";

const binding = await register({
  ticket: "ralio-reg-...", // instead of RALIO_REGISTRATION_TICKET
  privateKeyPath: "ralio-key.pem", // generated and written here
  requestedScopes: ["agents:execute", "transactions:read"],
});

console.log(binding.clientId); // cb_... — store this alongside the key
```

## Use the client

```ts
import { RalioClient } from "@ralioco/sdk";

// Zero-config: reads the credentials persisted by register() / `ralio auth agent`.
const client = new RalioClient();

// Or manage credentials yourself:
// const client = await RalioClient.create({
//   clientId: "cb_...",
//   privateKeyPath: "ralio-key.pem",
// });

// One-shot chat — uses the agent attached to the active credential.
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
using client = new RalioClient();
```

Credentials load lazily on the first request; use `await RalioClient.create()`
instead of `new RalioClient()` to load them eagerly and fail fast.

The active credential determines which agent receives chat requests. To use a
different agent, authenticate or register a new credential for that agent.

## Credential stores and clustered clients

The default setup reads credentials persisted by `register()` or
`ralio auth agent`. You can also pass the local PEM file directly with
`clientId` + `privateKeyPath`, or provide a custom `CredentialStore`.

For clustered agents, run activation once, then let every instance use the same
stable `client_id` and private key. Each running instance should keep its own
refresh token family. Sharing one mutable refresh token across concurrent
instances can create rotation races: one instance rotates the token, another
later presents the old token, and the server treats that as reuse for that
family.

Provide a shared source for the stable identity material, and key refresh-token
storage by instance:

```ts
import { RalioClient, type CredentialStore } from "@ralioco/sdk";

const instanceId = process.env.RALIO_INSTANCE_ID ?? process.env.HOSTNAME ?? "worker-1";

const store: CredentialStore = {
  async load() {
    return {
      clientId: await secrets.get("ralio/client_id"),
      privateKeyPem: await secrets.get("ralio/private_key_pem"),
      refreshToken: await state.get(`ralio/refresh/${instanceId}`),
    };
  },
  async saveRefreshToken(refreshToken) {
    await state.set(`ralio/refresh/${instanceId}`, refreshToken);
  },
};

const client = await RalioClient.create({ credentialStore: store });
```

If you want local-file refresh-token persistence, pass a distinct
`refreshTokenPath` for each running instance. With zero-config identity material:

```ts
const client = await RalioClient.create({
  refreshTokenPath: `/var/lib/ralio/${process.env.HOSTNAME}.refresh-token`,
});
```

Or with an explicit local PEM key:

```ts
const client = await RalioClient.create({
  clientId: "cb_...",
  privateKeyPath: "ralio-key.pem",
  refreshTokenPath: `/var/lib/ralio/${process.env.HOSTNAME}.refresh-token`,
});
```

Credential-wide revocation in the Ralio console still revokes all token families
for the shared `client_id`.

## Environment variables

| Variable                    | Meaning                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `RALIO_REGISTRATION_TICKET` | Default ticket for `register()` — same variable the CLI reads       |
| `RALIO_API_URL`             | API origin (default `https://api.ralio.co`)                         |
| `RALIO_CONFIG_DIR`          | Credential store location (default `~/.ralio`, shared with the CLI) |

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
| `RalioRegistrationError`     | Registration failed (invalid / expired / consumed ticket)       |
| `RalioConfigError`           | Local configuration problem                                     |

```ts
import { RalioPermissionError } from "@ralioco/sdk";

try {
  await client.chat.send({ message: "..." });
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
