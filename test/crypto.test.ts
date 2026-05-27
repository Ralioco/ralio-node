import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from "jose";

import {
  b64url,
  generateKeypair,
  jwkThumbprint,
  loadPrivateKey,
  privateKeyToPem,
  signClientAssertion,
  signDpopProof,
} from "../src/crypto";
import { writeKeyFile } from "./helpers";

describe("crypto", () => {
  it("generateKeypair returns a canonical JWK", async () => {
    const { publicJwk } = await generateKeypair();
    expect(Object.keys(publicJwk)).toEqual(["crv", "kty", "x", "y"]);
    expect(publicJwk.crv).toBe("P-256");
    expect(publicJwk.kty).toBe("EC");
    expect(publicJwk.x).not.toContain("=");
    expect(publicJwk.y).not.toContain("=");
  });

  it("thumbprint is stable regardless of member order and is unpadded", async () => {
    const { publicJwk } = await generateKeypair();
    const reordered = { y: publicJwk.y, x: publicJwk.x, kty: publicJwk.kty, crv: publicJwk.crv };
    const t1 = await jwkThumbprint(publicJwk);
    const t2 = await jwkThumbprint(reordered as typeof publicJwk);
    expect(t1).toBe(t2);
    expect(t1).not.toContain("=");
  });

  it("save and load roundtrip preserves the public key and uses mode 0600", async () => {
    const path = await writeKeyFile();
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);

    const original = await loadPrivateKey(await readFile(path, "utf8"));
    const reloaded = await loadPrivateKey(await privateKeyToPem(original.privateKey));
    expect(reloaded.publicJwk).toEqual(original.publicJwk);
    expect(reloaded.kid).toBe(original.kid);
  });

  it("client assertion carries the expected claims", async () => {
    const { privateKey, kid } = await generateKeypair();
    const token = await signClientAssertion(privateKey, {
      clientId: "cb_x",
      audience: "https://api.ralio.co/oauth/token",
      kid,
    });
    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe(kid);

    const claims = decodeJwt(token);
    expect(claims.iss).toBe("cb_x");
    expect(claims.sub).toBe("cb_x");
    expect(claims.aud).toBe("https://api.ralio.co/oauth/token");
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(300);
  });

  it("DPoP proof binds the token and request", async () => {
    const { privateKey, publicJwk } = await generateKeypair();
    const accessToken = "access-token-value";
    const proof = await signDpopProof(privateKey, {
      method: "get",
      url: "https://api.ralio.co/api/transactions",
      accessToken,
      jwk: publicJwk,
    });
    const header = decodeProtectedHeader(proof);
    expect(header.typ).toBe("dpop+jwt");
    expect(header.jwk).toEqual(publicJwk);

    const claims = decodeJwt(proof);
    expect(claims.htm).toBe("GET");
    expect(claims.htu).toBe("https://api.ralio.co/api/transactions");
    const expectedAth = b64url(createHash("sha256").update(accessToken, "ascii").digest());
    expect(claims.ath).toBe(expectedAth);
  });

  it("DPoP proof signature verifies against the embedded key", async () => {
    const { privateKey, publicJwk } = await generateKeypair();
    const proof = await signDpopProof(privateKey, {
      method: "GET",
      url: "https://api.ralio.co/x",
      accessToken: "t",
      jwk: publicJwk,
    });
    const key = await importJWK(publicJwk, "ES256");
    await expect(jwtVerify(proof, key)).resolves.toBeDefined();
  });

  it("loadPrivateKey rejects a non-EC key", async () => {
    await expect(loadPrivateKey("not a key")).rejects.toThrow(/P-256/);
  });
});
