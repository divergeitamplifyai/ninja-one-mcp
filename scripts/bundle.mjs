#!/usr/bin/env node
// Bundles the built server into one self-contained file for the plugins and
// the .mcpb, so they start with plain `node` and no install step:
//
//   plugins/ninjaone/server/ninja-one-mcp.mjs   (+ llms.txt beside it)
//
// The bundle is committed so a plugin installed from GitHub works as cloned.
// CI rebuilds it and fails on drift.
//
// Usage: npm run build && node scripts/bundle.mjs [--check]

import { build } from 'esbuild';
import { copyFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'plugins/ninjaone/server');
const OUT = join(OUT_DIR, 'ninja-one-mcp.mjs');
const check = process.argv.includes('--check');

const result = await build({
  entryPoints: [join(ROOT, 'dist/index.js')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
  legalComments: 'eof',
  logLevel: 'warning',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
const code = result.outputFiles[0].text;

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  const llms = existsSync(join(OUT_DIR, 'llms.txt')) ? readFileSync(join(OUT_DIR, 'llms.txt'), 'utf8') : '';
  if (current !== code || llms !== readFileSync(join(ROOT, 'llms.txt'), 'utf8')) {
    console.error('plugins/ninjaone/server is out of date. Run npm run bundle and commit it.');
    process.exit(1);
  }
  console.log('Plugin bundle is current.');
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT, code);
  copyFileSync(join(ROOT, 'llms.txt'), join(OUT_DIR, 'llms.txt'));
  console.log(`Wrote ${OUT.slice(ROOT.length + 1)} (${(code.length / 1024).toFixed(0)} KB).`);
}
