/**
 * ES256 / DPoP crypto primitives for the Ralio machine-auth path.
 *
 * Everything here mirrors what the Ralio API expects byte-for-byte:
 *
 * - P-256 (ES256) is the only curve the token endpoint accepts.
 * - The public JWK is the canonical RFC 7638 form (`crv`/`kty`/`x`/`y` only),
 *   so the thumbprint computed here matches the `cnf.jkt` the server stamps on
 *   the access token and the fingerprint the owner confirms.
 * - Client assertions follow RFC 7521/7523; DPoP proofs follow RFC 9449.
 */

import { createHash, randomBytes, type KeyObject } from "node:crypto";
import {
  SignJWT,
  exportPKCS8,
  exportJWK,
  importPKCS8,
  generateKeyPair as joseGenerateKeyPair,
  calculateJwkThumbprint,
} from "jose";

export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

// The server rejects assertions older than 300s; stay well under to absorb skew.
const CLIENT_ASSERTION_TTL_SECONDS = 60;

/** Canonical RFC 7638 public JWK — exactly these members, in this order. */
export interface PublicJwk {
  crv: "P-256";
  kty: "EC";
  x: string;
  y: string;
}

/** A loaded credential: the private key plus its canonical public JWK and kid. */
export interface KeyMaterial {
  privateKey: KeyObject;
  publicJwk: PublicJwk;
  kid: string;
}

/** Unpadded base64url — the only form RFC 7515/7517/7638 accept. */
export function b64url(raw: Buffer | Uint8Array): string {
  return Buffer.from(raw).toString("base64url");
}

function canonicalize(jwk: { crv?: string; kty?: string; x?: string; y?: string }): PublicJwk {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("Ralio credentials require a P-256 (EC) key");
  }
  return { crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y };
}

/** RFC 7638 thumbprint of a public JWK — used as `kid` and key id. */
export async function jwkThumbprint(jwk: PublicJwk): Promise<string> {
  return calculateJwkThumbprint(jwk, "sha256");
}

/** Mint a P-256 keypair and return its key material. */
export async function generateKeypair(): Promise<KeyMaterial> {
  const { privateKey } = await joseGenerateKeyPair("ES256", { extractable: true });
  return fromPrivateKey(privateKey as KeyObject);
}

/** Derive the canonical public JWK + kid from an already-loaded private key. */
export async function fromPrivateKey(privateKey: KeyObject): Promise<KeyMaterial> {
  const publicJwk = canonicalize(await exportJWK(privateKey));
  const kid = await jwkThumbprint(publicJwk);
  return { privateKey, publicJwk, kid };
}

/** Serialize a private key to PKCS8 PEM. */
export async function privateKeyToPem(privateKey: KeyObject): Promise<string> {
  return exportPKCS8(privateKey);
}

/** Load a PKCS8 PEM P-256 private key, returning full key material. */
export async function loadPrivateKey(pem: string): Promise<KeyMaterial> {
  let key: KeyObject;
  try {
    key = (await importPKCS8(pem, "ES256", { extractable: true })) as KeyObject;
  } catch (err) {
    throw new Error(
      `Ralio credentials require a P-256 (EC) private key: ${(err as Error).message}`,
      { cause: err },
    );
  }
  return fromPrivateKey(key);
}

/**
 * Sign an RFC 7523 JWT bearer client assertion.
 *
 * `iss` and `sub` both equal `clientId`; `aud` is the absolute token endpoint
 * URL. `kid` is the JWK thumbprint so the server can locate the binding.
 */
export async function signClientAssertion(
  privateKey: KeyObject,
  opts: {
    clientId: string;
    audience: string;
    kid: string;
    ttlSeconds?: number;
  },
): Promise<string> {
  const ttl = opts.ttlSeconds ?? CLIENT_ASSERTION_TTL_SECONDS;
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: opts.kid })
    .setIssuer(opts.clientId)
    .setSubject(opts.clientId)
    .setAudience(opts.audience)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .setJti(b64url(randomBytes(16)))
    .sign(privateKey);
}

/**
 * Sign a single-use DPoP proof (RFC 9449) for one method + URL + token.
 *
 * `url` must already have its query and fragment stripped (`htu` per RFC 9449
 * §4.2). The embedded `jwk` must be the canonical public JWK so its thumbprint
 * matches the access token's `cnf.jkt`.
 */
export async function signDpopProof(
  privateKey: KeyObject,
  opts: {
    method: string;
    url: string;
    accessToken: string;
    jwk: PublicJwk;
  },
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const ath = createHash("sha256").update(opts.accessToken, "ascii").digest("base64url");
  return new SignJWT({
    htm: opts.method.toUpperCase(),
    htu: opts.url,
    ath,
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: { ...opts.jwk } })
    .setIssuedAt(iat)
    .setJti(b64url(randomBytes(16)))
    .sign(privateKey);
}
