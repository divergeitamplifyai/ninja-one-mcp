#!/usr/bin/env node
// Conformance check against STANDARD.md.
//
// Starts the BUILT server over stdio with no credential and the base URL pointed
// at a closed loopback port, reads the real tools/list, and checks:
//
//   naming       <prefix>_<verb>_<noun>, verb from the lists below, title present
//   annotations  all four hints set, readOnlyHint agrees with the verb,
//                destructive only on non-read tools, passthrough rules
//   diagnostics  status_server, status_gate, test_connection present;
//                status_server works with no credential and names the missing key
//   gates        every non-read tool takes confirm (const true, required); in read
//                mode every non-read tool refuses naming <ENV>_MODE=write; in write
//                mode every destructive tool refuses naming <ENV>_ALLOW_DESTRUCTIVE;
//                refusals end with a "Next step:" line. With writeTools "listed"
//                (default) tools/list is the same in every mode; with "hidden",
//                a gated tool may be left out of tools/list, but status_gate must
//                name every tool it withholds
//   mutations    mutations.json lists exactly the tools, agrees with readOnlyHint,
//                and gives a blast radius and rollback for every mutating tool
//   secrets      a canary credential never appears in diagnostic output
//
// It never calls the vendor API: gate refusals happen before any request, and
// only diagnostics that make no request are called.
//
// The verb lists here are canonical. Add a verb by changing this file and
// STANDARD.md in the same pull request.
//
// Usage: npm run build && node scripts/check-conformance.mjs [server-index]
//
// package.json "mcpServer" keys: toolPrefix, envPrefix, entry, writeTools, and
// optionally credentialEnv (string or array), baseUrlEnv, env (fixed variables
// for the run, e.g. a product selector) and mutations (file name).

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

export const READ_VERBS = ['list', 'get', 'search', 'find', 'test', 'status', 'report', 'plan', 'preview'];
export const VIEW_VERB = 'view';
export const WRITE_VERBS = [
  'create', 'update', 'set', 'add', 'remove', 'delete', 'run', 'execute', 'send', 'rotate', 'assign', 'unassign',
  'sync', 'restart', 'reboot', 'start', 'stop', 'move', 'rename', 'enable', 'disable', 'dismiss', 'restore',
  'cycle', 'claim', 'lock', 'unlock', 'wipe', 'retire', 'install', 'uninstall', 'apply', 'post', 'revoke',
  'approve', 'reject', 'import', 'reset', 'clear', 'invite', 'suspend', 'resume', 'authorize', 'unauthorize',
  'adopt', 'unadopt', 'reorder', 'attach', 'detach', 'trigger', 'issue', 'reconcile', 'close', 'reopen', 'upload',
  'archive', 'cancel', 'pause', 'unpause', 'redact', 'download',
];
const BLAST_RADII = ['none', 'single-object', 'single-tenant', 'multi-tenant'];
const REQUIRED_BASE_FILES = ['AGENTS.md', 'CLAUDE.md', 'SECURITY.md', '.env.example', '.gitignore'];

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
// mcpServer may be one object or, for a repository that ships more than one
// server from one codebase, an array. With an array and no index argument, the
// script re-runs itself once per server and fails if any run fails.
const CONFIGS = Array.isArray(pkg.mcpServer) ? pkg.mcpServer : [pkg.mcpServer ?? {}];
if (CONFIGS.length > 1 && process.argv[2] === undefined) {
  let failed = 0;
  for (let i = 0; i < CONFIGS.length; i++) {
    console.log(`\n=== ${CONFIGS[i].toolPrefix} ===`);
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), String(i)], { stdio: 'inherit' });
    if (run.status !== 0) failed++;
  }
  process.exit(failed === 0 ? 0 : 1);
}
const CONFIG = CONFIGS[Number(process.argv[2] ?? 0)] ?? {};
const { toolPrefix: P, envPrefix: E, entry, writeTools: WRITE_TOOLS = 'listed' } = CONFIG;
const HIDDEN = WRITE_TOOLS === 'hidden';
// Vendors name their credentials differently (a public/private key pair, a
// client id and token, a login). credentialEnv lists them; the first is the one
// status_server must name when nothing is set. Defaults to <PREFIX>_API_KEY.
const CRED_ENV = [CONFIG.credentialEnv ?? `${E}_API_KEY`].flat();
const BASE_URL_ENV = CONFIG.baseUrlEnv ?? `${E}_BASE_URL`;
const EXTRA_ENV = CONFIG.env ?? {};
const MUTATIONS_FILE = CONFIG.mutations ?? 'mutations.json';
const REQUIRED_FILES = [...REQUIRED_BASE_FILES, MUTATIONS_FILE];

