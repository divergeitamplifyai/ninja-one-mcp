/**
 * Tools that are more than one call: composed reads an agent would otherwise
 * stitch together itself, and the endpoints the route engine cannot express
 * (a POST used as a read, a multipart comment).
 *
 *  - ninjaone_find_organization     name match with candidates, no inference
 *  - ninjaone_get_device_profile    device + hardware + volumes + patches + alerts in one call
 *  - ninjaone_report_fleet_health   per-organization health across the estate
 *  - ninjaone_list_board_tickets    tickets on a board (POST /run), cursor paged
 *  - ninjaone_add_ticket_comment    multipart comment on a ticket
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, TOOL_PREFIX } from '../constants.js';
import { decodeCursor, encodeCursor, rowsOf } from '../engine.js';
import { ToolError, formatError } from '../errors.js';
import { fanOut } from '../fanout.js';
import { confirmParam } from '../gate.js';
import { fieldsParam, page, pickFields, type Fields } from '../paging.js';
import { defineTool, type ToolContext } from '../spec.js';
import type { Toolset } from '../toolsets.js';

const P = TOOL_PREFIX;
type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);

async function settle<T>(work: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

function asList(value: unknown): Row[] {
  if (Array.isArray(value)) return value.filter(isRow);
  if (isRow(value)) {
    const arrays = Object.values(value).filter(Array.isArray);
    if (arrays.length === 1) return (arrays[0] as unknown[]).filter(isRow);
  }
  return [];
}

/** Count rows by a field value, e.g. patches by status. */
function countBy(rows: Row[], field: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = String(row[field] ?? 'UNKNOWN');
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Read every page of a /v2/queries report for one device filter, up to a row cap. */
async function readQuery(ctx: ToolContext, path: string, df: string, cap: number): Promise<{ rows: Row[]; capped: boolean }> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const body = await ctx.client.request(`GET`, path, { query: { df, pageSize: 1000, cursor } });
    const { rows: pageRows } = rowsOf(body, { paging: { style: 'cursor' }, items: 'results' }, `GET ${path}`);
    rows.push(...pageRows);
    if (rows.length >= cap) return { rows: rows.slice(0, cap), capped: true };
    const name = isRow(body) && isRow(body.cursor) && typeof body.cursor.name === 'string' ? body.cursor.name : undefined;
    if (pageRows.length < 1000 || !name) break;
    cursor = name;
  }
  return { rows, capped: false };
}

