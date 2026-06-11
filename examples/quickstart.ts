/**
 * End-to-end example: register once, then chat and read transactions.
 *
 * Run the registration step on the host where the agent will live, after the
 * owner mints a ticket in the console (Settings -> Credentials -> New credential)
 * and you export it as RALIO_REGISTRATION_TICKET:
 *
 *   RALIO_REGISTRATION_TICKET=ralio-reg-... tsx examples/quickstart.ts register
 *   tsx examples/quickstart.ts
 */

import { RalioClient, register } from "../src/index.js";

/**
 * Run this once. The binding is active as soon as the call returns (the
 * owner consented by minting the ticket and gets an email receipt with a
 * revoke link); the credentials are persisted to ~/.ralio/ so the client
 * needs no arguments.
 */
async function registerOnce(): Promise<void> {
  const binding = await register(); // ticket from RALIO_REGISTRATION_TICKET
  console.log("registered:", binding.clientId, "key at", binding.keyPath);
}

async function main(): Promise<void> {
  const client = new RalioClient(); // zero-config: reads persisted credentials

  const reply = await client.chat.send({
    message: "What is my current balance?",
  });
  console.log("reply:", reply.reply);

  console.log("--- streaming ---");
  for await (const event of client.chat.stream({
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

const entry = process.argv[2] === "register" ? registerOnce : main;
entry().catch((err) => {
  console.error(err);
  process.exit(1);
});
