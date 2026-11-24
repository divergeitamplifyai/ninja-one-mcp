#!/usr/bin/env node
// Packs the Claude Desktop bundle (.mcpb, a zip with manifest.json at its root)
// from the self-contained server bundle. No node_modules: the server is one file.
//
//   packaging/mcpb/manifest.json  -> manifest.json
//   packaging/mcpb/icon.png -> icon.png
//   plugins/ninjaone/server/      -> server/
//   LICENSE, README.md
//
// Usage: npm run bundle && node scripts/pack-mcpb.mjs [output.mcpb]

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(ROOT, process.argv[2] ?? 'build/ninja-one-mcp.mcpb');
const manifest = JSON.parse(readFileSync(join(ROOT, 'packaging/mcpb/manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`manifest version ${manifest.version} != package.json ${pkg.version}`);

const stage = mkdtempSync(join(tmpdir(), 'ninjaone-mcpb-'));
try {
  const copy = (from, to) => {
    if (!existsSync(join(ROOT, from))) throw new Error(`${from} is missing; run npm run bundle first`);
    cpSync(join(ROOT, from), join(stage, to), { recursive: true });
  };
  copy('packaging/mcpb/manifest.json', 'manifest.json');
  copy('packaging/mcpb/icon.png', 'icon.png');
  copy('plugins/ninjaone/server', 'server');
  copy('LICENSE', 'LICENSE');
  copy('README.md', 'README.md');
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  execFileSync('zip', ['-qr', '-X', output, '.'], { cwd: stage });
  console.log(`Packed ${output.slice(ROOT.length + 1)}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
