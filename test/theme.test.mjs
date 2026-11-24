// The shared view theme (src/apps/theme.ts): one CSS string, host variables
// first, DivergeIT fallbacks, no network fonts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND, THEME_CSS } from '../dist/apps/theme.js';

const SEMANTIC = ['--fg', '--muted', '--subtle', '--bg', '--card', '--line', '--accent', '--ok', '--warn', '--bad', '--ok-bg', '--warn-bg', '--bad-bg', '--sans', '--mono'];

test('every semantic token is defined once', () => {
  for (const token of SEMANTIC) {
    const count = THEME_CSS.split(`\n  ${token}:`).length - 1;
    assert.equal(count, 1, token);
  }
});

test('host variables come first, DivergeIT tokens are the light-dark fallback', () => {
  assert.match(THEME_CSS, /--fg: var\(--color-text-primary, light-dark\(#1d1d1f, /);
  assert.match(THEME_CSS, /--bg: var\(--color-background-primary, light-dark\(#ffffff, /);
  assert.match(THEME_CSS, /--sans: var\(--font-sans, "Montserrat", system-ui/);
  assert.match(THEME_CSS, /--mono: var\(--font-mono, "JetBrains Mono"/);
  assert.match(THEME_CSS, new RegExp(`--accent: light-dark\\(${BRAND.green600}`));
  assert.match(THEME_CSS, /--radius: var\(--border-radius-sm, 4px\)/);
  assert.match(THEME_CSS, /--radius-card: var\(--border-radius-md, 6px\)/);
});

test('nothing loads from the network and nothing casts a shadow', () => {
  assert.equal(/@import|url\(|https?:\/\//i.test(THEME_CSS), false);
  assert.equal(/box-shadow:\s*0/.test(THEME_CSS), false);
});

test('the views use THEME_CSS and define no palette or fonts of their own', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/tools/views.ts', import.meta.url), 'utf8');
  const css = source.slice(source.indexOf('const CSS = `'), source.indexOf('`;', source.indexOf('const CSS = `')));
  assert.match(css, /^const CSS = `\$\{THEME_CSS\}/);
  assert.equal(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|font-family|@import|url\(/i.test(css), false);
});
