# Changelog

## 0.1.2 (2026-06-01)

- `chat.send` / `chat.stream`: `agentId` is now **optional**. When omitted, the
  SDK resolves the single agent your credential is bound to (via
  `agents.list()`) and caches it — so the common single-agent case needs no
  agent ID at all. Pass `agentId` explicitly to address a specific agent or
  when the credential can reach more than one.
- Add `client.agents.list()` and the `Agent` type — list the agents the
  credential can address (for a binding, the one it is pinned to).

## 0.1.1 (2026-06-01)

- Docs: clarify that `register()` resolves to the credential handle
  (`clientId`) only — not an agent ID — and that the `agentId` passed to
  `chat.send` comes from the console (the agent the ticket was pinned to),
  taken from the caller's own configuration.

## 0.1.0 (2026-05-29)

Initial release.

- OAuth 2.1 `client_credentials` + `private_key_jwt` + DPoP authentication.
- One-time credential-binding registration (`register`).
- `client.chat.send` and `client.chat.stream` (SSE).
- `client.transactions.list`.