const failures = [];
const warnings = [];
let checks = 0;
function check(ok, message) {
  checks++;
  if (!ok) failures.push(message);
  return ok;
}

if (!P || !E || !entry) {
  console.error('package.json needs "mcpServer": { "toolPrefix", "envPrefix", "entry" }.');
  process.exit(1);
}
if (!existsSync(join(ROOT, entry))) {
  console.error(`${entry} does not exist. Run npm run build first.`);
  process.exit(1);
}

// A closed loopback port: if anything did try the network it fails locally.
const BASE_ENV = { [BASE_URL_ENV]: 'http://127.0.0.1:9', ...EXTRA_ENV };

async function withServer(extraEnv, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, entry)],
    env: { ...getDefaultEnvironment(), ...BASE_ENV, ...extraEnv },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'conformance', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function listAll(client) {
  const tools = [];
  let cursor;
  do {
    const result = await client.listTools(cursor ? { cursor } : {});
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);
  return tools;
}

const textOf = (result) => (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const lastLine = (text) => text.trim().split('\n').pop() ?? '';

// String formats and patterns a server may validate before its gate runs. The
// sample has to pass input validation, or the check would be testing the schema
// rather than the gate.
const FORMAT_SAMPLES = {
  uuid: '00000000-0000-4000-8000-000000000000',
  email: 'conformance@example.com',
  uri: 'https://example.com/',
  url: 'https://example.com/',
  'date-time': '2026-01-01T00:00:00Z',
  datetime: '2026-01-01T00:00:00Z',
  date: '2026-01-01',
  time: '00:00:00',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  hostname: 'example.com',
};
const PATTERN_CANDIDATES = ['x', '/x', '/organizations/1', 'N_1', 'L_1', 'Q2XX-XXXX-XXXX', '1', 'a1', 'X', 'x-x',
  '00000000-0000-4000-8000-000000000000', 'conformance@example.com', 'https://example.com/', '2026-01-01T00:00:00Z',
  '2026-01-01', '00:00', 'aa:bb:cc:dd:ee:ff', '192.0.2.1', '192.0.2.0/24', 'example.com', 'xx', 'x/x', 'x.x'];
function sampleString(schema) {
  const fits = (v) => v.length >= (schema.minLength ?? 0) && v.length <= (schema.maxLength ?? Infinity) &&
    (!schema.pattern || new RegExp(schema.pattern, 'u').test(v));
  const byFormat = FORMAT_SAMPLES[schema.format];
  if (byFormat && fits(byFormat)) return byFormat;
  // A pattern anchored on a literal prefix (^SB_[A-Z0-9_]+$) gets the prefix plus a filler.
  const prefix = /^\^([A-Za-z0-9_\-:/.]*)/.exec(schema.pattern ?? '')?.[1] ?? '';
  for (const candidate of [...PATTERN_CANDIDATES, ...['X', 'x', '1', 'X1'].map((f) => prefix + f)]) if (fits(candidate)) return candidate;
  return 'x'.repeat(Math.max(1, schema.minLength ?? 1));
}

/** Smallest value that satisfies a JSON Schema, for calling a tool far enough to hit its gate. */
function sample(schema) {
  if (!schema || typeof schema !== 'object') return 'x';
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const alt = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alt)) return sample(alt.find((s) => s.type !== 'null') ?? alt[0]);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'string':
      return sampleString(schema);
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean':
      return true;
    case 'array':
      return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items));
    case 'object':
    default: {
      const out = {};
      for (const key of schema.required ?? []) out[key] = sample(schema.properties?.[key]);
      return out;
    }
  }
}

const isRequiredTrueConfirm = (tool) =>
  tool.inputSchema?.properties?.confirm?.const === true && (tool.inputSchema?.required ?? []).includes('confirm');

// ---------------------------------------------------------------- files
for (const file of REQUIRED_FILES) check(existsSync(join(ROOT, file)), `missing required file ${file}`);

// ---------------------------------------------------------------- read mode
const NAME = new RegExp(`^${P}_[a-z0-9]+(?:_[a-z0-9]+)+$`);
const readMode = await withServer({}, async (client) => {
  const tools = await listAll(client);
  const instructions = client.getInstructions() ?? '';
  const results = {};

  // Diagnostics with no credential.
  const status = await client.callTool({ name: `${P}_status_server`, arguments: {} }).catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e) }] }));
  results.status = status;
  results.gate = await client.callTool({ name: `${P}_status_gate`, arguments: {} }).catch(() => undefined);

  // Every non-read tool refuses in read mode.
  results.refusals = {};
  for (const tool of tools) {
    if (tool.annotations?.readOnlyHint === true) continue;
    results.refusals[tool.name] = await client.callTool({ name: tool.name, arguments: sample(tool.inputSchema) });
  }
  return { tools, instructions, results };
});

