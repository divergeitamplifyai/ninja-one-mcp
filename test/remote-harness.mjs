// Helpers for the remote-lane tests: local signing keys (no JWKS fetch), token
// minting, and JSON-RPC request bodies. Nothing here touches the network.

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';

export const ACCEPT = 'application/json, text/event-stream';
export const GOOD_TOKEN = 'test-bearer-token-not-a-secret-0123456789abcdef';
export const OTHER_TOKEN = 'other-bearer-token-not-a-secret-9876543210fedcba';

/** A key set the tests sign with, and a keyFactory that serves only it. */
export async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const set = createLocalJWKSet({ keys: [jwk] });
  const rogue = await generateKeyPair('RS256');
  return {
    keyFactory: () => set,
    /** Sign claims with the trusted key, or with an untrusted one when rogue is true. */
    async sign(claims, { rogue: useRogue = false, expiresIn = '5m' } = {}) {
      const jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuedAt();
      if (expiresIn !== null) jwt.setExpirationTime(expiresIn);
      return jwt.sign(useRogue ? rogue.privateKey : privateKey);
    },
  };
}

let nextId = 1;
export function rpc(method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params });
}

export const INITIALIZE = () =>
  rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });

export function mcpHeaders(extra = {}) {
  return { accept: ACCEPT, 'content-type': 'application/json', ...extra };
}

/** The text of a tools/call result inside a JSON-RPC response body. */
export function toolText(body) {
  return (body.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}
