// Test harness: a loopback mock of the NinjaOne Public API and OAuth endpoint,
// and an MCP client that talks to the BUILT server over real stdio.
//
// End to end on purpose: it proves registration, framing, the gate, scoping and
// that nothing but JSON-RPC reaches stdout. Nothing leaves the machine.
//
// The mock reproduces the API's dangerous behaviors, so a tool that would cause
// damage fails a test instead of a tenant:
//   - PUT /v2/organization/{id}/policies REPLACES every mapping
//   - PATCH custom-fields overwrites values with no history
//   - a POST that 5xxs may or may not have applied (the server must not replay it)

import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export const CLIENT_ID = 'test-client-id-0000';
export const CLIENT_SECRET = 'test-client-secret-not-real-9f8e7d6c';

function seed() {
  const orgs = [
    { id: 1, name: 'Alpha Org', description: 'first', nodeApprovalMode: 'AUTOMATIC' },
    { id: 2, name: 'Alpha Labs', description: 'second', nodeApprovalMode: 'MANUAL' },
    { id: 3, name: 'Bravo Org', description: 'third', nodeApprovalMode: 'AUTOMATIC' },
  ];
  const devices = [];
  let id = 100;
  for (const org of orgs) {
    for (let i = 0; i < 4; i++) {
      id++;
      devices.push({
        id,
        organizationId: org.id,
        locationId: org.id * 10,
        nodeClass: i % 2 ? 'WINDOWS_WORKSTATION' : 'WINDOWS_SERVER',
        systemName: `HOST-${id}`,
        displayName: `Host ${id}`,
        offline: i === 3,
        lastContact: 1767225600,
        approvalStatus: 'APPROVED',
        serialNumber: `SN${id}`,
      });
    }
  }
  return {
    orgs,
    devices,
    policies: { 1: [{ nodeRoleId: 1, policyId: 10 }, { nodeRoleId: 2, policyId: 11 }] },
    customFields: Object.fromEntries(devices.map((d) => [d.id, { assetOwner: 'nobody', warrantyEnd: '2027-01-01' }])),
    tokensIssued: 0,
  };
}

/**
 * Start the mock. `overrides(record)` may return { status, body, headers } to
 * short-circuit a request (a 401, a 429, a 500).
 */
