/**
 * End-to-end example: register once, then chat and read transactions.
 *
 * Run the registration step on the host where the agent will live, after the
 * owner mints a ticket in the console (Settings -> Credentials -> New credential).
 *
 *   tsx examples/quickstart.ts
 */

import { RalioClient, register } from "../src/index.js";

const KEY_PATH = "ralio-key.pem";
const AGENT_ID = process.env.RALIO_AGENT_ID!;

/** Run this once. Resolves when the owner approves in the console. */
async function registerOnce(): Promise<string> {
  const binding = await register({
    ticket: process.env.RALIO_TICKET!,
    privateKeyPath: KEY_PATH,
    requestedScopes: ["agents:execute", "transactions:read"],
  });
  console.log("clientId:", binding.clientId); // persist this
  return binding.clientId;
}

async function main(): Promise<void> {
  const client = await RalioClient.create({
    clientId: process.env.RALIO_CLIENT_ID!,
    privateKeyPath: KEY_PATH,
  });

  const reply = await client.chat.send({
    agentId: AGENT_ID,
    message: "What is my current balance?",
  });
  console.log("reply:", reply.reply);

  console.log("--- streaming ---");
  for await (const event of client.chat.stream({
    agentId: AGENT_ID,
    message: "List my recent payments",
  })) {
    if (event.event === "text_delta") {
      process.stdout.write(event.text);
    } else if (event.event === "tool_started") {
      console.log(`\n[tool] ${event.data.tool_name}`);
    }
  }
  console.log();

  const txns = await client.transactions.list({ limit: 10 });
  for (const txn of txns) {
    console.log(`${txn.date}  ${txn.amount} ${txn.currency}  -> ${txn.creditor}  (${txn.status})`);
  }
}

// Uncomment to run registration instead of the main flow:
// registerOnce().catch((err) => { console.error(err); process.exit(1); });

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

void registerOnce;