export function registerWorkflowTools(server: McpServer, ctx: ToolContext): void {
  /** Register a tool when its toolset is on; otherwise keep read handlers for views. */
  const def = (toolset: Toolset, spec: Parameters<typeof defineTool>[2]): void => {
    if (ctx.config.toolsets.has(toolset)) return defineTool(server, ctx, spec);
    if (spec.kind === 'read') ctx.readers.set(spec.name, spec.handler as (a: Record<string, unknown>, c: ToolContext) => Promise<unknown>);
  };

  def('core', {
    name: `${P}_find_organization`,
    kind: 'read',
    description:
      'Find organizations whose name contains the query (case-insensitive), with id and name. Use it to turn a client name into the ' +
      'org argument. Returns every match; when more than one matches, pass the id of the one you mean to other tools.',
    inputSchema: { query: z.string().min(1).describe('Part of the organization name, e.g. "example".') },
    async handler(args, c) {
      const needle = args.query.trim().toLowerCase();
      const matches = (await c.orgs.visible())
        .filter((o) => o.name.toLowerCase().includes(needle) || o.id === needle)
        .map((o) => ({ id: o.id, name: o.name, description: o.raw.description ?? null }));
      return { query: args.query, count: matches.length, items: matches, exact: matches.find((m) => m.name.toLowerCase() === needle) ?? null };
    },
  });

  def('devices', {
    name: `${P}_get_device_profile`,
    kind: 'read',
    description:
      'Everything about one device in one call: the device record, last logged-on user, volumes, disks, processors, network interfaces, ' +
      'active alerts, and pending/failed OS and software patch counts. Each part reports its own error instead of failing the whole call. ' +
      `Use it to triage a device; then ${P}_list_device_activities for history or ${P}_get_device_scripting_options to act.`,
    inputSchema: {
      device_id: z.number().int().describe(`Device id (from ${P}_list_devices or ${P}_search_devices).`),
      include_software: z.boolean().optional().describe('Also return the installed software list (can be long). Default false.'),
    },
    async handler(args, c) {
      await c.orgs.assertDevice(args.device_id);
      const base = `/v2/device/${args.device_id}`;
      const get = (suffix: string) => settle(c.client.request('GET', `${base}${suffix}`));
      const [device, lastUser, volumes, disks, processors, nics, alerts, osPatches, swPatches, software] = await Promise.all([
        get(''),
        get('/last-logged-on-user'),
        get('/volumes'),
        get('/disks'),
        get('/processors'),
        get('/network-interfaces'),
        get('/alerts'),
        get('/os-patches'),
        get('/software-patches'),
        args.include_software ? get('/software') : Promise.resolve(undefined),
      ]);
      if (!device.ok) throw new ToolError(`Could not read device ${args.device_id}. ${device.error.split('\n')[0]}`, `Check the id with ${P}_search_devices.`);
      const part = (r: { ok: true; value: unknown } | { ok: false; error: string } | undefined) => (r === undefined ? undefined : r.ok ? r.value : { error: r.error });
      const errors = Object.entries({ lastUser, volumes, disks, processors, nics, alerts, osPatches, swPatches, software })
        .filter(([, r]) => r !== undefined && !r.ok)
        .map(([k]) => k);
      const osRows = osPatches.ok ? asList(osPatches.value) : [];
      const swRows = swPatches.ok ? asList(swPatches.value) : [];
      return {
        device: device.value,
        last_logged_on_user: part(lastUser),
        volumes: part(volumes),
        disks: part(disks),
        processors: part(processors),
        network_interfaces: part(nics),
        alerts: part(alerts),
        patches: {
          os: osPatches.ok ? { total: osRows.length, by_status: countBy(osRows, 'status'), by_severity: countBy(osRows, 'severity') } : { error: osPatches.error },
          software: swPatches.ok ? { total: swRows.length, by_status: countBy(swRows, 'status') } : { error: swPatches.error },
        },
        ...(software === undefined ? {} : { software: part(software) }),
        ...(errors.length > 0 ? { warning: `These parts failed and are shown as errors: ${errors.join(', ')}.` } : {}),
      };
    },
  });

  def('core', {
    name: `${P}_report_fleet_health`,
    kind: 'read',
    description:
      'Health across organizations, one row per organization: device count, offline devices, devices by health status, pending and failed OS ' +
      'patches, active alerts, and antivirus threats. Runs per organization with a concurrency cap (NINJAONE_MAX_CONCURRENCY); a failing ' +
      `organization is reported on its own row. Pass org to limit it to one client. Then ${P}_list_devices with df "org = <id> AND offline" to drill in.`,
    inputSchema: {
      org: z.string().min(1).optional().describe('One organization (id or unique name part). Omit for every organization in scope.'),
      max_orgs: z.number().int().min(1).max(500).optional().describe('Stop after this many organizations. Default 100.'),
    },
    async handler(args, c) {
      const orgs = args.org ? [await c.orgs.resolve(args.org)] : (await c.orgs.visible()).slice(0, args.max_orgs ?? 100);
      const total = args.org ? 1 : (await c.orgs.visible()).length;
      const CAP = 20_000;
      const rows = await fanOut(orgs, c.config.maxConcurrency, async (org) => {
        const df = `org = ${org.id}`;
        const [health, osPatches, alerts, threats] = await Promise.all([
          readQuery(c, '/v2/queries/device-health', df, CAP),
          readQuery(c, '/v2/queries/os-patches', `${df}`, CAP),
          c.client.request('GET', '/v2/alerts', { query: { df } }),
          settle(readQuery(c, '/v2/queries/antivirus-threats', df, CAP)),
        ]);
        const offline = health.rows.filter((r) => r.offline === true).length;
        const pending = osPatches.rows.filter((r) => r.status === 'PENDING' || r.status === 'APPROVED').length;
        const failed = osPatches.rows.filter((r) => r.status === 'FAILED').length;
        return {
          devices: health.rows.length,
          offline,
          health: countBy(health.rows, 'healthStatus'),
          os_patches_pending: pending,
          os_patches_failed: failed,
          active_alerts: asList(alerts).length,
          av_threats: threats.ok ? threats.value.rows.length : null,
          ...(health.capped || osPatches.capped ? { warning: `Counts capped at ${CAP} rows.` } : {}),
        };
      });
      const items = rows.map((r) =>
        r.ok ? { org_id: r.item.id, org_name: r.item.name, ok: true, ...r.value } : { org_id: r.item.id, org_name: r.item.name, ok: false, error: r.error },
      );
      items.sort((a, b) => Number((b as Row).offline ?? 0) - Number((a as Row).offline ?? 0));
      return {
        organizations: items.length,
        failed: items.filter((i) => !i.ok).length,
        ...(total > orgs.length ? { warning: `Only the first ${orgs.length} of ${total} organizations were read. Raise max_orgs to read more.` } : {}),
        items,
      };
    },
  });

  def('ticketing', {
    name: `${P}_list_board_tickets`,
    kind: 'read',
    description:
      `List the tickets on a ticketing board (find boards with ${P}_list_ticket_boards), with optional search and sort. Cursor paged. ` +
      `Then ${P}_get_ticket for one ticket.`,
    inputSchema: {
      board_id: z.number().int().describe('Ticket board id.'),
      search: z.string().min(1).optional().describe('Free-text search across ticket fields.'),
      sort_by: z
        .array(z.object({ field: z.string().min(1), direction: z.enum(['ASC', 'DESC']) }))
        .optional()
        .describe('Sort order, e.g. [{"field": "createTime", "direction": "DESC"}].'),
      filters: z.array(z.record(z.string(), z.unknown())).optional().describe('Board filters as NinjaOne documents them (field, operator, value).'),
      limit: z.number().int().min(1).max(1000).optional().describe(`Tickets per page, default ${DEFAULT_PAGE_SIZE}.`),
      cursor: z.string().min(1).optional().describe('Opaque cursor from next_cursor.'),
      fields: fieldsParam,
    },
    async handler(args, c) {
      const limit = args.limit ?? DEFAULT_PAGE_SIZE;
      const state = decodeCursor(args.cursor);
      const body = {
        pageSize: limit,
        ...(args.search ? { searchCriteria: args.search } : {}),
        ...(args.sort_by ? { sortBy: args.sort_by } : {}),
        ...(args.filters ? { filters: args.filters } : {}),
        ...(state.u ? { lastCursorId: Number(state.u) } : {}),
      };
      const path = `/v2/ticketing/trigger/board/${args.board_id}/run`;
      const response = await c.client.request('POST', path, { body });
      let { rows } = rowsOf(response, { paging: { style: 'local' }, items: 'data' }, `POST ${path}`);
      const meta = isRow(response) && isRow(response.metadata) ? response.metadata : undefined;
      const last = meta?.lastCursorId ?? rows[rows.length - 1]?.id;
      const next = rows.length >= limit && last !== undefined ? encodeCursor({ u: String(last) }) : undefined;
      let warning: string | undefined;
      if (c.config.allowedOrgIds) {
        const allowed = c.config.allowedOrgIds;
        const before = rows.length;
        rows = rows.filter((r) => allowed.includes(String(r.clientId ?? (isRow(r.organization) ? r.organization.id : ''))));
        if (rows.length < before) warning = `${before - rows.length} ticket(s) outside NINJAONE_ALLOWED_ORG_IDS were removed from this page.`;
      }
      const compact = ['id', 'subject', 'status', 'priority', 'severity', 'clientId', 'assignedAppUserId', 'createTime', 'lastUpdated'];
      return page(rows.map((r) => pickFields(r, compact, args.fields as Fields)), next, warning);
    },
  });

  def('ticketing', {
    name: `${P}_add_ticket_comment`,
    kind: 'write',
    description:
      'Add a comment to a ticket: public (visible to the requester) or internal, as plain text or HTML, optionally with time tracked. ' +
      `Returns the result; read the ticket's log with ${P}_list_ticket_log_entries. Needs NINJAONE_MODE=write and confirm: true.`,
    inputSchema: {
      ticket_id: z.number().int().describe(`Ticket id (from ${P}_list_board_tickets).`),
      body: z.string().min(1).describe('Comment text.'),
      html_body: z.string().min(1).optional().describe('HTML version of the comment.'),
      public: z.boolean().describe('true: visible to the requester. false: internal note.'),
      time_tracked_seconds: z.number().int().min(0).optional().describe('Time to log against the ticket, in seconds.'),
      confirm: confirmParam,
    },
    async handler(args, c) {
      c.orgs.assertUnbounded(`${P}_add_ticket_comment`, 'tickets are addressed by id without an organization check');
      const comment = {
        public: args.public,
        body: args.body,
        ...(args.html_body ? { htmlBody: args.html_body } : {}),
        ...(args.time_tracked_seconds !== undefined ? { timeTracked: args.time_tracked_seconds } : {}),
      };
      const form = new FormData();
      form.append('comment', new Blob([JSON.stringify(comment)], { type: 'application/json' }));
      const result = await c.client.request('POST', `/v2/ticketing/ticket/${args.ticket_id}/comment`, { form });
      return { applied: true, ticket_id: args.ticket_id, result: result ?? null };
    },
  });
}
