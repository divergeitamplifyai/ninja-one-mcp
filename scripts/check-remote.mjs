#!/usr/bin/env node
// Lane check against LANES.md and STANDARD.md T3. Static: reads the committed
// files, runs nothing, needs no network and no build.
//
//   layout     every fixed lane path exists
//   defaults   committed deploy config is read only (wrangler vars, azd
//              parameters, Bicep defaults) and scales to zero
//   identity   no account ids, emails, tenant ids or personal hostnames in
//              committed deploy config
//   image      every FROM is digest pinned, the runtime is non-root, and the
//              image sets no inbound auth mode of its own
//   workflows  SHA-pinned actions, top-level permissions, deploy workflows
//              are workflow_dispatch only, use an environment, and are off
//              unless their repository variable is "true"; Azure uses OIDC
//   gitignore  local deploy settings are ignored
//
// Usage: node scripts/check-remote.mjs

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const E = pkg.mcpServer?.envPrefix;
if (!E) {
  console.error('package.json needs mcpServer.envPrefix.');
  process.exit(1);
}

const failures = [];
let checks = 0;
function check(ok, message) {
  checks++;
  if (!ok) failures.push(message);
  return ok;
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------- layout
const REQUIRED = [
  'LANES.md',
  'azure.yaml',
  'infra/main.bicep',
  'infra/main.parameters.json',
  'infra/modules',
  'Dockerfile',
  '.dockerignore',
  'wrangler.jsonc',
  'src/http/main.ts',
  'src/http/server.ts',
  'src/worker/index.ts',
  'src/remote/auth.ts',
  'src/remote/handler.ts',
  'src/remote/settings.ts',
  'src/apps/theme.ts',
  'docs/deploy-azure.md',
  'docs/deploy-cloudflare.md',
  '.github/workflows/ci.yml',
  '.github/workflows/deploy-azure.yml',
  '.github/workflows/deploy-cloudflare.yml',
];
for (const rel of REQUIRED) check(existsSync(join(ROOT, rel)), `missing lane file ${rel} (LANES.md, "Layout")`);
const present = (rel) => existsSync(join(ROOT, rel));

// ---------------------------------------------------------------- wrangler.jsonc
/** Strip // and /* *\/ comments and trailing commas, leaving strings intact. */
function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

if (present('wrangler.jsonc')) {
  let wrangler;
  try {
    wrangler = parseJsonc(read('wrangler.jsonc'));
  } catch (error) {
    check(false, `wrangler.jsonc does not parse: ${error.message}`);
  }
  if (wrangler) {
    check(wrangler.main === 'src/worker/index.ts', 'wrangler.jsonc "main" must be src/worker/index.ts');
    const blocks = [['top level', wrangler], ...Object.entries(wrangler.env ?? {}).map(([name, block]) => [`env.${name}`, block])];
    check(blocks.length >= 3 && wrangler.env?.staging && wrangler.env?.production, 'wrangler.jsonc needs env.staging and env.production');
    for (const [where, block] of blocks) {
      check(!('account_id' in block), `wrangler.jsonc ${where}: no account_id in committed config (use CLOUDFLARE_ACCOUNT_ID or wrangler.local.jsonc)`);
      for (const key of ['route', 'routes']) check(!(key in block), `wrangler.jsonc ${where}: no ${key} in committed config (hostnames go in wrangler.local.jsonc)`);
      const vars = block.vars ?? {};
      check(vars[`${E}_MODE`] === 'read', `wrangler.jsonc ${where}: vars.${E}_MODE must be "read"`);
      check(vars[`${E}_ALLOW_DESTRUCTIVE`] === 'false', `wrangler.jsonc ${where}: vars.${E}_ALLOW_DESTRUCTIVE must be "false"`);
      check(['bearer', 'access'].includes(vars.MCP_HTTP_AUTH), `wrangler.jsonc ${where}: vars.MCP_HTTP_AUTH must be bearer or access`);
      for (const secret of ['MCP_BEARER_TOKEN', `${E}_API_KEY`]) check(!(secret in vars), `wrangler.jsonc ${where}: ${secret} is a secret, not a var (wrangler secret put)`);
      for (const tied of ['MCP_ACCESS_TEAM_DOMAIN', 'MCP_ACCESS_AUD']) check(!vars[tied], `wrangler.jsonc ${where}: ${tied} is account specific; pass it at deploy time`);
    }
  }
}

// ---------------------------------------------------------------- azd and Bicep defaults
if (present('infra/main.parameters.json')) {
  const params = read('infra/main.parameters.json');
  check(params.includes(`\${${E}_MODE=read}`), `infra/main.parameters.json: mode must default to \${${E}_MODE=read}`);
  check(params.includes(`\${${E}_ALLOW_DESTRUCTIVE=false}`), `infra/main.parameters.json: allowDestructive must default to \${${E}_ALLOW_DESTRUCTIVE=false}`);
}
if (present('infra/main.bicep')) {
  const main = read('infra/main.bicep');
  check(/param mode string = 'read'/.test(main), "infra/main.bicep: param mode must default to 'read'");
  check(/param allowDestructive string = 'false'/.test(main), "infra/main.bicep: param allowDestructive must default to 'false'");
  check(/param minReplicas int = 0/.test(main), 'infra/main.bicep: param minReplicas must default to 0');
}
if (present('infra/modules')) {
  const modules = readdirSync(join(ROOT, 'infra/modules')).filter((f) => f.endsWith('.bicep'));
  check(modules.length > 0, 'infra/modules has no .bicep file');
  const all = modules.map((f) => read(`infra/modules/${f}`)).join('\n');
  check(/allowInsecure:\s*false/.test(all), 'infra/modules: Container Apps ingress must set allowInsecure: false');
  check(/UserAssigned/.test(all), 'infra/modules: the app must use a user-assigned identity');
  check(/keyVaultUrl:/.test(all), 'infra/modules: secrets must be Key Vault references (keyVaultUrl)');
  check(!/adminUserEnabled:\s*true/.test(all), 'infra/modules: registry admin user must stay off');
}

// ---------------------------------------------------------------- identity scan
function walk(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [rel];
  return readdirSync(abs).flatMap((f) => walk(join(rel, f)));
}
const DEPLOY_FILES = ['wrangler.jsonc', 'azure.yaml', 'Dockerfile', ...walk('infra'), ...walk('.github/workflows')];
// Public, well-known ids: Azure built-in role definitions and the VS Code client id.
const KNOWN_IDS = new Set(['4633458b-17de-408a-b874-0445c86b69e6', '7f951dda-4ed3-4680-a7ca-43fe172d538d', 'aebc6443-996d-45c2-90f0-388ff96faa56']);
const ALLOWED_DOMAINS = /(^|\.)(example\.(com|org|net)|test\.invalid|invalid|localhost)$/i;
for (const rel of DEPLOY_FILES) {
  const text = read(rel);
  for (const m of text.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) {
    check(KNOWN_IDS.has(m[0].toLowerCase()), `${rel}: GUID ${m[0]} looks like a tenant, subscription or client id; take it from the environment`);
  }
  for (const m of text.matchAll(/\b[0-9a-f]{32}\b/gi)) check(false, `${rel}: ${m[0].slice(0, 6)}... looks like a Cloudflare account id; use CLOUDFLARE_ACCOUNT_ID`);
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g)) {
    const domain = m[0].split('@')[1];
    check(ALLOWED_DOMAINS.test(domain), `${rel}: email address ${m[0]} in committed deploy config`);
  }
  for (const m of text.matchAll(/\b([a-z0-9-]+)\.(cloudflareaccess\.com|workers\.dev|azurecontainerapps\.io)\b/gi)) {
    // A placeholder such as <team>.cloudflareaccess.com is fine; a concrete subdomain is not.
    check(/^(team|your-?team)$/i.test(m[1]), `${rel}: hostname ${m[0]} is tied to an account`);
  }
}