export async function startMockApi(overrides = () => undefined) {
  const state = seed();
  const requests = [];
  let tokenSeq = 0;
  const validTokens = new Set();

  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const record = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      };
      requests.push(record);
      const send = (status, payload, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(payload === undefined ? '' : JSON.stringify(payload));
      };

      const override = overrides(record, state);
      if (override) return send(override.status ?? 200, override.body, override.headers);

      // OAuth: client credentials in a form body only.
      if (url.pathname === '/ws/oauth/token' && req.method === 'POST') {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') !== 'client_credentials' || form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
          return send(401, { error: 'invalid_client' });
        }
        const token = `mock-access-token-${++tokenSeq}-abcdefgh`;
        validTokens.add(token);
        state.tokensIssued++;
        return send(200, { access_token: token, token_type: 'Bearer', expires_in: 3600, scope: form.get('scope') });
      }

      const token = req.headers.authorization?.replace(/^Bearer /, '');
      if (!token || !validTokens.has(token)) return send(401, { resultCode: 'UNAUTHORIZED' });

      const p = url.pathname;
      const q = url.searchParams;
      const pageSize = Number(q.get('pageSize') ?? 1000);
      const json = () => (body ? JSON.parse(body) : undefined);

      // Device filter subset: "org = N", "org in (a,b)", "offline", joined by AND.
      const matchesDf = (device, df) => {
        if (!df) return true;
        return df.split(/\s+AND\s+/i).every((term) => {
          const t = term.trim();
          let m;
          if ((m = /^org(?:anization)?\s*=\s*(\d+)$/i.exec(t))) return device.organizationId === Number(m[1]);
          if ((m = /^org(?:anization)?\s+in\s*\(([\d,\s]+)\)$/i.exec(t))) return m[1].split(',').map(Number).includes(device.organizationId);
          if (/^offline$/i.test(t)) return device.offline;
          if (/^online$/i.test(t)) return !device.offline;
          return true;
        });
      };
      const afterPage = (rows) => {
        const after = q.get('after');
        const start = after ? rows.findIndex((r) => String(r.id) === after) + 1 : 0;
        return rows.slice(start, start + pageSize);
      };

      if (req.method === 'GET' && p === '/v2/organizations') return send(200, afterPage(state.orgs));
      let m;
      if ((m = /^\/v2\/organization\/(\d+)$/.exec(p))) {
        const org = state.orgs.find((o) => o.id === Number(m[1]));
        if (!org) return send(404, { resultCode: 'NOT_FOUND' });
        if (req.method === 'GET') return send(200, { ...org, policies: state.policies[org.id] ?? [] });
      }
      if ((m = /^\/v2\/organization\/(\d+)\/policies$/.exec(p)) && req.method === 'PUT') {
        // Dangerous on purpose: a full replacement.
        state.policies[Number(m[1])] = json();
        return send(204);
      }
      if (req.method === 'GET' && p === '/v2/devices') return send(200, afterPage(state.devices.filter((d) => matchesDf(d, q.get('df')))));
      if ((m = /^\/v2\/device\/(\d+)$/.exec(p)) && req.method === 'GET') {
        const device = state.devices.find((d) => d.id === Number(m[1]));
        return device ? send(200, device) : send(404, { resultCode: 'NOT_FOUND' });
      }
      if ((m = /^\/v2\/device\/(\d+)\/custom-fields$/.exec(p))) {
        const id = Number(m[1]);
        if (req.method === 'GET') return send(200, state.customFields[id] ?? {});
        if (req.method === 'PATCH') {
          state.customFields[id] = { ...state.customFields[id], ...json() };
          return send(204);
        }
      }
      if ((m = /^\/v2\/device\/(\d+)\/(volumes|disks|processors|network-interfaces|alerts|os-patches|software-patches|software)$/.exec(p))) {
        const kind = m[2];
        if (kind === 'volumes') return send(200, [{ name: 'C:', fileSystem: 'NTFS', capacity: 500e9, freeSpace: 50e9 }]);
        if (kind === 'os-patches') return send(200, [{ name: 'KB1', status: 'PENDING', severity: 'CRITICAL' }, { name: 'KB2', status: 'FAILED', severity: 'IMPORTANT' }]);
        if (kind === 'disks') return send(500, { resultCode: 'BOOM' });
        return send(200, []);
      }
      if ((m = /^\/v2\/device\/(\d+)\/last-logged-on-user$/.exec(p))) return send(200, { userName: 'EXAMPLE\\user', logonTime: 1767225600 });
      if ((m = /^\/v2\/device\/(\d+)\/reboot\/(NORMAL|FORCED)$/.exec(p)) && req.method === 'POST') return send(204);
      if (req.method === 'GET' && p === '/v2/alerts') {
        const rows = state.devices.filter((d) => matchesDf(d, q.get('df')) && d.offline).map((d) => ({ uid: `alert-${d.id}`, deviceId: d.id, severity: 'MAJOR', message: 'Device offline', sourceType: 'CONDITION' }));
        return send(200, rows);
      }

      // /v2/queries/*: cursor paging over device rows.
      if ((m = /^\/v2\/queries\/(.+)$/.exec(p)) && req.method === 'GET') {
        const rows = state.devices
          .filter((d) => matchesDf(d, q.get('df')))
          .map((d) => ({ deviceId: d.id, organizationId: d.organizationId, offline: d.offline, healthStatus: d.offline ? 'UNHEALTHY' : 'HEALTHY', status: 'PENDING', name: m[1] }));
        const offset = q.get('cursor') ? Number(q.get('cursor').replace('c', '')) : 0;
        const page = rows.slice(offset, offset + pageSize);
        return send(200, { cursor: { name: `c${offset + pageSize}`, offset, count: page.length, expires: 0 }, results: page });
      }

      if (req.method === 'GET' && p === '/v2/custom-fields') return send(200, { page: 0, pageSize: 50, count: 0, results: [] });

      return send(404, { resultCode: 'NOT_FOUND', path: p });
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    apiRequests: () => requests.filter((r) => r.path.startsWith('/v2/')),
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Start the built server over stdio with exactly these environment variables. */
export async function startServer(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist/index.js')],
    env: { ...getDefaultEnvironment(), NINJAONE_ENV_FILE: 'none', ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => (stderr += chunk));
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

/** A mock plus a server pointed at it. */
export async function session(env = {}, overrides) {
  const api = await startMockApi(overrides);
  const server = await startServer({
    NINJAONE_BASE_URL: api.url,
    NINJAONE_CLIENT_ID: CLIENT_ID,
    NINJAONE_CLIENT_SECRET: CLIENT_SECRET,
    NINJAONE_TOOLSETS: 'all',
    ...env,
  });
  return {
    api,
    client: server.client,
    stderr: server.stderr,
    call: (name, args = {}) => server.client.callTool({ name, arguments: args }),
    close: async () => {
      await server.close();
      await api.close();
    },
  };
}

export function textOf(result) {
  return (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

export function json(result) {
  return JSON.parse(textOf(result));
}