check(WRITE_TOOLS === 'listed' || WRITE_TOOLS === 'hidden', `package.json mcpServer.writeTools must be "listed" or "hidden" (got ${WRITE_TOOLS})`);

// The full tool set is what the server lists with both gates open. In "listed" mode
// that must equal the read-mode list (checked below); in "hidden" mode it is the set
// every naming, annotation and mutations check runs against.
const OPEN_ENV = { [`${E}_MODE`]: 'write', [`${E}_ALLOW_DESTRUCTIVE`]: 'true' };
const tools = HIDDEN ? await withServer(OPEN_ENV, (client) => listAll(client)) : readMode.tools;
const byName = new Map(tools.map((t) => [t.name, t]));
const readListed = new Set(readMode.tools.map((t) => t.name));
if (HIDDEN) {
  const gateText = readMode.results.gate ? textOf(readMode.results.gate) : '';
  for (const tool of readMode.tools) check(byName.has(tool.name), `${tool.name}: listed in read mode but not with both gates open`);
  for (const tool of tools) {
    if (tool.annotations?.readOnlyHint === true) {
      check(readListed.has(tool.name), `${tool.name}: read tools must be listed in every mode`);
    } else if (!readListed.has(tool.name)) {
      check(gateText.includes(tool.name), `${tool.name}: hidden in read mode, so ${P}_status_gate must name it`);
    }
  }
}

check(readMode.instructions.includes(`${P}_status_server`), 'server instructions must exist and name the diagnostics tools');

for (const required of [`${P}_status_server`, `${P}_status_gate`, `${P}_test_connection`]) {
  const tool = byName.get(required);
  if (check(tool !== undefined, `required diagnostic ${required} is missing`)) {
    check(tool.annotations?.readOnlyHint === true, `${required} must be read-only`);
  }
}

for (const tool of tools) {
  const n = tool.name;
  const a = tool.annotations ?? {};
  check(NAME.test(n), `${n}: not ${P}_<verb>_<noun> in lowercase snake_case`);
  check(n.length <= 64, `${n}: longer than 64 characters`);
  check(typeof tool.title === 'string' && tool.title.length > 0, `${n}: no title`);
  check(typeof tool.description === 'string' && tool.description.length >= 40, `${n}: description missing or under 40 characters`);
  for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
    check(typeof a[hint] === 'boolean', `${n}: annotations.${hint} is not set explicitly`);
  }

  // The prefix may itself contain underscores (cw_psa); the verb follows it.
  const verb = n.startsWith(`${P}_`) ? n.slice(P.length + 1).split('_')[0] : '';
  const readOnly = a.readOnlyHint === true;
  if (n === `${P}_api_get`) {
    check(readOnly, `${n}: a GET passthrough must be read-only`);
  } else if (n === `${P}_api_write`) {
    check(!readOnly && a.destructiveHint === true, `${n}: a write passthrough belongs to the destructive tier`);
  } else if (verb === VIEW_VERB) {
    check(readOnly, `${n}: a view tool must be read-only`);
    if (!tool._meta?.ui?.resourceUri && !tool._meta?.['ui/resourceUri']) warnings.push(`${n}: view tool declares no ui:// resource`);
  } else {
    const isRead = READ_VERBS.includes(verb);
    const isWrite = WRITE_VERBS.includes(verb);
    if (check(isRead || isWrite, `${n}: verb "${verb}" is not in the read or write verb lists`)) {
      check(readOnly === isRead, `${n}: verb "${verb}" says ${isRead ? 'read' : 'write'}, readOnlyHint says ${readOnly ? 'read' : 'write'}`);
    }
  }
  if (readOnly) check(a.destructiveHint !== true, `${n}: read-only and destructive at once`);

  if (!readOnly) {
    check(isRequiredTrueConfirm(tool), `${n}: write tools must require confirm with const true`);
    const refusal = readMode.results.refusals[n];
    if (HIDDEN && !readListed.has(n)) continue;
    const text = refusal ? textOf(refusal) : '';
    check(refusal?.isError === true && text.includes(`${E}_MODE=write`), `${n}: in read mode it must refuse and name ${E}_MODE=write (got: ${text.slice(0, 160)})`);
    check(lastLine(text).startsWith('Next step:'), `${n}: refusal must end with a "Next step:" line`);
  }
}

