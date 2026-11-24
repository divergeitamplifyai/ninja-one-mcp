// End-to-end tests: the built server over stdio against a loopback NinjaOne mock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_ID, CLIENT_SECRET, json, session, startMockApi, startServer, textOf } from './harness.mjs';

const lastLine = (r) => textOf(r).trim().split('\n').at(-1);

// ------------------------------------------------------------------ configuration and auth

test('status_server works with no credentials, names what is missing, and calls nothing', async () => {
  const api = await startMockApi();
  const server = await startServer({ NINJAONE_BASE_URL: api.url });
  try {
    const result = await server.client.callTool({ name: 'ninjaone_status_server', arguments: {} });
    assert.notEqual(result.isError, true);
    const body = json(result);
    assert.deepEqual(body.missing_env_vars, ['NINJAONE_CLIENT_ID', 'NINJAONE_CLIENT_SECRET']);
    assert.equal(body.mode, 'read');
    assert.deepEqual(body.scopes, ['monitoring']);
    assert.equal(api.requests.length, 0);
  } finally {
    await server.close();
    await api.close();
  }
});

test('without a region or base URL the server says which variable to set', async () => {
  const server = await startServer({ NINJAONE_CLIENT_ID: CLIENT_ID, NINJAONE_CLIENT_SECRET: CLIENT_SECRET });
  try {
    const status = json(await server.client.callTool({ name: 'ninjaone_status_server', arguments: {} }));
    assert.deepEqual(status.missing_env_vars, ['NINJAONE_REGION']);
    const result = await server.client.callTool({ name: 'ninjaone_test_connection', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /NINJAONE_REGION/);
    assert.match(lastLine(result), /^Next step: /);
  } finally {
    await server.close();
  }
});

test('test_connection gets a token by form POST, then sends it only as a bearer header', async () => {
  const s = await session();
  try {
    const body = json(await s.call('ninjaone_test_connection'));
    assert.equal(body.ok, true);
    assert.equal(body.sample_organization.name, 'Alpha Org');
    const tokenReq = s.api.requests.find((r) => r.path === '/ws/oauth/token');
    assert.match(tokenReq.contentType, /application\/x-www-form-urlencoded/);
    assert.equal(new URLSearchParams(tokenReq.body).get('scope'), 'monitoring');
    assert.deepEqual(tokenReq.query, {});
    const apiReq = s.api.apiRequests()[0];
    assert.match(apiReq.auth, /^Bearer mock-access-token-/);
    for (const r of s.api.requests) assert.equal(JSON.stringify(r.query).includes(CLIENT_SECRET), false);
  } finally {
    await s.close();
  }
});

test('the access token is cached across calls', async () => {
  const s = await session();
  try {
    await s.call('ninjaone_test_connection');
    await s.call('ninjaone_list_organizations');
    assert.equal(s.api.state.tokensIssued, 1);
  } finally {
    await s.close();
  }
});

test('a 401 from the API refreshes the token once and retries', async () => {
  let rejected = false;
  const s = await session({}, (r) => {
    if (r.path === '/v2/organizations' && !rejected) {
      rejected = true;
      return { status: 401, body: { resultCode: 'UNAUTHORIZED' } };
    }
  });
  try {
    const result = await s.call('ninjaone_list_organizations');
    assert.notEqual(result.isError, true);
    assert.equal(s.api.state.tokensIssued, 2);
  } finally {
    await s.close();
  }
});

test('bad client credentials are reported with a next step, and the secret never leaks', async () => {
  const s = await session({ NINJAONE_CLIENT_SECRET: 'wrong-secret-0000000000000' });
  try {
    const result = await s.call('ninjaone_test_connection');
    assert.equal(result.isError, true);
    assert.match(textOf(result), /invalid client credentials/);
    assert.match(lastLine(result), /^Next step: .*NINJAONE_CLIENT_ID/);
    assert.equal(textOf(result).includes('wrong-secret-0000000000000'), false);
    assert.equal(s.stderr().includes('wrong-secret-0000000000000'), false);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ reads, paging, shaping

test('list_devices is compact, pages with an opaque cursor, and returns full rows on request', async () => {
  const s = await session();
  try {
    const first = (await s.call('ninjaone_list_devices', { limit: 5 })).structuredContent;
    assert.equal(first.count, 5);
    assert.equal(first.has_more, true);
    assert.equal('serialNumber' in first.items[0], false, 'compact by default');
    const second = (await s.call('ninjaone_list_devices', { limit: 5, cursor: first.next_cursor })).structuredContent;
    assert.equal(second.items[0].id, first.items[4].id + 1);
    const full = (await s.call('ninjaone_list_devices', { limit: 1, fields: 'all' })).structuredContent;
    assert.equal(full.items[0].serialNumber, 'SN101');
    const bad = await s.call('ninjaone_list_devices', { cursor: 'not-a-cursor' });
    assert.equal(bad.isError, true);
  } finally {
    await s.close();
  }
});

test('reports use the /v2/queries cursor and say when there is more', async () => {
  const s = await session();
  try {
    const page1 = (await s.call('ninjaone_report_device_health', { limit: 10 })).structuredContent;
    assert.equal(page1.count, 10);
    assert.equal(page1.has_more, true);
    const page2 = (await s.call('ninjaone_report_device_health', { limit: 10, cursor: page1.next_cursor })).structuredContent;
    assert.equal(page2.count, 2);
    assert.equal(page2.has_more, false);
    const queries = s.api.apiRequests().filter((r) => r.path === '/v2/queries/device-health');
    assert.equal(queries[1].query.cursor, 'c10');
  } finally {
    await s.close();
  }
});

test('an organization name resolves to its id, and an ambiguous name is refused with candidates', async () => {
  const s = await session();
  try {
    const ok = json(await s.call('ninjaone_get_organization', { org: 'bravo' }));
    assert.equal(ok.org.id, '3');
    const ambiguous = await s.call('ninjaone_get_organization', { org: 'alpha' });
    assert.equal(ambiguous.isError, true);
    assert.match(textOf(ambiguous), /Alpha Org \(1\).*Alpha Labs \(2\)/);
    const none = await s.call('ninjaone_get_organization', {});
    assert.equal(none.isError, true);
    assert.match(textOf(none), /does not infer/);
  } finally {
    await s.close();
  }
});

test('get_device_profile assembles one device and reports a failed part instead of failing', async () => {
  const s = await session();
  try {
    const body = json(await s.call('ninjaone_get_device_profile', { device_id: 101 }));
    assert.equal(body.device.id, 101);
    assert.equal(body.patches.os.total, 2);
    assert.deepEqual(body.patches.os.by_status, { PENDING: 1, FAILED: 1 });
    assert.ok(body.disks.error, 'the 500 on disks is reported on its part');
    assert.match(body.warning, /disks/);
  } finally {
    await s.close();
  }
});

test('report_fleet_health returns one row per organization with counts', async () => {
  const s = await session();
  try {
    const body = json(await s.call('ninjaone_report_fleet_health'));
    assert.equal(body.organizations, 3);
    for (const row of body.items) {
      assert.equal(row.ok, true);
      assert.equal(row.devices, 4);
      assert.equal(row.offline, 1);
      assert.equal(row.active_alerts, 1);
    }
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ the organization boundary

test('the boundary narrows every device filter and can only narrow it', async () => {
  const s = await session({ NINJAONE_ALLOWED_ORG_IDS: '1' });
  try {
    const all = (await s.call('ninjaone_list_devices', { limit: 100 })).structuredContent;
    assert.ok(all.items.every((d) => d.organizationId === 1));
    const sneaky = (await s.call('ninjaone_list_devices', { df: 'org = 3', limit: 100 })).structuredContent;
    assert.equal(sneaky.count, 0);
    const sent = s.api.apiRequests().filter((r) => r.path === '/v2/devices').map((r) => r.query.df);
    assert.deepEqual(sent, ['org in (1)', 'org = 3 AND org in (1)']);
  } finally {
    await s.close();
  }
});

test('the boundary refuses a device, an organization, and unscoped tools outside it', async () => {
  const s = await session({ NINJAONE_ALLOWED_ORG_IDS: '1' });
  try {
    assert.notEqual((await s.call('ninjaone_get_device', { device_id: 101 })).isError, true);
    const device = await s.call('ninjaone_get_device', { device_id: 109 });
    assert.equal(device.isError, true);
    assert.match(textOf(device), /outside this deployment's boundary/);
    const org = await s.call('ninjaone_get_organization', { org: '3' });
    assert.equal(org.isError, true);
    const raw = await s.call('ninjaone_api_get', { path: '/v2/devices' });
    assert.equal(raw.isError, true);
    assert.match(textOf(raw), /NINJAONE_ALLOWED_ORG_IDS/);
    const fleet = json(await s.call('ninjaone_report_fleet_health'));
    assert.equal(fleet.organizations, 1);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ the write gate

test('in read mode a write refuses, names the setting, and sends nothing', async () => {
  const s = await session();
  try {
    const before = s.api.apiRequests().length;
    const result = await s.call('ninjaone_reboot_device', { device_id: 101, mode: 'NORMAL', confirm: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /NINJAONE_MODE=write/);
    assert.match(lastLine(result), /^Next step: /);
    assert.equal(s.api.apiRequests().length, before);
  } finally {
    await s.close();
  }
});

test('with only write mode, destructive tools still refuse', async () => {
  const s = await session({ NINJAONE_MODE: 'write' });
  try {
    const result = await s.call('ninjaone_reboot_device', { device_id: 101, mode: 'NORMAL', confirm: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /NINJAONE_ALLOW_DESTRUCTIVE=true/);
    assert.equal(s.api.apiRequests().length, 0);
  } finally {
    await s.close();
  }
});

test('the write allowlist narrows writes further', async () => {
  const s = await session({ NINJAONE_MODE: 'write', NINJAONE_WRITE_ALLOWLIST: 'ninjaone_run_os_patch_scan' });
  try {
    const result = await s.call('ninjaone_update_device_custom_fields', { device_id: 101, body: { assetOwner: 'x' }, confirm: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /NINJAONE_WRITE_ALLOWLIST/);
  } finally {
    await s.close();
  }
});

test('a custom field write reads back and returns before and after', async () => {
  const s = await session({ NINJAONE_MODE: 'write' });
  try {
    const body = json(await s.call('ninjaone_update_device_custom_fields', { device_id: 101, body: { assetOwner: 'Example User' }, confirm: true }));
    assert.equal(body.applied, true);
    assert.equal(body.before.assetOwner, 'nobody');
    assert.equal(body.after.assetOwner, 'Example User');
    assert.equal(body.after.warrantyEnd, '2027-01-01');
  } finally {
    await s.close();
  }
});

test('a full-replacement PUT is a dry run until dry_run is false, and returns what it replaced', async () => {
  const s = await session({ NINJAONE_MODE: 'write', NINJAONE_ALLOW_DESTRUCTIVE: 'true' });
  try {
    const args = { org: '1', body: [{ nodeRoleId: 1, policyId: 99 }], confirm: true };
    const dry = json(await s.call('ninjaone_set_org_policy_mappings', args));
    assert.equal(dry.dry_run, true);
    assert.equal(dry.before.policies.length, 2);
    assert.equal(s.api.apiRequests().some((r) => r.method === 'PUT'), false);
    assert.equal(s.api.state.policies[1].length, 2, 'nothing replaced yet');
    const applied = json(await s.call('ninjaone_set_org_policy_mappings', { ...args, dry_run: false }));
    assert.equal(applied.applied, true);
    assert.equal(applied.before.policies.length, 2, 'the undo is in the result');
    assert.deepEqual(s.api.state.policies[1], [{ nodeRoleId: 1, policyId: 99 }]);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ retries

test('a 429 on a read is retried, honoring Retry-After', async () => {
  let n = 0;
  const s = await session({}, (r) => {
    if (r.path === '/v2/organizations' && n++ === 0) return { status: 429, headers: { 'retry-after': '0' }, body: {} };
  });
  try {
    assert.notEqual((await s.call('ninjaone_list_organizations')).isError, true);
    assert.equal(s.api.apiRequests().filter((r) => r.path === '/v2/organizations').length, 2);
  } finally {
    await s.close();
  }
});

test('a 5xx on a write is not replayed', async () => {
  const s = await session({ NINJAONE_MODE: 'write' }, (r) => {
    if (r.method === 'POST' && r.path === '/v2/organizations') return { status: 503, body: { resultCode: 'UNAVAILABLE' } };
  });
  try {
    const result = await s.call('ninjaone_create_organization', { body: { name: 'Example New' }, confirm: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /may or may not have applied/);
    assert.equal(s.api.apiRequests().filter((r) => r.method === 'POST').length, 1);
  } finally {
    await s.close();
  }
});

test('a reboot is never retried, not even on 429', async () => {
  const s = await session({ NINJAONE_MODE: 'write', NINJAONE_ALLOW_DESTRUCTIVE: 'true' }, (r) => {
    if (r.path.includes('/reboot/')) return { status: 429, headers: { 'retry-after': '0' }, body: {} };
  });
  try {
    const result = await s.call('ninjaone_reboot_device', { device_id: 101, mode: 'NORMAL', confirm: true });
    assert.equal(result.isError, true);
    assert.equal(s.api.apiRequests().filter((r) => r.path.includes('/reboot/')).length, 1);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ passthrough and secrets

test('api_get validates paths, strips showSecureValues and refuses signed-URL routes', async () => {
  const s = await session();
  try {
    const ok = await s.call('ninjaone_api_get', { path: '/v2/custom-fields', query: { showSecureValues: true, pageSize: 5 } });
    assert.notEqual(ok.isError, true);
    const sent = s.api.apiRequests().find((r) => r.path === '/v2/custom-fields');
    assert.equal('showSecureValues' in sent.query, false);
    for (const path of ['/v2/../ws/oauth/token', '/ws/oauth/token', '/v2/devices?df=x', '/v2//devices']) {
      assert.equal((await s.call('ninjaone_api_get', { path })).isError, true, path);
    }
    const signed = await s.call('ninjaone_api_get', { path: '/v2/knowledgebase/article/1/signed-urls' });
    assert.equal(signed.isError, true);
    assert.match(textOf(signed), /download/);
  } finally {
    await s.close();
  }
});

test('report_custom_fields never requests secure values', async () => {
  const s = await session();
  try {
    await s.call('ninjaone_report_custom_fields', {});
    const sent = s.api.apiRequests().find((r) => r.path === '/v2/queries/custom-fields');
    assert.equal('showSecureValues' in sent.query, false);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ listing, views, resources

test('the default toolsets stay under client tool caps, and all lists every tool', async () => {
  const api = await startMockApi();
  const def = await startServer({ NINJAONE_BASE_URL: api.url });
  const all = await startServer({ NINJAONE_BASE_URL: api.url, NINJAONE_TOOLSETS: 'all' });
  const small = await startServer({ NINJAONE_BASE_URL: api.url, NINJAONE_TOOLSETS: 'devices,nonsense' });
  try {
    const count = async (c) => (await c.client.listTools()).tools.length;
    const d = await count(def);
    const a = await count(all);
    const sm = await count(small);
    assert.ok(d < 128, `default lists ${d}`);
    assert.ok(a > 300, `all lists ${a}`);
    assert.ok(sm < d);
    const status = json(await small.client.callTool({ name: 'ninjaone_status_server', arguments: {} }));
    assert.ok(status.config_problems.some((p) => p.includes('nonsense')));
    assert.deepEqual(status.toolsets_enabled, ['core', 'devices']);
  } finally {
    await def.close();
    await all.close();
    await small.close();
    await api.close();
  }
});

test('the fleet view declares its ui resource and returns the data as JSON', async () => {
  const s = await session();
  try {
    const { tools } = await s.client.listTools();
    const view = tools.find((t) => t.name === 'ninjaone_view_fleet');
    assert.equal(view.annotations.readOnlyHint, true);
    assert.equal(view._meta.ui.resourceUri, 'ui://ninjaone/fleet.html');
    const html = await s.client.readResource({ uri: 'ui://ninjaone/fleet.html' });
    assert.match(html.contents[0].mimeType, /profile=mcp-app/);
    const body = json(await s.call('ninjaone_view_fleet'));
    assert.equal(body.organizations, 3);
  } finally {
    await s.close();
  }
});

test('the docs index and device filter guide are readable resources', async () => {
  const s = await session();
  try {
    const llms = await s.client.readResource({ uri: 'ninjaone://docs/llms.txt' });
    assert.match(llms.contents[0].text, /^# NinjaOne/);
    const df = await s.client.readResource({ uri: 'ninjaone://docs/device-filters' });
    assert.match(df.contents[0].text, /AND/);
  } finally {
    await s.close();
  }
});

test('stdout carries only JSON-RPC', async () => {
  const s = await session();
  try {
    await s.call('ninjaone_test_connection');
    assert.match(s.stderr(), /"event":"started"/);
  } finally {
    await s.close();
  }
});
