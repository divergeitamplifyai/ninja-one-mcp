// Workers lane (src/worker/): the built Worker module run under Node with
// web-standard Request and Response. No workerd, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../dist/worker/index.js';
import { GOOD_TOKEN, INITIALIZE, makeKeys, mcpHeaders, rpc, toolText } from './remote-harness.mjs';

const BASE = 'https://ninja-one-mcp.test.invalid';
const TEAM = 'https://testteam.cloudflareaccess.com';
const AUD = 'a1b2c3d4'.repeat(8);

function harness(env, options = {}) {
  const worker = createWorker(options);
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  return {
    fetch: (path, init = {}) => worker.fetch(new Request(BASE + path, init), env, ctx),
    post: (body, headers = {}, path = '/mcp') => worker.fetch(new Request(BASE + path, { method: 'POST', headers: mcpHeaders(headers), body }), env, ctx),
    settle: () => Promise.allSettled(pending),
  };
}

test('unconfigured Worker answers 503 on /mcp and stays healthy', async () => {
  for (const env of [{}, { MCP_HTTP_AUTH: 'none' }, { MCP_HTTP_AUTH: 'entra' }, { MCP_HTTP_AUTH: 'bearer' }, { MCP_HTTP_AUTH: 'bearer', MCP_BEARER_TOKEN: 'short' }, { MCP_HTTP_AUTH: 'access', MCP_ACCESS_TEAM_DOMAIN: 'testteam' }]) {
    const w = harness(env);
    const res = await w.post(rpc('tools/list'), { authorization: `Bearer ${GOOD_TOKEN}` });
    assert.equal(res.status, 503, JSON.stringify(env));
    assert.equal((await w.fetch('/healthz')).status, 200);
  }
});

test('bearer Worker: 401 without or with a wrong token, 200 with the right one', async () => {
  const w = harness({ MCP_HTTP_AUTH: 'bearer', MCP_BEARER_TOKEN: GOOD_TOKEN, MCP_ALLOWED_ORIGINS: 'https://app.test.invalid' });
  assert.equal((await w.post(rpc('tools/list'))).status, 401);
  assert.equal((await w.post(rpc('tools/list'), { authorization: `Bearer ${'y'.repeat(48)}` })).status, 401);
  const ok = await w.post(rpc('tools/list'), { authorization: `Bearer ${GOOD_TOKEN}` });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).result.tools.some((t) => t.name === 'ninjaone_status_server'));
  await w.settle();
});

test('bearer Worker: bad Origin 403, GET and DELETE 405, URL parameters 400', async () => {
  const w = harness({ MCP_HTTP_AUTH: 'bearer', MCP_BEARER_TOKEN: GOOD_TOKEN, MCP_ALLOWED_ORIGINS: 'https://app.test.invalid' });
  const auth = { authorization: `Bearer ${GOOD_TOKEN}` };
  assert.equal((await w.post(rpc('tools/list'), { ...auth, origin: 'https://evil.test.invalid' })).status, 403);
  const allowed = await w.post(rpc('tools/list'), { ...auth, origin: 'https://app.test.invalid' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.test.invalid');
  assert.equal((await w.fetch('/mcp', { method: 'GET', headers: auth })).status, 405);
  assert.equal((await w.fetch('/mcp', { method: 'DELETE', headers: auth })).status, 405);
  assert.equal((await w.post(rpc('tools/list'), {}, `/mcp?token=${GOOD_TOKEN}`)).status, 400);
  await w.settle();
});

test('access Worker: team domain and AUD pinned, assertion header only', async () => {
  const keys = await makeKeys();
  const w = harness({ MCP_HTTP_AUTH: 'access', MCP_ACCESS_TEAM_DOMAIN: 'testteam.cloudflareaccess.com', MCP_ACCESS_AUD: AUD }, { keyFactory: keys.keyFactory });
  const good = { iss: TEAM, aud: [AUD], email: 'person@test.invalid', sub: 'user-1' };
  const withJwt = async (claims, opts) => w.post(rpc('tools/list'), { 'cf-access-jwt-assertion': await keys.sign(claims, opts) });

  assert.equal((await w.post(rpc('tools/list'))).status, 401);
  // A JWT in Authorization is not the Access assertion.
  assert.equal((await w.post(rpc('tools/list'), { authorization: `Bearer ${await keys.sign(good)}` })).status, 401);
  assert.equal((await withJwt({ ...good, aud: ['f'.repeat(64)] })).status, 401);
  assert.equal((await withJwt({ ...good, iss: 'https://otherteam.cloudflareaccess.com' })).status, 401);
  assert.equal((await withJwt(good, { rogue: true })).status, 401);
  assert.equal((await withJwt(good, { expiresIn: '-10m' })).status, 401);
  assert.equal((await withJwt(good)).status, 200);
  // Service tokens carry common_name instead of email.
  assert.equal((await withJwt({ iss: TEAM, aud: [AUD], common_name: 'svc.access', sub: '' })).status, 200);
  await w.settle();
});

test('Worker gates come from vars (read by default) and every request gets a fresh server', async () => {
  const w = harness({ MCP_HTTP_AUTH: 'bearer', MCP_BEARER_TOKEN: GOOD_TOKEN, NINJAONE_MODE: 'read', NINJAONE_ALLOW_DESTRUCTIVE: 'false' });
  const auth = { authorization: `Bearer ${GOOD_TOKEN}` };
  for (let i = 0; i < 2; i++) assert.equal((await w.post(INITIALIZE(), auth)).status, 200);

  const status = JSON.parse(toolText(await (await w.post(rpc('tools/call', { name: 'ninjaone_status_server', arguments: {} }), auth)).json()));
  assert.equal(status.transport, 'worker');
  assert.equal(status.mode, 'read');
  assert.deepEqual(status.missing_env_vars, ['NINJAONE_CLIENT_ID', 'NINJAONE_CLIENT_SECRET', 'NINJAONE_REGION']);
  assert.match(status.next_step, /wrangler secret put/);

  const write = await (await w.post(rpc('tools/call', { name: 'ninjaone_reset_alert', arguments: { alert_uid: 'a1', confirm: true } }), auth)).json();
  assert.equal(write.result.isError, true);
  assert.match(toolText(write), /NINJAONE_MODE=write/);
  assert.match(toolText(write), /Next step:/);
  await w.settle();
});

// Ported from the earlier Containers front door (deploy/cloudflare/test/policy.test.mjs):
// stray paths and oversized bodies are refused before any auth or server work.
test('Worker refuses unknown paths with 404 and bodies over 1 MB with 413', async () => {
  const w = harness({ MCP_HTTP_AUTH: 'bearer', MCP_BEARER_TOKEN: GOOD_TOKEN });
  for (const path of ['/', '/admin', '/mcp/extra', '/.env']) assert.equal((await w.fetch(path)).status, 404, path);
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1_100_000) } });
  assert.equal((await w.post(big, { authorization: `Bearer ${GOOD_TOKEN}` })).status, 413);
  await w.settle();
});

test('Worker reads the docs resource without a file system', async () => {
  const w = harness({ MCP_HTTP_AUTH: 'bearer', MCP_BEARER_TOKEN: GOOD_TOKEN });
  const res = await (await w.post(rpc('resources/read', { uri: 'ninjaone://docs/llms.txt' }), { authorization: `Bearer ${GOOD_TOKEN}` })).json();
  assert.match(res.result.contents[0].text, /NinjaOne/);
  assert.doesNotMatch(res.result.contents[0].text, /not bundled/);
  await w.settle();
});