const status = readMode.results.status;
check(status?.isError !== true, `${P}_status_server must succeed with no credential`);
check(textOf(status ?? {}).includes(CRED_ENV[0]), `${P}_status_server must name ${CRED_ENV[0]} when it is missing`);

// ---------------------------------------------------------------- write mode, destructive gate closed
const destructive = tools.filter((t) => t.annotations?.readOnlyHint === false && t.annotations?.destructiveHint === true);
await withServer({ [`${E}_MODE`]: 'write' }, async (client) => {
  const names = (await listAll(client)).map((t) => t.name).sort();
  if (HIDDEN) {
    const listed = new Set(names);
    const gate = await client.callTool({ name: `${P}_status_gate`, arguments: {} }).catch(() => undefined);
    const gateText = gate ? textOf(gate) : '';
    for (const tool of tools) {
      if (tool.annotations?.destructiveHint !== true) {
        check(listed.has(tool.name), `${tool.name}: with ${E}_MODE=write every non-destructive tool must be listed`);
      } else if (!listed.has(tool.name)) {
        check(gateText.includes(tool.name), `${tool.name}: hidden with only ${E}_MODE=write, so ${P}_status_gate must name it`);
      }
    }
  } else {
    check(JSON.stringify(names) === JSON.stringify(tools.map((t) => t.name).sort()), 'tools/list differs between read and write mode; write tools must stay listed');
  }
  for (const tool of destructive) {
    if (HIDDEN && !names.includes(tool.name)) continue;
    const result = await client.callTool({ name: tool.name, arguments: sample(tool.inputSchema) });
    const text = textOf(result);
    check(result.isError === true && text.includes(`${E}_ALLOW_DESTRUCTIVE=true`), `${tool.name}: with only ${E}_MODE=write it must refuse and name ${E}_ALLOW_DESTRUCTIVE=true`);
    check(lastLine(text).startsWith('Next step:'), `${tool.name}: refusal must end with a "Next step:" line`);
  }
});

// ---------------------------------------------------------------- secrets
const CANARY = 'conformance-canary-credential-0123456789';
await withServer({ ...Object.fromEntries(CRED_ENV.map((v) => [v, CANARY])), [`${E}_MODE`]: 'write', [`${E}_ALLOW_DESTRUCTIVE`]: 'true' }, async (client) => {
  const names = (await listAll(client)).map((t) => t.name).sort();
  check(JSON.stringify(names) === JSON.stringify(tools.map((t) => t.name).sort()), 'tools/list differs when both gates are open');
  for (const name of [`${P}_status_server`, `${P}_status_gate`]) {
    if (!byName.has(name)) continue;
    const result = await client.callTool({ name, arguments: {} });
    check(!JSON.stringify(result).includes(CANARY), `${name} printed the credential`);
  }
});

// ---------------------------------------------------------------- mutations.json
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(ROOT, MUTATIONS_FILE), 'utf8'));
} catch (error) {
  check(false, `${MUTATIONS_FILE} does not parse: ${error.message}`);
}
if (manifest) {
  check(manifest.server === P, `mutations.json "server" must be "${P}"`);
  check(['verified', 'derived'].includes(manifest.source), 'mutations.json "source" must be verified or derived');
  check(/^\d{4}-\d{2}-\d{2}$/.test(manifest.reviewed ?? ''), 'mutations.json "reviewed" must be an ISO date');
  const entries = manifest.tools ?? {};
  for (const tool of tools) {
    const entry = entries[tool.name];
    if (!check(entry !== undefined, `${tool.name}: not in mutations.json`)) continue;
    const mutating = tool.annotations?.readOnlyHint !== true;
    check(entry.mutating === mutating, `${tool.name}: mutations.json says mutating=${entry.mutating}, annotations say ${mutating}`);
    if (entry.mutating) {
      check(BLAST_RADII.includes(entry.blastRadius), `${tool.name}: blastRadius must be one of ${BLAST_RADII.join(', ')}`);
      check(typeof entry.rollback === 'string' && entry.rollback.length >= 12, `${tool.name}: rollback must say how a person undoes it`);
    }
  }
  for (const name of Object.keys(entries)) check(byName.has(name), `mutations.json lists ${name}, which the server does not register`);
}

// ---------------------------------------------------------------- report
for (const w of warnings) console.log(`warn  ${w}`);
for (const f of failures) console.log(`FAIL  ${f}`);
console.log(`\n${tools.length} tools, ${checks} checks, ${failures.length} failed, ${warnings.length} warnings.`);
process.exit(failures.length === 0 ? 0 : 1);
