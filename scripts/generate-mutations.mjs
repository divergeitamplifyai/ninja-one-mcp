#!/usr/bin/env node
// Generates or refreshes mutations.json (rule M1/M2) from the BUILT server.
//
// Starts the server with both gates open and no credential, reads tools/list, and
// writes one entry per tool: mutating = !readOnlyHint. Existing entries keep their
// blastRadius and rollback (those are reviewed decisions); new mutating tools get a
// derived default from the verb and the destructive hint, and the file's source is
// "derived" until a person reviews it and sets "verified". Tools the server no
// longer registers are dropped.
//
// Usage: npm run build && node scripts/generate-mutations.mjs [server-index]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const CONFIGS = Array.isArray(pkg.mcpServer) ? pkg.mcpServer : [pkg.mcpServer ?? {}];
const indexes = process.argv[2] === undefined ? CONFIGS.map((_, i) => i) : [Number(process.argv[2])];

const ROLLBACK = {
  create: 'Delete the record this call created, with the matching delete tool or in the vendor console.',
  add: 'Remove what this call added, with the matching remove tool or in the vendor console.',
  update: 'Re-apply the prior values (the tool returns them as before where the API allows) or edit them back in the vendor console.',
  set: 'Set the prior value again; the tool returns it as before where the API allows.',
  assign: 'Unassign it again with the matching tool or in the vendor console.',
  unassign: 'Assign it again with the matching tool or in the vendor console.',
  enable: 'Disable it again with the matching tool or in the vendor console.',
  disable: 'Enable it again with the matching tool or in the vendor console.',
  lock: 'Unlock it with the matching unlock tool or in the vendor console.',
  unlock: 'Lock it again with the matching lock tool or in the vendor console.',
  suspend: 'Resume it with the matching resume tool or in the vendor console.',
  resume: 'Suspend or pause it again with the matching tool or in the vendor console.',
  move: 'Move it back to where it was; the tool reports the previous location.',
  rename: 'Rename it back to the previous name the tool reports.',
  invite: 'Revoke or delete the invitation in the vendor console.',
  approve: 'Reject or revoke the approval in the vendor console.',
  reject: 'Approve it again in the vendor console if the request is still open.',
  dismiss: 'Restore the dismissed item with the matching restore tool or in the vendor console.',
  restore: 'Dismiss or remove it again in the vendor console.',
  attach: 'Detach it again with the matching tool or in the vendor console.',
  detach: 'Attach it again with the matching tool or in the vendor console.',
  close: 'Reopen it in the vendor console.',
  reopen: 'Close it again in the vendor console.',
  post: 'Delete or retract the posted entry in the vendor console.',
  upload: 'Delete the uploaded file in the vendor console.',
  import: 'Delete the imported records in the vendor console.',
  sync: 'No undo needed: a sync refreshes derived state; re-run it after correcting the source.',
};
const NO_UNDO = 'Not reversible through the API. The tool returns what it changed or removed; recreate or correct it by hand in the vendor console.';

function defaults(tool, prefix) {
  const verb = tool.name.slice(prefix.length + 1).split('_')[0];
  const destructive = tool.annotations?.destructiveHint === true;
  const n = tool.name;
  const wide = /(_api_write|_ops$|_bulk|_all_|_batch|policy|policies|fleet|org_|_orgs?$|_managed_company|_msp_|_tenant)/.test(n) ||
    /_(delete|update|remove|assign|unassign)_[a-z_]+s$/.test(n);
  const blastRadius = /_managed_compan|_msp_/.test(n) ? 'multi-tenant' : wide ? 'single-tenant' : 'single-object';
  const rollback = destructive ? NO_UNDO : ROLLBACK[verb] ?? 'Reverse the change by hand in the vendor console; the tool returns what it changed.';
  return { blastRadius, rollback };
}

async function listTools(config) {
  const env = { ...getDefaultEnvironment(), ...(config.env ?? {}), [`${config.envPrefix}_MODE`]: 'write', [`${config.envPrefix}_ALLOW_DESTRUCTIVE`]: 'true' };
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, config.entry)], env, stderr: 'pipe' });
  const client = new Client({ name: 'generate-mutations', version: '1.0.0' });
  await client.connect(transport);
  try {
    const tools = [];
    let cursor;
    do {
      const r = await client.listTools(cursor ? { cursor } : {});
      tools.push(...r.tools);
      cursor = r.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close();
  }
}

for (const i of indexes) {
  const config = CONFIGS[i];
  const file = join(ROOT, config.mutations ?? 'mutations.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { tools: {} };
  const tools = (await listTools(config)).sort((a, b) => a.name.localeCompare(b.name));
  const { tools: _t, server: _s, source: _src, reviewed: _r, ...extra } = previous;
  const out = { server: config.toolPrefix, source: previous.source ?? 'derived', reviewed: new Date().toISOString().slice(0, 10), ...extra, tools: {} };
  let added = 0;
  for (const tool of tools) {
    const mutating = tool.annotations?.readOnlyHint !== true;
    const prior = previous.tools?.[tool.name];
    if (!mutating) { out.tools[tool.name] = { mutating: false }; continue; }
    if (prior?.mutating && prior.blastRadius && prior.rollback) {
      out.tools[tool.name] = { mutating: true, blastRadius: prior.blastRadius, rollback: prior.rollback };
    } else {
      out.tools[tool.name] = { mutating: true, ...defaults(tool, config.toolPrefix) };
      added++;
    }
  }
  if (added > 0) out.source = 'derived';
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`${config.mutations ?? 'mutations.json'}: ${tools.length} tools, ${added} new mutating entries with derived defaults.`);
}
