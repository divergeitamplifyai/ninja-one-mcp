/**
 * The one stylesheet every MCP Apps view uses (STANDARD.md V2, LANES.md "View
 * theme"). Put THEME_CSS first in each view's <style>, then only layout rules
 * of the view's own. Do not define colors, fonts or radii anywhere else.
 *
 * How it resolves:
 *  1. Host variables first. MCP Apps hosts set --color-*, --font-*, --border-*
 *     on the view's root (applyHostStyleVariables), so the view matches the
 *     client it is drawn in, light or dark.
 *  2. Without a host value, the DivergeIT design-system tokens, as
 *     light-dark() pairs. Light is the brand: ink #1D1D1F on white, the
 *     neutral ramp, one green accent. Dark is the same ramps reversed.
 *  3. The accent stays DivergeIT green in every host. It is the only place the
 *     brand shows, so it is not taken from the host. Red and yellow are status
 *     only, never decoration.
 *
 * Fonts are never loaded from the network: the host's --font-sans, then
 * Montserrat if the machine has it, then the system stack. Code uses the
 * host's --font-mono, then JetBrains Mono, then the system mono stack.
 *
 * Semantic tokens (the only names views use):
 *   --fg --muted --subtle         text: primary, secondary, tertiary
 *   --bg --card                   page and raised surface
 *   --line --line-strong          hairlines (no shadows)
 *   --accent --accent-fg          the green, and text on it
 *   --ok --warn --bad             status text
 *   --ok-bg --warn-bg --bad-bg --accent-bg   status and accent tints
 *   --focus                       focus ring
 *   --sans --mono                 font stacks
 *   --radius --radius-card --hair control radius (4px), card radius (6px), hairline width
 */

/** DivergeIT tokens the fallbacks use, from design-system dist/tokens.json (v2.1.0). */
export const BRAND = {
  ink: '#1d1d1f',
  inkSoft: '#55585b',
  grey: '#616365',
  white: '#ffffff',
  wash: '#f7f8f7',
  hairline: '#e3e5e4',
  neutral200: '#cdd0cf',
  neutral300: '#b0b4b3',
  neutral400: '#8b8e90',
  neutral700: '#3f4245',
  neutral800: '#2a2c2e',
  neutral950: '#101214',
  green: '#009344',
  green50: '#e6f5ed',
  green300: '#4dbb87',
  green600: '#007a38',
  green900: '#003016',
  red: '#ea2127',
  red100: '#fbdedf',
  red700: '#8f1015',
  yellow: '#fbed23',
  yellow100: '#fefbcf',
  yellow700: '#7a6f00',
} as const;

const b = BRAND;

const FONT_SANS = `"Montserrat", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
const FONT_MONO = `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

export const THEME_CSS = `
:root {
  color-scheme: light dark;
  --fg: var(--color-text-primary, light-dark(${b.ink}, ${b.wash}));
  --muted: var(--color-text-secondary, light-dark(${b.inkSoft}, ${b.neutral300}));
  --subtle: var(--color-text-tertiary, light-dark(${b.grey}, ${b.neutral400}));
  --bg: var(--color-background-primary, light-dark(${b.white}, ${b.neutral950}));
  --card: var(--color-background-secondary, light-dark(${b.wash}, ${b.ink}));
  --line: var(--color-border-tertiary, light-dark(${b.hairline}, ${b.neutral800}));
  --line-strong: var(--color-border-secondary, light-dark(${b.neutral200}, ${b.neutral700}));
  --accent: light-dark(${b.green600}, ${b.green300});
  --accent-fg: light-dark(${b.white}, ${b.neutral950});
  --accent-bg: light-dark(${b.green50}, ${b.green900});
  --ok: var(--color-text-success, light-dark(${b.green600}, ${b.green300}));
  --warn: var(--color-text-warning, light-dark(${b.yellow700}, ${b.yellow}));
  --bad: var(--color-text-danger, light-dark(${b.red700}, ${b.red100}));
  --ok-bg: var(--color-background-success, light-dark(${b.green50}, color-mix(in srgb, ${b.green} 22%, ${b.neutral950})));
  --warn-bg: var(--color-background-warning, light-dark(${b.yellow100}, color-mix(in srgb, ${b.yellow} 16%, ${b.neutral950})));
  --bad-bg: var(--color-background-danger, light-dark(${b.red100}, color-mix(in srgb, ${b.red} 22%, ${b.neutral950})));
  --focus: var(--color-ring-primary, light-dark(${b.green600}, ${b.green300}));
  --sans: var(--font-sans, ${FONT_SANS});
  --mono: var(--font-mono, ${FONT_MONO});
  --radius: var(--border-radius-sm, 4px);
  --radius-card: var(--border-radius-md, 6px);
  --hair: var(--border-width-regular, 1px);
}
[data-theme="light"] { color-scheme: light; }
[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; color: var(--fg); font-family: var(--sans); font-size: var(--font-text-sm-size, 14px); line-height: var(--font-text-sm-line-height, 1.45); -webkit-font-smoothing: antialiased; }
body { padding: 12px 4px; }
h1 { font-size: var(--font-heading-md-size, 16px); font-weight: 600; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
h2 { font-size: 12px; font-weight: 600; margin: 16px 0 6px; color: var(--subtle); text-transform: uppercase; letter-spacing: .08em; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
code, pre, .mono { font-family: var(--mono); font-size: 12px; }
.muted { color: var(--muted); } .subtle { color: var(--subtle); }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.card { background: var(--card); border: var(--hair) solid var(--line); border-radius: var(--radius-card); padding: 10px 12px; box-shadow: none; }
.card .title { font-weight: 600; display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.card .meta { color: var(--subtle); font-size: 12px; margin-top: 4px; }
.card .big { font-size: 22px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; background: var(--card); color: var(--muted); border: var(--hair) solid var(--line); white-space: nowrap; }
.badge.ok { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
.badge.warn { background: var(--warn-bg); color: var(--warn); border-color: transparent; }
.badge.bad { background: var(--bad-bg); color: var(--bad); border-color: transparent; }
.badge.accent { background: var(--accent-bg); color: var(--accent); border-color: transparent; }
.tablewrap { max-height: 480px; overflow: auto; border: var(--hair) solid var(--line); border-radius: var(--radius-card); }
table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 6px 8px; border-bottom: var(--hair) solid var(--line); white-space: nowrap; }
td.wrap { white-space: normal; }
th { position: sticky; top: 0; z-index: 1; background: var(--bg); color: var(--subtle); font-weight: 500; font-size: 12px; }
th.sorted { color: var(--fg); box-shadow: inset 0 -2px 0 var(--accent); }
tr:hover td { background: var(--card); }
input, select, button { font: inherit; color: inherit; background: var(--bg); border: var(--hair) solid var(--line-strong); border-radius: var(--radius); padding: 6px 10px; min-height: 32px; }
button { cursor: pointer; font-weight: 600; }
button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
button.danger { background: var(--bad-bg); color: var(--bad); border-color: var(--bad); }
button:disabled { opacity: .5; cursor: default; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.empty, .error { padding: 20px; text-align: center; border: var(--hair) dashed var(--line); border-radius: var(--radius-card); }
.empty { color: var(--muted); }
.error { color: var(--bad); background: var(--bad-bg); border-style: solid; border-color: transparent; }
@media (pointer: coarse) { button, input, select { min-height: 44px; } }
`;
