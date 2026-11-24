// Node HTTP lane (src/http/, src/remote/): every T2 refusal, against a real
// listener on 127.0.0.1. Upstream calls go to the loopback mock API only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { startHttpServer, UnsafeSettingsError } from '../dist/http/server.js';
import { loadRemoteSettings } from '../dist/remote/settings.js';
import { CLIENT_ID, CLIENT_SECRET, startMockApi } from './harness.mjs';
import { GOOD_TOKEN, INITIALIZE, OTHER_TOKEN, makeKeys, mcpHeaders, rpc, toolText } from './remote-harness.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TENANT = '00000000-0000-4000-8000-000000000001';
const CLIENT = '00000000-0000-4000-8000-000000000002';
const PUBLIC_URL = 'https://mcp.test.invalid';

async function serve(remoteEnv, { configEnv = {}, keyFactory } = {}) {
  const settings = loadRemoteSettings({ MCP_HTTP_PORT: '0', ...remoteEnv }, 'node');
  const server = await startHttpServer({ config: loadConfig(configEnv), settings, keyFactory });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    base,
    close: server.close,
    post: (body, headers = {}, path = '/mcp') => fetch(base + path, { method: 'POST', headers: mcpHeaders(headers), body }),
  };
}

const bearerEnv = { MCP_HTTP_AUTH: 'bearer', MCP_BEARER_TOKEN: `${GOOD_TOKEN},${OTHER_TOKEN}`, MCP_ALLOWED_ORIGINS: 'https://app.test.invalid' };

// ------------------------------------------------------------------ startup refusals

test('settings: a bearer token under 32 characters is fatal', () => {
  const s = loadRemoteSettings({ MCP_HTTP_AUTH: 'bearer', MCP_BEARER_TOKEN: 'short-token-31-characters-long!' }, 'node');
  assert.equal(s.auth.mode, 'unconfigured');
  assert.match(s.fatal.join(' '), /at least 32 characters/);
});

test('settings: auth=none off loopback is fatal, on loopback it is allowed', () => {
  const off = loadRemoteSettings({ MCP_HTTP_AUTH: 'none', MCP_HTTP_HOST: '0.0.0.0' }, 'node');
  assert.match(off.fatal.join(' '), /Refusing to listen on 0\.0\.0\.0/);
  const on = loadRemoteSettings({ MCP_HTTP_AUTH: 'none' }, 'node');
  assert.deepEqual(on.fatal, []);
  assert.equal(on.host, '127.0.0.1');
});

test('settings: no MCP_HTTP_AUTH, an unknown mode, or half-configured Entra and Access are fatal', () => {
  assert.match(loadRemoteSettings({}, 'node').fatal.join(' '), /MCP_HTTP_AUTH is not set/);
  assert.match(loadRemoteSettings({ MCP_HTTP_AUTH: 'basic' }, 'node').fatal.join(' '), /"basic"/);
  const entra = loadRemoteSettings({ MCP_HTTP_AUTH: 'entra', MCP_ENTRA_TENANT_ID: TENANT, MCP_ENTRA_CLIENT_ID: CLIENT }, 'node');
  assert.match(entra.fatal.join(' '), /MCP_PUBLIC_URL/);
  const access = loadRemoteSettings({ MCP_HTTP_AUTH: 'access', MCP_ACCESS_TEAM_DOMAIN: 'evil.example.com', MCP_ACCESS_AUD: 'a'.repeat(64) }, 'node');
  assert.match(access.fatal.join(' '), /cloudflareaccess\.com/);
  assert.match(loadRemoteSettings({ MCP_HTTP_AUTH: 'entra', MCP_PUBLIC_URL: 'http://mcp.example.com', MCP_ENTRA_TENANT_ID: TENANT, MCP_ENTRA_CLIENT_ID: CLIENT }, 'node').fatal.join(' '), /must be https/);
});

test('startHttpServer refuses unsafe settings without listening', async () => {
  const settings = loadRemoteSettings({ MCP_HTTP_AUTH: 'none', MCP_HTTP_HOST: '0.0.0.0' }, 'node');
  await assert.rejects(startHttpServer({ config: loadConfig({}), settings }), UnsafeSettingsError);
});

