/**
 * Toolsets: which groups of tools this deployment lists.
 *
 * The full server is 315 tools. Some hosts cap the tools a model sees
 * (VS Code with Copilot allows 128 per request; Cursor warns past roughly 40),
 * and a smaller list also plans better. NINJAONE_TOOLSETS picks the groups;
 * the default is the everyday RMM set. Diagnostics are always listed.
 *
 * Toolsets are a listing choice, not a safety control: the write gate applies
 * to whatever is listed, and annotations never change with configuration.
 */

import { ENV } from './constants.js';
import type { Route } from './routes/types.js';

export const TOOLSETS = {
  core: 'Diagnostics, organizations, locations, find and fleet health. Always on.',
  devices: 'Device lists, search, profile, hardware, software, services, custom field values.',
  alerts: 'Alerts, activities and jobs.',
  reports: 'Fleet-wide /v2/queries reports: inventory, patches, antivirus, health, custom fields.',
  actions: 'Device actions: reboot, scripts, services, patch scan and apply, maintenance, approval.',
  policies: 'Policies, conditions, device roles, groups, scripts library, scheduled tasks.',
  ticketing: 'Tickets, boards, forms, comments, ticket contacts.',
  documentation: 'IT documentation: documents, templates, checklists, knowledge base.',
  assets: 'ITAM: asset tags, software licenses, relationships, related items, unmanaged devices.',
  custom_fields: 'Custom field definitions and global values.',
  users: 'Contacts, end users, technicians, roles.',
  billing: 'PSA billing: accounts, agreements, invoices, products, ticket products.',
  backup: 'Backup jobs, usage, integrity checks; vulnerability scan groups.',
  admin: 'Account configuration: webhook, notification channels, custom tabs, node roles, installers.',
  views: 'Interactive MCP Apps views.',
  api: 'Raw passthrough: ninjaone_api_get and ninjaone_api_write.',
} as const;

export type Toolset = keyof typeof TOOLSETS;

export const DEFAULT_TOOLSETS: readonly Toolset[] = ['core', 'devices', 'alerts', 'reports', 'actions', 'ticketing', 'views'];

/** Parse NINJAONE_TOOLSETS. "all" enables everything; unknown names are reported. */
export function parseToolsets(raw: string | undefined): { enabled: Set<Toolset>; problems: string[] } {
  const problems: string[] = [];
  const names = (raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) return { enabled: new Set(DEFAULT_TOOLSETS), problems };
  if (names.includes('all')) return { enabled: new Set(Object.keys(TOOLSETS) as Toolset[]), problems };
  const enabled = new Set<Toolset>(['core']);
  for (const name of names) {
    const additive = name.startsWith('+') ? name.slice(1) : name;
    if (additive === 'default') DEFAULT_TOOLSETS.forEach((t) => enabled.add(t));
    else if (additive in TOOLSETS) enabled.add(additive as Toolset);
    else problems.push(`${ENV.toolsets} names an unknown toolset "${name}". Known: ${Object.keys(TOOLSETS).join(', ')}, default, all.`);
  }
  return { enabled, problems };
}

/** The toolset a declared route belongs to, from its path. */
export function toolsetForRoute(route: Route): Toolset {
  const p = route.path;
  const t = route.tool;
  if (route.kind !== 'read' && p.startsWith('/v2/device')) return 'actions';
  if (/^\/v2\/(devices\/approval|alert\/)/.test(p)) return 'actions';
  if (/^\/v2\/queries\//.test(p)) return /backup/.test(p) ? 'backup' : 'reports';
  if (/^\/v2\/(alerts|activities|jobs)$/.test(p) || /\/(alerts|activities|jobs)$/.test(p)) return 'alerts';
  if (/installer/.test(p)) return 'admin';
  if (/^\/v2\/policies/.test(p)) return 'policies';
  if (/^\/v2\/user\/end-user/.test(p)) return 'users';
  if (/^\/v2\/organization\/(archive|restore)$/.test(p)) return 'documentation';
  if (/^\/v2\/(organizations?|locations)(\/|$|-)/.test(p) && !/custom-fields|backup|end-users|policies|checklist|document|template/.test(p)) {
    return /\/devices$/.test(p) ? 'devices' : 'core';
  }
  if (/^\/v2\/device|^\/v2\/devices/.test(p)) return 'devices';
  if (/custom-fields/.test(p)) return /^\/v2\/(device|organization)/.test(p) ? 'devices' : 'custom_fields';
  if (/^\/v2\/(policies|roles|groups?|automation|tasks|software-products)/.test(p) || /\/policies$/.test(p)) return 'policies';
  if (/^\/v2\/ticketing/.test(p)) return 'ticketing';
  if (/^\/v2\/(billing)/.test(p)) return 'billing';
  if (/^\/v2\/(backup|vulnerability)/.test(p) || /backup/.test(p)) return 'backup';
  if (/^\/v2\/(organization\/(document|checklist|archive|restore|\{organizationId\}\/(document|template|checklists))|organization\/documents|organization\/checklists|document-templates|checklist|knowledgebase|attachments)/.test(p)) return 'documentation';
  if (/^\/v2\/(tag|software-license|itam|related-items|staged-device)/.test(p)) return 'assets';
  if (/^\/v2\/(contacts?|user|users)/.test(p) || /end-users$/.test(p)) return 'users';
  if (/^\/v2\/(webhook|notification-channels|tab|noderole)/.test(p)) return 'admin';
  if (t.includes('custom_field')) return 'custom_fields';
  return 'core';
}
