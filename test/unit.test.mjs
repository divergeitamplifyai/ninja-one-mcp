// Unit tests for the pure parts: configuration, cursors, scoping, paths, redaction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../dist/config.js';
import { decodeCursor, encodeCursor, rowsOf } from '../dist/engine.js';
import { OrgDirectory } from '../dist/orgs.js';
import { validatePath } from '../dist/tools/passthrough.js';
import { redact, registerSecret } from '../dist/redact.js';
import { parseToolsets, DEFAULT_TOOLSETS } from '../dist/toolsets.js';
import { annotationsFor } from '../dist/spec.js';
import { ALL_ROUTES } from '../dist/routes/index.js';

test('config: no region and no base URL is a missing variable, not a default', () => {
  const c = loadConfig({ NINJAONE_CLIENT_ID: 'a', NINJAONE_CLIENT_SECRET: 'b' });
  assert.equal(c.baseUrl, undefined);
  assert.deepEqual(c.missing, ['NINJAONE_REGION']);
});

test('config: a region picks its host; a base URL wins; plaintext is refused off loopback', () => {
  assert.equal(loadConfig({ NINJAONE_REGION: 'eu' }).baseUrl, 'https://eu.ninjarmm.com');
  assert.equal(loadConfig({ NINJAONE_REGION: 'eu', NINJAONE_BASE_URL: 'https://custom.example.com/x' }).baseUrl, 'https://custom.example.com');
  const plain = loadConfig({ NINJAONE_BASE_URL: 'http://example.com' });
  assert.equal(plain.baseUrl, undefined);
  assert.ok(plain.problems.some((p) => p.includes('https')));
  assert.equal(loadConfig({ NINJAONE_BASE_URL: 'http://127.0.0.1:8080' }).baseUrl, 'http://127.0.0.1:8080');
  assert.ok(loadConfig({ NINJAONE_REGION: 'mars' }).problems.some((p) => p.includes('mars')));
});

test('config: gates fail closed on typos, and destructive needs write', () => {
  assert.equal(loadConfig({ NINJAONE_MODE: 'WRITE' }).writeMode, true);
  assert.equal(loadConfig({ NINJAONE_MODE: 'yes' }).writeMode, false);
  assert.equal(loadConfig({ NINJAONE_ALLOW_DESTRUCTIVE: 'true' }).destructiveAllowed, false);
  assert.equal(loadConfig({ NINJAONE_MODE: 'write', NINJAONE_ALLOW_DESTRUCTIVE: 'TRUE ' }).destructiveAllowed, true);
  assert.equal(loadConfig({ NINJAONE_MODE: 'write', NINJAONE_ALLOW_DESTRUCTIVE: 'yes' }).destructiveAllowed, false);
  assert.ok(loadConfig({ NINJAONE_MODE: 'write' }).problems.some((p) => p.includes('management')));
});

test('config: scopes default to monitoring and drop unknown names', () => {
  assert.deepEqual(loadConfig({}).scopes, ['monitoring']);
  const c = loadConfig({ NINJAONE_SCOPES: 'monitoring management bogus' });
  assert.deepEqual(c.scopes, ['monitoring', 'management']);
  assert.ok(c.problems.some((p) => p.includes('bogus')));
});

test('cursor: round trips and rejects anything it did not issue', () => {
  assert.deepEqual(decodeCursor(encodeCursor({ u: '42' })), { u: '42' });
  assert.deepEqual(decodeCursor(encodeCursor({ o: 50 })), { o: 50 });
  assert.throws(() => decodeCursor('garbage'));
  assert.throws(() => decodeCursor(Buffer.from('{"x":1}').toString('base64url')));
});

test('envelopes: an unknown shape is an error, never zero rows', () => {
  assert.equal(rowsOf([{ id: 1 }], { paging: { style: 'local' } }, 'x').rows.length, 1);
  assert.equal(rowsOf({ results: [{ id: 1 }] }, { paging: { style: 'cursor' } }, 'x').rows.length, 1);
  assert.equal(rowsOf({ tags: [{ id: 1 }] }, { paging: { style: 'local' } }, 'x').rows.length, 1);
  assert.throws(() => rowsOf({ a: [], b: [] }, { paging: { style: 'local' } }, 'GET /x'), /does not recognize/);
  assert.throws(() => rowsOf({ ok: true }, { paging: { style: 'local' } }, 'GET /x'), /does not recognize/);
});