test('the http entry point exits non-zero on each unsafe setting, naming it', () => {
  const cases = [
    [{ MCP_HTTP_AUTH: 'bearer', MCP_BEARER_TOKEN: 'too-short' }, /at least 32 characters/],
    [{ MCP_HTTP_AUTH: 'none', MCP_HTTP_HOST: '0.0.0.0' }, /Refusing to listen on 0\.0\.0\.0/],
    [{ MCP_HTTP_HOST: '0.0.0.0' }, /MCP_HTTP_AUTH is not set/],
  ];
  for (const [env, pattern] of cases) {
    const run = spawnSync(process.execPath, [join(ROOT, 'dist/http/main.js')], {
      env: { PATH: process.env.PATH, MCP_HTTP_PORT: '0', ...env },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(run.status, 1, `expected exit 1 for ${JSON.stringify(env)}`);
    assert.match(run.stderr, pattern);
    assert.equal(run.stdout, '');
    // The rejected token is never echoed.
    if (env.MCP_BEARER_TOKEN) assert.equal(run.stderr.includes(env.MCP_BEARER_TOKEN), false);
  }
});

// ------------------------------------------------------------------ bearer listener

test('bearer: health is open, /mcp needs the token, and only POST is served', async () => {
  const s = await serve(bearerEnv);
  try {
    const health = await fetch(`${s.base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');

    const none = await s.post(rpc('tools/list'));
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate') ?? '', /^Bearer realm=/);

    const wrong = await s.post(rpc('tools/list'), { authorization: `Bearer ${'x'.repeat(48)}` });
    assert.equal(wrong.status, 401);
    assert.match(wrong.headers.get('www-authenticate') ?? '', /error="invalid_token"/);

    for (const token of [GOOD_TOKEN, OTHER_TOKEN]) {
      const ok = await s.post(rpc('tools/list'), { authorization: `Bearer ${token}` });
      assert.equal(ok.status, 200);
      assert.ok((await ok.json()).result.tools.length > 0);
    }

    for (const method of ['GET', 'DELETE', 'PUT']) {
      const res = await fetch(`${s.base}/mcp`, { method, headers: { authorization: `Bearer ${GOOD_TOKEN}` } });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('allow'), 'POST, OPTIONS');
    }
  } finally {
    await s.close();
  }
});

test('bearer: a token in the query string or the path is never accepted', async () => {
  const s = await serve(bearerEnv);
  try {
    const query = await s.post(rpc('tools/list'), {}, `/mcp?access_token=${GOOD_TOKEN}`);
    assert.equal(query.status, 400);
    // Even alongside a valid header, URL parameters are refused.
    const both = await s.post(rpc('tools/list'), { authorization: `Bearer ${GOOD_TOKEN}` }, `/mcp?token=${GOOD_TOKEN}`);
    assert.equal(both.status, 400);
    const path = await s.post(rpc('tools/list'), {}, `/mcp/${GOOD_TOKEN}`);
    assert.equal(path.status, 404);
  } finally {
    await s.close();
  }
});

test('bearer: an Origin not on the allow list is refused with 403; an allowed one gets CORS', async () => {
  const s = await serve(bearerEnv);
  try {
    const bad = await s.post(rpc('tools/list'), { authorization: `Bearer ${GOOD_TOKEN}`, origin: 'https://evil.test.invalid' });
    assert.equal(bad.status, 403);
    const good = await s.post(rpc('tools/list'), { authorization: `Bearer ${GOOD_TOKEN}`, origin: 'https://app.test.invalid' });
    assert.equal(good.status, 200);
    assert.equal(good.headers.get('access-control-allow-origin'), 'https://app.test.invalid');
    const preflight = await fetch(`${s.base}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://evil.test.invalid' } });
    assert.equal(preflight.status, 403);
  } finally {
    await s.close();
  }
});

test('loopback listener refuses a non-loopback Host header (DNS rebinding guard)', async () => {
  const s = await serve(bearerEnv);
  try {
    const { port } = new URL(s.base);
    const status = (host) =>
      new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/healthz', headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.end();
      });
    assert.equal(await status('attacker.test.invalid'), 403);
    assert.equal(await status(`localhost:${port}`), 200);
    assert.equal(await status(`[::1]:${port}`), 200);
  } finally {
    await s.close();
  }
});

test('each request gets its own server: initialize twice, gates from the deployment, transport reported', async () => {
  const s = await serve(bearerEnv);
  const auth = { authorization: `Bearer ${GOOD_TOKEN}` };
  try {
    for (let i = 0; i < 2; i++) {
      const res = await s.post(INITIALIZE(), auth);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).result.serverInfo.name, 'ninja-one-mcp');
      assert.equal(res.headers.get('mcp-session-id'), null);
    }
    const parallel = await Promise.all(
      Array.from({ length: 6 }, () => s.post(rpc('tools/call', { name: 'ninjaone_status_server', arguments: {} }), auth).then((r) => r.json())),
    );
    for (const body of parallel) {
      const status = JSON.parse(toolText(body));
      assert.equal(status.transport, 'http');
      assert.equal(status.mode, 'read');
    }
    // Gates come from the deployment, not the caller: a write refuses in read mode.
    const write = await (await s.post(rpc('tools/call', { name: 'ninjaone_reset_alert', arguments: { alert_uid: 'a1', confirm: true } }), auth)).json();
    assert.equal(write.result.isError, true);
    assert.match(toolText(write), /NINJAONE_MODE=write/);
    assert.match(toolText(write), /Next step:/);
  } finally {
    await s.close();
  }
});

