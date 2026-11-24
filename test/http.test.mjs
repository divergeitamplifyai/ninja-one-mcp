// The Streamable HTTP transport: auth, metadata, origin checks, health, and a
// real MCP round trip. The built server runs as a child process on loopback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_ID, CLIENT_SECRET, startMockApi } from './harness.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TOKEN = 'a-shared-bearer-token-that-is-long-enough-0123';
const TENANT = '00000000-0000-4000-8000-000000000001';
const APP = '00000000-0000-4000-8000-0000000000aa';

async function startHttp(env, expectExit = false) {
  const child = spawn(process.execPath, [join(ROOT, 'dist/index.js'), '--http'], {
    env: { PATH: process.env.PATH, NINJAONE_HTTP_PORT: '0', NINJAONE_ENV_FILE: 'none', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  if (expectExit) {
    const [code] = await once(child, 'exit');
    return { code, stderr };
  }
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listen line: ${stderr}`)), 10_000);
    child.stderr.on('data', () => {
      const m = /"event":"http_listening"[^\n]*"port":(\d+)/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', () => reject(new Error(`exited: ${stderr}`)));
  });
  return { url: `http://127.0.0.1:${port}`, stderr: () => stderr, close: () => child.kill() };
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

function post(url, body, headers = {}) {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

test('refuses to listen off loopback without inbound auth', async () => {
  const { code, stderr } = await startHttp({ NINJAONE_HTTP_HOST: '0.0.0.0' }, true);
  assert.equal(code, 2);
  assert.match(stderr, /Refusing to listen/);
});

test('refuses short shared tokens', async () => {
  const { code, stderr } = await startHttp({ NINJAONE_HTTP_AUTH: 'bearer', NINJAONE_HTTP_BEARER_TOKENS: 'short' }, true);
  assert.equal(code, 2);
  assert.match(stderr, /at least 32 characters/);
});

test('bearer mode: health is open, MCP needs the token, and a tool call works end to end', async () => {
  const api = await startMockApi();
  const s = await startHttp({
    NINJAONE_HTTP_AUTH: 'bearer',
    NINJAONE_HTTP_BEARER_TOKENS: TOKEN,
    NINJAONE_BASE_URL: api.url,
    NINJAONE_CLIENT_ID: CLIENT_ID,
    NINJAONE_CLIENT_SECRET: CLIENT_SECRET,
    NINJAONE_TOOLSETS: 'all',
  });
  try {
    const health = await fetch(`${s.url}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).credentials_configured, true);

    const anon = await post(s.url, initialize);
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('www-authenticate'), /^Bearer/);
    assert.equal((await post(s.url, initialize, { authorization: 'Bearer wrong-token-wrong-token-wrong-token-00' })).status, 401);

    const auth = { authorization: `Bearer ${TOKEN}` };
    const init = await post(s.url, initialize, auth);
    assert.equal(init.status, 200);
    assert.equal(init.headers.get('mcp-session-id'), null, 'stateless');
    assert.equal((await init.json()).result.serverInfo.name, 'ninja-one-mcp');

    const call = await post(s.url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ninjaone_list_organizations', arguments: {} } }, auth);
    const result = (await call.json()).result;
    assert.equal(result.structuredContent.count, 3);
    assert.ok(!JSON.stringify(api.requests).includes(TOKEN), 'the inbound token never reaches NinjaOne');

    assert.equal((await fetch(`${s.url}/mcp`, { headers: auth })).status, 405);
    assert.equal((await post(s.url, initialize, { ...auth, origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(`${s.url}/.well-known/oauth-protected-resource`)).status, 404);
    assert.ok(!s.stderr().includes(TOKEN), 'tokens are redacted from logs');
  } finally {
    s.close();
    await api.close();
  }
});

// ------------------------------------------------------------------ Entra

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

async function jwksServer() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const mint = (claims, kid = 'k1') => {
    const head = b64url({ alg: 'RS256', typ: 'JWT', kid });
    const now = Math.floor(Date.now() / 1000);
    const body = b64url({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT, aud: APP, iat: now, nbf: now, exp: now + 600, oid: 'user-1', scp: 'mcp.access', ...claims });
    return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  };
  return { url: `http://127.0.0.1:${server.address().port}/keys`, mint, close: () => server.close() };
}

test('entra mode: metadata, challenge, and token validation', async () => {
  const jwks = await jwksServer();
  const s = await startHttp({
    NINJAONE_HTTP_AUTH: 'entra',
    NINJAONE_HTTP_ENTRA_TENANT_ID: TENANT,
    NINJAONE_HTTP_ENTRA_CLIENT_ID: APP,
    NINJAONE_HTTP_ENTRA_JWKS_URL: jwks.url,
    NINJAONE_HTTP_PUBLIC_URL: 'https://mcp.example.com',
    NINJAONE_REGION: 'us',
  });
  try {
    const prm = await (await fetch(`${s.url}/.well-known/oauth-protected-resource`)).json();
    assert.equal(prm.resource, 'https://mcp.example.com/mcp');
    assert.deepEqual(prm.authorization_servers, [`https://login.microsoftonline.com/${TENANT}/v2.0`]);
    assert.deepEqual(prm.scopes_supported, [`api://${APP}/mcp.access`]);

    const anon = await post(s.url, initialize);
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('www-authenticate'), /resource_metadata="https:\/\/mcp\.example\.com\/\.well-known\/oauth-protected-resource"/);

    const ok = await post(s.url, initialize, { authorization: `Bearer ${jwks.mint({})}` });
    assert.equal(ok.status, 200);

    const cases = [
      [{ aud: 'someone-else' }, 401],
      [{ iss: 'https://login.microsoftonline.com/other/v2.0' }, 401],
      [{ exp: Math.floor(Date.now() / 1000) - 3600 }, 401],
      [{ scp: 'User.Read' }, 403],
      [{ scp: undefined, roles: ['Other'] }, 403],
    ];
    for (const [claims, status] of cases) {
      const r = await post(s.url, initialize, { authorization: `Bearer ${jwks.mint(claims)}` });
      assert.equal(r.status, status, JSON.stringify(claims));
    }
    const forged = jwks.mint({}).split('.');
    forged[1] = b64url({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: APP, exp: 9999999999, scp: 'mcp.access' });
    assert.equal((await post(s.url, initialize, { authorization: `Bearer ${forged.join('.')}` })).status, 401);
    assert.equal((await post(s.url, initialize, { authorization: `Bearer ${jwks.mint({}, 'unknown-kid')}` })).status, 401);
  } finally {
    s.close();
    jwks.close();
  }
});
