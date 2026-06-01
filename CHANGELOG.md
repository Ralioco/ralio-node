# Changelog

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