test('the inbound token never reaches the upstream API', async () => {
  const api = await startMockApi();
  const s = await serve(bearerEnv, { configEnv: { NINJAONE_CLIENT_ID: CLIENT_ID, NINJAONE_CLIENT_SECRET: CLIENT_SECRET, NINJAONE_BASE_URL: api.url } });
  try {
    const res = await s.post(rpc('tools/call', { name: 'ninjaone_test_connection', arguments: {} }), { authorization: `Bearer ${GOOD_TOKEN}`, cookie: 'session=abc' });
    const body = await res.json();
    assert.equal(JSON.parse(toolText(body)).ok, true);
    assert.ok(api.requests.length > 0);
    for (const r of api.requests) {
      // The OAuth token request carries the client credentials in its body; API calls carry NinjaOne's own token.
      if (r.path === '/ws/oauth/token') assert.equal(r.auth, undefined);
      else assert.match(r.auth ?? '', /^Bearer mock-access-token-/);
      assert.equal(JSON.stringify(r).includes(GOOD_TOKEN), false);
    }
    assert.equal(JSON.stringify(body).includes(GOOD_TOKEN), false);
  } finally {
    await s.close();
    await api.close();
  }
});

// ------------------------------------------------------------------ Entra resource server

test('entra: metadata, challenge, and every token failure mode', async () => {
  const keys = await makeKeys();
  const s = await serve(
    { MCP_HTTP_AUTH: 'entra', MCP_ENTRA_TENANT_ID: TENANT, MCP_ENTRA_CLIENT_ID: CLIENT, MCP_PUBLIC_URL: PUBLIC_URL },
    { keyFactory: keys.keyFactory },
  );
  const issuer = `https://login.microsoftonline.com/${TENANT}/v2.0`;
  const good = { iss: issuer, aud: CLIENT, tid: TENANT, scp: 'mcp.access', oid: 'user-1' };
  const call = async (claims, opts) => s.post(rpc('tools/list'), { authorization: `Bearer ${await keys.sign(claims, opts)}` });
  try {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const prm = await (await fetch(s.base + path)).json();
      assert.equal(prm.resource, `${PUBLIC_URL}/mcp`);
      assert.deepEqual(prm.authorization_servers, [issuer]);
      assert.deepEqual(prm.scopes_supported, [`api://${CLIENT}/mcp.access`]);
    }

    const none = await s.post(rpc('tools/list'));
    assert.equal(none.status, 401);
    const challenge = none.headers.get('www-authenticate') ?? '';
    assert.match(challenge, new RegExp(`resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`));
    assert.match(challenge, /scope="api:\/\/[^"]+\/mcp\.access"/);

    const wrongAud = await call({ ...good, aud: '00000000-0000-4000-8000-0000000000ff' });
    assert.equal(wrongAud.status, 401);
    assert.match(wrongAud.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
    assert.match((await wrongAud.json()).error.message, /audience/);

    assert.equal((await call({ ...good, iss: 'https://login.microsoftonline.com/other/v2.0' })).status, 401);
    assert.equal((await call({ ...good, tid: '00000000-0000-4000-8000-0000000000ee' })).status, 401);
    assert.equal((await call(good, { rogue: true })).status, 401);
    assert.equal((await call(good, { expiresIn: '-10m' })).status, 401);

    const noScope = await call({ ...good, scp: 'other.scope' });
    assert.equal(noScope.status, 403);
    assert.match(noScope.headers.get('www-authenticate') ?? '', /error="insufficient_scope"/);

    const appOnly = await call({ iss: issuer, aud: CLIENT, tid: TENANT, roles: ['Some.Role'], azp: 'app-1' });
    assert.equal(appOnly.status, 403);

    const ok = await call(good);
    assert.equal(ok.status, 200);
    const appIdUriAud = await call({ ...good, aud: `api://${CLIENT}` });
    assert.equal(appIdUriAud.status, 200);
  } finally {
    await s.close();
  }
});
