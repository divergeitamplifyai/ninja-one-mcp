// Front-door policy for the Cloudflare Worker. Runs under Node against dist/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configProblem, containerEnv, frontDoor } from '../dist/policy.js';

const TOKEN = 'x'.repeat(48);
const bearer = { NINJAONE_HTTP_AUTH: 'bearer', NINJAONE_HTTP_BEARER_TOKENS: TOKEN, NINJAONE_REGION: 'us' };
const entra = { NINJAONE_HTTP_AUTH: 'entra', NINJAONE_HTTP_ENTRA_TENANT_ID: '00000000-0000-0000-0000-000000000001', NINJAONE_HTTP_ENTRA_CLIENT_ID: 'client' };

test('only NINJAONE_* strings reach the container, and the listener settings cannot be overridden', () => {
  const env = containerEnv({
    ...bearer,
    NINJAONE_MCP: {},
    CONTAINER_INSTANCES: '2',
    OTHER_SECRET: 'nope',
    NINJAONE_ALLOWED_ORG_IDS: '',
    NINJAONE_TRANSPORT: 'stdio',
    NINJAONE_HTTP_HOST: '127.0.0.1',
    NINJAONE_HTTP_PORT: '1',
    NINJAONE_ENV_FILE: '/tmp/x',
  });
  assert.deepEqual(Object.keys(env).sort(), ['NINJAONE_HTTP_AUTH', 'NINJAONE_HTTP_BEARER_TOKENS', 'NINJAONE_REGION']);
});

test('the Worker refuses to start a container without inbound auth', () => {
  assert.match(configProblem({}), /entra or bearer/);
  assert.match(configProblem({ NINJAONE_HTTP_AUTH: 'none' }), /entra or bearer/);
  assert.match(configProblem({ NINJAONE_HTTP_AUTH: 'bearer' }), /NINJAONE_HTTP_BEARER_TOKENS/);
  assert.match(configProblem({ NINJAONE_HTTP_AUTH: 'entra', NINJAONE_HTTP_ENTRA_CLIENT_ID: 'c' }), /TENANT_ID/);
  assert.equal(configProblem(bearer), undefined);
  assert.equal(configProblem(entra), undefined);
});

test('every problem message ends with a next step', () => {
  for (const env of [{}, { NINJAONE_HTTP_AUTH: 'bearer' }, { NINJAONE_HTTP_AUTH: 'entra' }]) {
    assert.match(configProblem(env), /Next step: /);
  }
});

test('unknown paths are refused without waking a container', async () => {
  for (const path of ['/', '/admin', '/mcp/../etc', '/.env', '/healthz/x']) {
    const d = frontDoor(new Request(`https://mcp.example.com${path}`), bearer);
    assert.ok('response' in d, path);
    assert.equal(d.response.status, 404, path);
  }
});

test('a misconfigured deployment answers 500 with the fix, before any container starts', async () => {
  const d = frontDoor(new Request('https://mcp.example.com/mcp', { method: 'POST', body: '{}' }), { NINJAONE_HTTP_AUTH: 'none' });
  assert.ok('response' in d);
  assert.equal(d.response.status, 500);
  const body = await d.response.json();
  assert.match(body.error.message, /Next step: /);
});

test('oversized bodies are refused at the edge', () => {
  const d = frontDoor(new Request('https://mcp.example.com/mcp', { method: 'POST', headers: { 'content-length': String(2 * 1024 * 1024) }, body: 'x' }), bearer);
  assert.ok('response' in d);
  assert.equal(d.response.status, 413);
});

test('caller X-Forwarded-* headers are replaced with the Worker view; auth headers pass through', () => {
  const d = frontDoor(
    new Request('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', 'x-forwarded-for': '10.0.0.1' },
      body: '{}',
    }),
    bearer,
  );
  assert.ok('request' in d);
  assert.equal(d.request.headers.get('x-forwarded-host'), 'mcp.example.com');
  assert.equal(d.request.headers.get('x-forwarded-proto'), 'https');
  assert.equal(d.request.headers.get('x-forwarded-for'), null);
  assert.equal(d.request.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(d.instance, 'ninjaone-0');
});

test('metadata and health paths are forwarded, with or without a trailing slash', () => {
  for (const path of ['/healthz', '/mcp/', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    assert.ok('request' in frontDoor(new Request(`https://mcp.example.com${path}`), entra), path);
  }
});

test('requests spread over the configured instances and stay in range', () => {
  const env = { ...bearer, CONTAINER_INSTANCES: '3' };
  const seen = new Set([0, 0.34, 0.67, 0.999].map((r) => frontDoor(new Request('https://m.example/mcp'), env, () => r).instance));
  assert.deepEqual([...seen].sort(), ['ninjaone-0', 'ninjaone-1', 'ninjaone-2']);
  const bad = frontDoor(new Request('https://m.example/mcp'), { ...bearer, CONTAINER_INSTANCES: '500' }, () => 0.9);
  assert.equal(bad.instance, 'ninjaone-0');
});
