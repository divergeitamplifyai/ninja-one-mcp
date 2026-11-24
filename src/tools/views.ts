/**
 * Interactive views (MCP Apps, STANDARD.md V1).
 *
 * A view is a read tool whose result the host renders as an HTML page in a
 * sandboxed iframe. Hosts without MCP Apps get the same data as JSON. Buttons
 * in a view call this server's own tools through the host, so a button can
 * never do more than the model could, and the write gate binds it the same way.
 *
 *  - ninjaone_view_fleet    every organization at a glance (report_fleet_health)
 *  - ninjaone_view_device   one device in depth (get_device_profile)
 *  - ninjaone_view_alerts   open alerts with a Reset button (gated write)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SERVER_VERSION, TOOL_PREFIX } from '../constants.js';
import { APP_RUNTIME } from '../generated/app-runtime.js';
import { defineTool, type ToolContext } from '../spec.js';

const P = TOOL_PREFIX;
export const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

const CSS = `
:root{color-scheme:light dark;--fg:var(--color-text-primary,light-dark(#111,#f4f4f2));--muted:var(--color-text-secondary,light-dark(#555,#b8b8b2));--subtle:var(--color-text-tertiary,light-dark(#777,#8f8f88));--card:var(--color-background-secondary,light-dark(#f6f6f4,#262624));--line:var(--color-border-tertiary,light-dark(rgb(0 0 0/12%),rgb(255 255 255/12%)));--ok:var(--color-text-success,light-dark(#1f6b2a,#7cc187));--warn:var(--color-text-warning,light-dark(#7a5a00,#e0b34a));--bad:var(--color-text-danger,light-dark(#a1261f,#f08a84));--accent:var(--color-text-info,light-dark(#2457c5,#8bb1ff));--r:var(--border-radius-lg,10px)}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--fg);font:14px/1.45 var(--font-sans,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif);-webkit-font-smoothing:antialiased}
body{padding:12px 4px}h1{font-size:16px;font-weight:600;margin:0 0 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
h2{font-size:12px;font-weight:500;color:var(--subtle);letter-spacing:.04em;text-transform:uppercase;margin:16px 0 6px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.kpi{background:var(--card);border-radius:var(--r);padding:10px 12px}
.kpi .n{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}.kpi .l{color:var(--subtle);font-size:12px}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;background:var(--card);color:var(--muted)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.wrap{overflow:auto;max-height:460px;border:.5px solid var(--line);border-radius:var(--r)}table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:.5px solid var(--line);white-space:nowrap}th{position:sticky;top:0;background:var(--color-background-primary,Canvas);color:var(--subtle);font-weight:500;font-size:12px;cursor:pointer}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}tr.click{cursor:pointer}tr.click:hover td{background:var(--card)}
input,button{font:inherit;color:inherit;background:transparent;border:.5px solid var(--line);border-radius:8px;padding:5px 10px;min-height:30px}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}
.bar{display:flex;gap:8px;align-items:center;margin:0 0 8px}.muted{color:var(--muted)}.note{font-size:13px;color:var(--muted);margin:8px 0}.err{color:var(--bad);padding:16px}
.meter{height:6px;border-radius:3px;background:var(--line);overflow:hidden;min-width:80px}.meter i{display:block;height:100%;background:var(--accent)}.meter i.hot{background:var(--bad)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 14px;margin:0;font-size:13px}dt{color:var(--subtle)}dd{margin:0}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}.card{background:var(--card);border-radius:var(--r);padding:10px 12px}
`;

const BOOT = `
const { App, applyHostStyleVariables, applyHostFonts, applyDocumentTheme } = globalThis.__mcpApps;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (v) => (v === null || v === undefined ? '-' : Number(v).toLocaleString());
const gb = (b) => (b ? (Number(b) / 1073741824).toFixed(1) + ' GB' : '-');
function ctx(c){ if(!c) return; if(c.theme) applyDocumentTheme(c.theme); if(c.styles?.variables) applyHostStyleVariables(c.styles.variables); if(c.styles?.css?.fonts) applyHostFonts(c.styles.css.fonts); }
function data(r){ if(r.structuredContent) return r.structuredContent; const t=(r.content??[]).find(p=>p.type==='text')?.text; if(r.isError) throw new Error(t??'tool failed'); try{return JSON.parse(t??'null')}catch{return t} }
function sortable(root){ root.querySelectorAll('table').forEach((t)=>{ t.querySelectorAll('th').forEach((th,i)=>{ th.onclick=()=>{ const rows=[...t.tBodies[0].rows]; const asc=th.dataset.asc!=='1'; th.dataset.asc=asc?'1':'0'; rows.sort((a,b)=>{const x=a.cells[i].dataset.v??a.cells[i].textContent, y=b.cells[i].dataset.v??b.cells[i].textContent; const n=parseFloat(x)-parseFloat(y); const c=isNaN(n)?String(x).localeCompare(String(y)):n; return asc?c:-c}); rows.forEach(r=>t.tBodies[0].appendChild(r)); }; }); }); }
async function boot(render){
  const root=document.getElementById('app');
  const view={ data:null, input:{} };
  const app=new App({ name:'ninja-one-mcp', version:${JSON.stringify(SERVER_VERSION)} }, {}, { autoResize:true });
  view.call=async(name,args)=>data(await app.callServerTool({ name, arguments:args }));
  view.ask=async(text)=>{ try{ await app.sendMessage({ role:'user', content:[{ type:'text', text }] }); }catch(e){ console.error(e); } };
  const draw=()=>{ try{ render(root,view); sortable(root); }catch(e){ root.innerHTML='<div class="err">'+esc(e.message)+'</div>'; } };
  view.redraw=draw;
  app.ontoolinput=(p)=>{ view.input=p.arguments??{}; };
  app.ontoolresult=(p)=>{ try{ view.data=data(p); }catch(e){ root.innerHTML='<div class="err">'+esc(e.message)+'</div>'; return; } draw(); };
  app.onhostcontextchanged=ctx;
  await app.connect(); ctx(app.getHostContext());
}
`;

function page(title: string, script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><style>${CSS}</style></head><body><div id="app"><div class="note">Loading...</div></div><script type="module">\n${APP_RUNTIME}\n${BOOT}\n${script}\n</script></body></html>`;
}

const FLEET_JS = `
boot((root, view) => {
  const d = view.data ?? {}; const items = d.items ?? [];
  const sum = (k) => items.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  root.innerHTML = '<h1>Fleet health <span class="badge">' + items.length + ' organizations</span>' + (d.failed ? '<span class="badge bad">' + d.failed + ' failed</span>' : '') + '</h1>'
    + '<div class="kpis">' + [['devices','Devices'],['offline','Offline'],['os_patches_pending','Patches pending'],['os_patches_failed','Patches failed'],['active_alerts','Active alerts'],['av_threats','AV threats']]
      .map(([k,l]) => '<div class="kpi"><div class="n ' + (k !== 'devices' && sum(k) > 0 ? 'warn' : '') + '">' + num(sum(k)) + '</div><div class="l">' + l + '</div></div>').join('') + '</div>'
    + (d.warning ? '<div class="note">' + esc(d.warning) + '</div>' : '')
    + '<h2>By organization</h2><div class="bar"><input type="search" placeholder="Filter organizations" id="q"></div>'
    + '<div class="wrap"><table><thead><tr><th>Organization</th><th class="num">Devices</th><th class="num">Offline</th><th>Offline share</th><th class="num">Patches pending</th><th class="num">Failed</th><th class="num">Alerts</th><th class="num">AV threats</th></tr></thead><tbody>'
    + items.map((r) => { const share = r.devices ? Math.round((r.offline / r.devices) * 100) : 0;
        return r.ok === false ? '<tr><td>' + esc(r.org_name) + '</td><td colspan="7" class="bad">' + esc(String(r.error).split('\\n')[0]) + '</td></tr>'
        : '<tr class="click" data-org="' + esc(r.org_id) + '" data-name="' + esc(r.org_name) + '"><td>' + esc(r.org_name) + '</td><td class="num">' + num(r.devices) + '</td><td class="num ' + (r.offline ? 'warn' : '') + '" data-v="' + r.offline + '">' + num(r.offline) + '</td>'
        + '<td data-v="' + share + '"><div class="meter"><i class="' + (share > 20 ? 'hot' : '') + '" style="width:' + share + '%"></i></div></td>'
        + '<td class="num">' + num(r.os_patches_pending) + '</td><td class="num ' + (r.os_patches_failed ? 'bad' : '') + '">' + num(r.os_patches_failed) + '</td><td class="num">' + num(r.active_alerts) + '</td><td class="num ' + (r.av_threats ? 'bad' : '') + '">' + num(r.av_threats) + '</td></tr>'; }).join('')
    + '</tbody></table></div><div class="note">Select a row to ask for that organization\\'s offline devices.</div>';
  root.querySelector('#q').oninput = (e) => { const q = e.target.value.toLowerCase(); root.querySelectorAll('tbody tr').forEach((tr) => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; }); };
  root.querySelectorAll('tr.click').forEach((tr) => { tr.onclick = () => view.ask('List the offline devices in ' + tr.dataset.name + ' (organization ' + tr.dataset.org + ') with ${P}_list_devices and df "org = ' + tr.dataset.org + ' AND offline".'); });
});`;

const DEVICE_JS = `
boot((root, view) => {
  const d = view.data ?? {}; const dev = d.device ?? {}; const sys = dev.system ?? {}; const os = dev.os ?? {};
  const list = (v) => Array.isArray(v) ? v : (v && typeof v === 'object' && !v.error ? (Object.values(v).find(Array.isArray) ?? []) : []);
  const vols = list(d.volumes); const alerts = list(d.alerts); const p = d.patches ?? {};
  const name = dev.displayName || dev.systemName || ('Device ' + (dev.id ?? ''));
  root.innerHTML = '<h1>' + esc(name) + ' <span class="badge ' + (dev.offline ? 'bad' : 'ok') + '">' + (dev.offline ? 'Offline' : 'Online') + '</span><span class="badge">' + esc(dev.nodeClass ?? '') + '</span></h1>'
    + '<div class="grid2"><div class="card"><dl>'
    + [['Organization', dev.organizationId], ['Location', dev.locationId], ['OS', os.name ?? dev.os], ['Build', os.buildNumber], ['Manufacturer', sys.manufacturer], ['Model', sys.model], ['Serial', sys.serialNumber], ['Last contact', dev.lastContact ? new Date(dev.lastContact * 1000).toLocaleString() : null], ['Last user', d.last_logged_on_user?.userName ?? null]]
      .filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>').join('') + '</dl></div>'
    + '<div class="kpis"><div class="kpi"><div class="n ' + (alerts.length ? 'warn' : '') + '">' + alerts.length + '</div><div class="l">Active alerts</div></div>'
    + '<div class="kpi"><div class="n">' + num(p.os?.total) + '</div><div class="l">OS patches open</div></div>'
    + '<div class="kpi"><div class="n">' + num(p.software?.total) + '</div><div class="l">Software patches open</div></div></div></div>'
    + '<h2>Volumes</h2><div class="wrap"><table><thead><tr><th>Name</th><th>File system</th><th class="num">Capacity</th><th class="num">Free</th><th>Used</th></tr></thead><tbody>'
    + vols.map((v) => { const used = v.capacity ? Math.round(((v.capacity - (v.freeSpace ?? 0)) / v.capacity) * 100) : 0; return '<tr><td>' + esc(v.name ?? v.label) + '</td><td>' + esc(v.fileSystem) + '</td><td class="num" data-v="' + (v.capacity ?? 0) + '">' + gb(v.capacity) + '</td><td class="num" data-v="' + (v.freeSpace ?? 0) + '">' + gb(v.freeSpace) + '</td><td data-v="' + used + '"><div class="meter"><i class="' + (used > 90 ? 'hot' : '') + '" style="width:' + used + '%"></i></div></td></tr>'; }).join('')
    + '</tbody></table></div>'
    + (alerts.length ? '<h2>Alerts</h2><div class="wrap"><table><thead><tr><th>Severity</th><th>Message</th><th>Since</th></tr></thead><tbody>' + alerts.map((a) => '<tr><td>' + esc(a.severity) + '</td><td>' + esc(a.message) + '</td><td>' + (a.createTime ? new Date(a.createTime * 1000).toLocaleString() : '-') + '</td></tr>').join('') + '</tbody></table></div>' : '')
    + (d.warning ? '<div class="note">' + esc(d.warning) + '</div>' : '');
});`;

const ALERTS_JS = `
boot((root, view) => {
  const d = view.data ?? {}; const items = d.items ?? []; const gate = d.gate ?? {};
  const sev = {}; items.forEach((a) => { sev[a.severity ?? 'NONE'] = (sev[a.severity ?? 'NONE'] ?? 0) + 1; });
  root.innerHTML = '<h1>Active alerts <span class="badge">' + items.length + '</span>' + Object.entries(sev).map(([k, n]) => '<span class="badge ' + (k === 'CRITICAL' ? 'bad' : k === 'MAJOR' ? 'warn' : '') + '">' + n + ' ' + esc(k.toLowerCase()) + '</span>').join('') + '</h1>'
    + (gate.write ? '' : '<div class="note">Read mode: Reset is disabled until NINJAONE_MODE=write.</div>')
    + '<div class="wrap"><table><thead><tr><th>Severity</th><th>Device</th><th>Message</th><th>Source</th><th>Since</th><th></th></tr></thead><tbody>'
    + items.map((a) => '<tr><td>' + esc(a.severity) + '</td><td>' + esc(a.deviceId) + '</td><td style="white-space:normal;max-width:420px">' + esc(a.message) + '</td><td>' + esc(a.sourceType) + '</td><td data-v="' + (a.createTime ?? 0) + '">' + (a.createTime ? new Date(a.createTime * 1000).toLocaleString() : '-') + '</td><td><button data-uid="' + esc(a.uid) + '"' + (gate.write ? '' : ' disabled') + '>Reset</button></td></tr>').join('')
    + '</tbody></table></div>';
  root.querySelectorAll('button[data-uid]').forEach((b) => { b.onclick = async () => {
    if (!confirm('Reset this alert? If the condition is still true it will trigger again.')) return;
    b.disabled = true; b.textContent = 'Resetting';
    try { await view.call('${P}_reset_alert', { alert_uid: b.dataset.uid, confirm: true }); b.textContent = 'Reset'; b.closest('tr').style.opacity = .5; }
    catch (e) { b.textContent = 'Failed'; b.title = e.message; }
  }; });
});`;

interface ViewSpec {
  noun: string;
  title: string;
  description: string;
  script: string;
  inputSchema: Record<string, z.ZodType>;
  load: (args: Record<string, unknown>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}

/** Run another read tool's handler (validated arguments are the caller's responsibility). */
async function callTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reader = ctx.readers.get(name);
  if (!reader) throw new Error(`${name} is not registered`);
  return (await reader(args, ctx)) as Record<string, unknown>;
}

