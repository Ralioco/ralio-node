# Changelog

## Unreleased

- Zero-friction onboarding: `register()` now takes no required arguments and
  `new RalioClient()` works with no configuration at all.
  - `register()` defaults its ticket to the `RALIO_REGISTRATION_TICKET`
    environment variable and throws a `RalioConfigError` when neither is set.
  - On activation, `register()` mints the first access token and persists the
    credentials to the local Ralio credential store. The private key defaults
    to `~/.ralio/keys/<jkt>.pem`; `privateKeyPath` still overrides.
  - `RalioClient` gained a public synchronous constructor. With no arguments
    it reads the persisted credentials on first request and mints/refreshes
    tokens transparently — no copy-pasting `clientId`. `RalioClient.create()`
    remains for eager, fail-fast credential loading.
  - `CredentialBinding` gained `keyPath`; `binding.scopes` now reflects the
    granted token scope rather than echoing `requestedScopes`.
  - New env vars: `RALIO_API_URL` (API origin override) and `RALIO_CONFIG_DIR`
    (credential store location, default `~/.ralio`).
  - A key bound to nothing is removed when a registration fails.
- Synchronous activation (server PR #1182): the binding is active as soon as
  `POST /api/credential-bindings/registrations` returns — owner consent
  happens at ticket minting, and the owner receives an email receipt with a
  revoke link.
  - `register()` no longer polls for owner approval; the `pollIntervalMs`
    and `timeoutMs` options are gone, along with the pending / rejected /
    expired-approval states.
  - Ticket errors (`invalid_ticket`, `ticket_expired`,
    `ticket_already_consumed`, `public_key_already_in_use`,
    `invalid_public_key`, `invalid_scope`, `scope_exceeds_ticket_ceiling`)
    map into `RalioRegistrationError`, surfacing the server's
    `error_description` — a consumed ticket reports when and by which host
    it was spent, so the operator knows to have the owner revoke the
    resulting credential.
  - A fingerprint mismatch now names the live `client_id` to revoke in the
    console; a 2xx response without a `client_id` (pre-cutover server)
    fails with an "upgrade the server" message and keeps the private key.

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
