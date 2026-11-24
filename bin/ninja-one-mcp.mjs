#!/usr/bin/env node
// Launcher. Runs the compiled server (dist/, present in the npm package and
// after `npm run build`) or, in a git checkout without a build, the committed
// single-file bundle. Either way `npx -y github:divergeitamplifyai/ninja-one-mcp`
// starts without a build step.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist', 'index.js');
const bundle = join(root, 'plugins', 'ninjaone', 'server', 'ninja-one-mcp.mjs');
await import(pathToFileURL(existsSync(dist) ? dist : bundle).href);