// ---------------------------------------------------------------- Dockerfile
if (present('Dockerfile')) {
  const docker = read('Dockerfile');
  const froms = [...docker.matchAll(/^FROM\s+(\S+)/gim)].map((m) => m[1]);
  check(froms.length >= 2, 'Dockerfile must be multi-stage');
  for (const from of froms) check(/@sha256:[0-9a-f]{64}$/.test(from), `Dockerfile: FROM ${from} must be pinned by digest`);
  check(/distroless/.test(froms.at(-1) ?? ''), 'Dockerfile: the runtime stage must be distroless');
  const users = [...docker.matchAll(/^USER\s+(\S+)/gim)].map((m) => m[1]);
  check(users.at(-1) === 'nonroot', 'Dockerfile: the last USER must be nonroot');
  check(!/MCP_HTTP_AUTH\s*=|MCP_BEARER_TOKEN\s*=/.test(docker.replace(/^#.*$/gm, '')), 'Dockerfile: auth settings come from the deployment, not the image');
}

// ---------------------------------------------------------------- workflows
function workflow(rel) {
  return present(rel) ? read(rel) : '';
}
for (const rel of walk('.github/workflows').filter((f) => /\.ya?ml$/.test(f))) {
  const text = workflow(rel);
  check(/^permissions:/m.test(text), `${rel}: top-level permissions are required`);
  check(!/^permissions:\s*write-all/m.test(text), `${rel}: write-all permissions are not allowed`);
  for (const m of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
    const ref = m[1];
    if (ref.startsWith('./')) continue;
    check(/@[0-9a-f]{40}$/.test(ref), `${rel}: ${ref} must be pinned to a full commit SHA`);
  }
}
const ci = workflow('.github/workflows/ci.yml');
if (ci) {
  check(/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(ci), 'ci.yml: permissions must be exactly contents: read');
  check(/pull_request/.test(ci), 'ci.yml: must run on pull_request');
  check(/npm ci\b/.test(ci) && /npm run check/.test(ci), 'ci.yml: must install from the lockfile and run npm run check');
  check(/node-version-file:/.test(ci), 'ci.yml: Node must come from .nvmrc (node-version-file)');
}
for (const [rel, variable] of [
  ['.github/workflows/deploy-azure.yml', 'DEPLOY_AZURE_ENABLED'],
  ['.github/workflows/deploy-cloudflare.yml', 'DEPLOY_CLOUDFLARE_ENABLED'],
]) {
  const text = workflow(rel);
  if (!text) continue;
  const on = /^on:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m.exec(text)?.[1] ?? '';
  const triggers = [...on.matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]);
  check(triggers.length === 1 && triggers[0] === 'workflow_dispatch', `${rel}: the only trigger must be workflow_dispatch (got ${triggers.join(', ') || 'none'})`);
  check(new RegExp(`^\\s+if:\\s*vars\\.${variable}\\s*==\\s*'true'`, 'm').test(text), `${rel}: every job must be gated with if: vars.${variable} == 'true'`);
  check(/^\s+environment:\s*\S/m.test(text), `${rel}: deploy jobs must run in a GitHub environment`);
  check(/^permissions:\s*\n\s+contents:\s*read/m.test(text), `${rel}: permissions must start from contents: read`);
}
const azure = workflow('.github/workflows/deploy-azure.yml');
if (azure) {
  check(/id-token:\s*write/.test(azure) && /federated-credential-provider/.test(azure), 'deploy-azure.yml: sign in with OIDC (id-token: write, federated credential)');
  check(!/AZURE_CLIENT_SECRET|creds:/.test(azure), 'deploy-azure.yml: no client secret; use OIDC');
}

// ---------------------------------------------------------------- gitignore
const gitignore = present('.gitignore') ? read('.gitignore') : '';
for (const entry of ['.env', '.dev.vars', 'wrangler.local.jsonc', '.azure/']) {
  check(gitignore.split('\n').some((line) => line.trim() === entry), `.gitignore must cover ${entry}`);
}

// ---------------------------------------------------------------- report
for (const f of failures) console.log(`FAIL  ${f}`);
console.log(`\nlanes: ${checks} checks, ${failures.length} failed.`);
process.exit(failures.length === 0 ? 0 : 1);
