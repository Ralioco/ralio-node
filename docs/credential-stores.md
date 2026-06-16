# Credential Stores

The default setup reads credentials persisted by `register()`. You can also
pass the local PEM file directly with `clientId` + `privateKeyPath`, or provide
a custom `CredentialStore`.

## Clustered Clients

For clustered agents, run activation once, then let every instance use the same
stable `client_id` and private key. Each running instance should keep its own
refresh token family.

Sharing one mutable refresh token across concurrent instances can create
rotation races: one instance rotates the token, another later presents the old
token, and the server treats that as reuse for that family.

Credential-wide revocation in the Ralio console still revokes all token
families for the shared `client_id`.

## Custom Store

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

## Local Refresh-Token Files

If you want local-file refresh-token persistence, pass a distinct
`refreshTokenPath` for each running instance. With zero-config identity
material:

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
