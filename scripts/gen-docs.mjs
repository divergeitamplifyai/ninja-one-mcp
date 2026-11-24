#!/usr/bin/env node
// Inline llms.txt (the NinjaOne docs index) into a TypeScript module, so the
// ninjaone://docs/llms.txt resource works on every lane, including the
// Cloudflare Worker, which has no file system to read it from.
//
// Usage: node scripts/gen-docs.mjs [--check]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'generated', 'llms.ts');
const CHECK = process.argv.includes('--check');

const text = readFileSync(join(ROOT, 'llms.txt'), 'utf8');
const content = `// GENERATED FILE: do not edit. Regenerate with \`npm run gen:docs\` after changing llms.txt.
export const LLMS_TXT = ${JSON.stringify(text)};
`;

const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
if (current === content) {
  console.error('gen-docs: src/generated/llms.ts is current');
} else if (CHECK) {
  console.error('gen-docs: src/generated/llms.ts is out of date; run `npm run gen:docs`');
  process.exit(1);
} else {
  writeFileSync(OUT, content);
  console.error('gen-docs: wrote src/generated/llms.ts');
}