export function registerViewTools(server: McpServer, ctx: ToolContext): void {
  const views: ViewSpec[] = [
    {
      noun: 'fleet',
      title: 'NinjaOne fleet health',
      description:
        `Interactive fleet health: totals and one row per organization (devices, offline share, patches pending and failed, alerts, AV threats), ` +
        `sortable and filterable; selecting a row asks for that client's offline devices. Same data as ${P}_report_fleet_health, which hosts without MCP Apps receive as JSON.`,
      script: FLEET_JS,
      inputSchema: {
        org: z.string().min(1).optional().describe('One organization (id or unique name part). Omit for every organization in scope.'),
        max_orgs: z.number().int().min(1).max(500).optional().describe('Stop after this many organizations. Default 100.'),
      },
      load: (args) => callTool(ctx, `${P}_report_fleet_health`, args),
    },
    {
      noun: 'device',
      title: 'NinjaOne device',
      description: `Interactive device page: status, OS and hardware, volumes with usage meters, open patches and active alerts. Same data as ${P}_get_device_profile.`,
      script: DEVICE_JS,
      inputSchema: { device_id: z.number().int().describe('Device id.') },
      load: (args) => callTool(ctx, `${P}_get_device_profile`, args),
    },
    {
      noun: 'alerts',
      title: 'NinjaOne alerts',
      description:
        `Interactive list of active alerts with severity counts and a Reset button per alert. Reset calls ${P}_reset_alert, which needs ` +
        `NINJAONE_MODE=write and is confirmed in the view. Same rows as ${P}_list_alerts.`,
      script: ALERTS_JS,
      inputSchema: { df: z.string().min(1).optional().describe('NinjaOne device filter, e.g. "org = 12".') },
      load: async (args, c) => {
        const list = await callTool(c, `${P}_list_alerts`, { ...args, limit: 500 });
        return { ...list, gate: { write: c.config.writeMode } };
      },
    },
  ];

  for (const view of views) {
    const name = `${P}_view_${view.noun}`;
    const uri = `ui://ninjaone/${view.noun}.html`;
    const html = page(view.title, view.script);
    server.registerResource(name, uri, { description: `${view.title}: interactive view for ${name}`, mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { prefersBorder: false } } }],
    }));
    defineTool(server, ctx, {
      name,
      kind: 'read',
      description: view.description,
      inputSchema: view.inputSchema,
      meta: { ui: { resourceUri: uri }, 'ui/resourceUri': uri },
      handler: (args, c) => view.load(args as Record<string, unknown>, c),
    });
  }
}