test('boundary: df is narrowed with AND, and only when a boundary is set', () => {
  const open = new OrgDirectory(null, loadConfig({}));
  assert.equal(open.boundedDf('offline'), 'offline');
  assert.equal(open.boundedDf(undefined), undefined);
  const bound = new OrgDirectory(null, loadConfig({ NINJAONE_ALLOWED_ORG_IDS: '1, 2' }));
  assert.equal(bound.boundedDf(undefined), 'org in (1,2)');
  assert.equal(bound.boundedDf('class = MAC'), 'class = MAC AND org in (1,2)');
  assert.throws(() => bound.assertAllowed(3, 'Device 9'), /outside/);
  assert.doesNotThrow(() => bound.assertAllowed(2, 'Device 9'));
});

test('passthrough paths: only relative /v2 paths without traversal', () => {
  assert.equal(validatePath('/v2/devices'), '/v2/devices');
  for (const bad of ['/ws/oauth/token', 'v2/devices', '/v2/../ws', '/v2/a?b=c', '/v2/a%2e%2e/b', '/v2//x', '/v2/a b']) {
    assert.throws(() => validatePath(bad), undefined, bad);
  }
});

test('redaction: registered secrets and bearer tokens never print', () => {
  registerSecret('super-secret-value-1234');
  assert.equal(redact('x super-secret-value-1234 y'), 'x [REDACTED] y');
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop'), 'Authorization: Bearer [REDACTED]');
  assert.match(redact('client_secret=abc123456'), /\[REDACTED\]/);
});

test('toolsets: default, additive and all', () => {
  assert.deepEqual([...parseToolsets(undefined).enabled], [...DEFAULT_TOOLSETS]);
  assert.deepEqual([...parseToolsets('billing').enabled].sort(), ['billing', 'core']);
  assert.ok(parseToolsets('default,billing').enabled.has('reports'));
  assert.ok(parseToolsets('all').enabled.has('api'));
  assert.equal(parseToolsets('nope').problems.length, 1);
});

test('annotations: every hint is explicit and follows the kind', () => {
  assert.deepEqual(annotationsFor('read', 'T', false, false), { title: 'T', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.equal(annotationsFor('destructive', 'T', true, false).destructiveHint, true);
  assert.equal(annotationsFor('write', 'T', false, false).readOnlyHint, false);
});

test('routes: names are unique, writes carry bodies only where documented, secrets are destructive', () => {
  const names = ALL_ROUTES.map((r) => r.tool);
  assert.equal(new Set(names).size, names.length);
  for (const r of ALL_ROUTES) {
    if (r.secret) assert.equal(r.kind, 'destructive', `${r.tool} reveals secrets`);
    if (r.kind === 'read') assert.equal(r.body, undefined, `${r.tool} is a read with a body`);
    if (r.noRetry) assert.notEqual(r.kind, 'read', `${r.tool}`);
    for (const key of r.path.match(/\{([^}]+)\}/g) ?? []) {
      const wire = key.slice(1, -1);
      const fromScope = r.scope.kind === 'org' && r.scope.param === wire;
      const fromParam = Object.entries(r.params ?? {}).some(([k, p]) => p.in === 'path' && (p.wire ?? k) === wire);
      assert.ok(fromScope || fromParam, `${r.tool}: nothing fills {${wire}}`);
    }
  }
});

test('env file: only NINJAONE_ keys, quotes stripped, environment wins, loose permissions refused', async () => {
  const { parseEnvFile, applyEnvFile } = await import('../dist/envfile.js');
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  assert.deepEqual(parseEnvFile('# c\nNINJAONE_REGION="eu"\nOTHER=x\nexport NINJAONE_MODE=read\n'), { NINJAONE_REGION: 'eu', NINJAONE_MODE: 'read' });
  const dir = mkdtempSync(join(tmpdir(), 'ninjaone-envfile-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'NINJAONE_CLIENT_ID=from-file\nNINJAONE_REGION=eu\n');
  chmodSync(file, 0o644);
  if (process.platform !== 'win32') assert.match(applyEnvFile({ NINJAONE_ENV_FILE: file }).problem, /chmod 600/);
  chmodSync(file, 0o600);
  const env = { NINJAONE_ENV_FILE: file, NINJAONE_REGION: 'us' };
  const result = applyEnvFile(env);
  assert.deepEqual(result.loaded, ['NINJAONE_CLIENT_ID']);
  assert.equal(env.NINJAONE_REGION, 'us');
  assert.equal(applyEnvFile({ NINJAONE_ENV_FILE: 'none' }), undefined);
});
