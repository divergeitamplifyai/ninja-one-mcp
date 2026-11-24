/**
 * Turns declared Routes into tools.
 *
 * Every route-built tool runs the same steps, in this order:
 *
 *   1. gate        (in defineTool, before anything else, so a refusal sends nothing)
 *   2. scope       org resolution, device boundary, df narrowing, unscoped refusal
 *   3. request     path and query built from validated arguments only
 *   4. before      for writes with readBack: the record as it was
 *   5. dry run     for wide writes: the exact request, unsent, by default
 *   6. send        noRetry for actions that must never run twice
 *   7. after       read back, so the stored value is the answer
 *   8. shape       compact fields, one cursor shape, short reads announced
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodType } from 'zod';
import type { QueryValue } from './client.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, TOOL_PREFIX } from './constants.js';
import { ToolError } from './errors.js';
import { confirmParam } from './gate.js';
import { BODY_DOCS } from './generated/bodies.js';
import { fieldsParam, page, pickFields, type Fields } from './paging.js';
import type { ListSpec, Param, ParamType, Route } from './routes/types.js';
import { defineTool, type ToolContext } from './spec.js';
import { toolsetForRoute } from './toolsets.js';
import { orgParam } from './tenants.js';

type Row = Record<string, unknown>;
type Args = Record<string, unknown>;

function zodFor(type: ParamType): ZodType {
  if (typeof type === 'object') {
    if ('enum' in type) return z.enum(type.enum);
    return z.array(z.enum(type.enumList)).min(1);
  }
  switch (type) {
    case 'int':
      return z.number().int();
    case 'number':
      return z.number();
    case 'bool':
      return z.boolean();
    case 'date':
      return z.string().min(1);
    case 'int[]':
      return z.array(z.number().int()).min(1);
    case 'string[]':
      return z.array(z.string().min(1)).min(1);
    default:
      return z.string().min(1);
  }
}

function paramSchema(param: Param): ZodType {
  const base = zodFor(param.type).describe(param.desc);
  return param.required ? base : base.optional();
}

// ------------------------------------------------------------------ cursors

interface CursorState {
  /** Upstream cursor value (id, cursor name, pageInfo cursor). */
  u?: string;
  /** Local offset for locally paged endpoints. */
  o?: number;
}

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): CursorState {
  if (cursor === undefined) return {};
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorState;
    if (parsed && typeof parsed === 'object' && (typeof parsed.u === 'string' || typeof parsed.o === 'number')) return parsed;
  } catch {
    // fall through
  }
  throw new ToolError('cursor is not one this server issued.', 'Pass next_cursor exactly as the previous page returned it, or omit cursor for the first page.');
}

// ------------------------------------------------------------------ envelopes

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Pull the rows out of a list response. An unknown shape is an error, never zero rows. */
export function rowsOf(body: unknown, spec: ListSpec, where: string): { rows: Row[]; dropped: number } {
  let raw: unknown;
  if (Array.isArray(body)) raw = body;
  else if (isRow(body) && spec.items && Array.isArray(body[spec.items])) raw = body[spec.items];
  else if (isRow(body) && Array.isArray(body.results)) raw = body.results;
  else if (body === undefined || body === null || body === '') raw = [];
  else if (isRow(body) && Object.values(body).filter(Array.isArray).length === 1) raw = Object.values(body).find(Array.isArray);
  else {
    const keys = isRow(body) ? Object.keys(body).join(', ') || '(none)' : typeof body;
    throw new ToolError(
      `${where} returned a response shape this server does not recognize (keys: ${keys}).`,
      'Report this as a server bug. Do not treat it as an empty result.',
    );
  }
  const list = raw as unknown[];
  // Scalar rows (some endpoints return plain ids) are wrapped rather than dropped.
  const rows = list.map((r) => (isRow(r) ? r : { value: r }));
  return { rows, dropped: 0 };
}

// ------------------------------------------------------------------ build

function fillPath(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_m, key: string) => {
    const value = values[key];
    if (value === undefined || value === '') {
      throw new ToolError(`Internal: no value for path parameter {${key}}.`, 'Report this as a server bug.');
    }
    return encodeURIComponent(value);
  });
}

function describe(route: Route): string {
  const parts = [route.description];
  if (route.scope.kind === 'account') parts.push('Account-wide (not organization scoped).');
  if (route.body) {
    const doc = BODY_DOCS[route.body.op];
    const shape = route.body.shape === 'ids' ? 'array of integer ids' : route.body.shape === 'array' ? 'array of objects' : 'object';
    parts.push(`Body (${shape}) per NinjaOne ${route.body.op}.${doc ? ` ${doc}` : ''}${route.body.note ? ` ${route.body.note}` : ''}`);
  }
  if (route.dryRun) parts.push('Runs as a dry run unless dry_run is false: the first call returns the exact request without sending it.');
  if (route.secret) parts.push('Returns secret values (signed or tokenized URLs): requires reveal: true and both write gates.');
  if (route.kind === 'write') parts.push('Needs NINJAONE_MODE=write and confirm: true.');
  if (route.kind === 'destructive') parts.push('Destructive tier: needs NINJAONE_MODE=write, NINJAONE_ALLOW_DESTRUCTIVE=true and confirm: true.');
  return parts.join(' ');
}

export function inputShapeFor(route: Route): Record<string, ZodType> {
  const shape: Record<string, ZodType> = {};
  const scope = route.scope;
  if (scope.kind === 'org' || scope.kind === 'orgFilter') shape.org = orgParam;
  for (const [key, param] of Object.entries(route.params ?? {})) shape[key] = paramSchema(param);
  if (route.list) {
    const max = route.list.maxPage ?? MAX_PAGE_SIZE;
    shape.limit = z.number().int().min(1).max(max).optional().describe(`Rows per page, 1 to ${max}. Default ${Math.min(DEFAULT_PAGE_SIZE, max)}.`);
    shape.cursor = z.string().min(1).optional().describe('Opaque cursor from next_cursor on the previous page. Omit for the first page.');
    shape.fields = fieldsParam;
  }
  if (route.body) {
    const item = z.record(z.string(), z.unknown());
    const body =
      route.body.shape === 'ids' ? z.array(z.number().int()).min(1) : route.body.shape === 'array' ? z.array(item).min(1) : item;
    shape.body = (route.body.required === false ? body.optional() : body).describe(
      `Request body as NinjaOne documents it for ${route.body.op}. Field names are NinjaOne's (camelCase).`,
    );
  }
  if (route.dryRun) shape.dry_run = z.boolean().optional().describe('Default true: return the exact request without sending it. Pass false to apply.');
  if (route.secret) shape.reveal = z.literal(true).describe('Must be exactly true. States that the result may carry secret values.');
  if (route.kind !== 'read') shape.confirm = confirmParam;
  return shape;
}

// ------------------------------------------------------------------ run

async function runRoute(route: Route, args: Args, ctx: ToolContext): Promise<unknown> {
  const { client, orgs } = ctx;
  const toolName = `${TOOL_PREFIX}_${route.tool}`;
  const pathValues: Record<string, string> = {};
  const query: Record<string, QueryValue> = { ...(route.fixedQuery ?? {}) };
  let org: { id: string; name: string } | undefined;
  let rowField: string | undefined;

  // Arguments into path and query.
  for (const [key, param] of Object.entries(route.params ?? {})) {
    const value = args[key];
    if (value === undefined) continue;
    const wire = param.wire ?? key;
    if (param.in === 'path') pathValues[wire] = String(value);
    else query[wire] = value as QueryValue;
  }

  // Scope.
  const scope = route.scope;
  switch (scope.kind) {
    case 'account':
      if (route.kind !== 'read') orgs.assertUnbounded(toolName, 'it changes account-wide configuration');
      break;
    case 'org': {
      const resolved = await orgs.resolve(args.org as string | undefined);
      org = { id: resolved.id, name: resolved.name };
      pathValues[scope.param] = resolved.id;
      break;
    }
    case 'orgFilter': {
      rowField = scope.rowField;
      if (args.org !== undefined) {
        const resolved = await orgs.resolve(args.org as string);
        org = { id: resolved.id, name: resolved.name };
        query[scope.param] = scope.list ? [resolved.id] : resolved.id;
      } else if (ctx.config.allowedOrgIds) {
        if (scope.list) query[scope.param] = ctx.config.allowedOrgIds;
        else orgs.assertUnbounded(toolName, 'without org it reads every organization; pass org');
      }
      break;
    }
    case 'device': {
      const id = pathValues[scope.param];
      if (id !== undefined) await orgs.assertDevice(id);
      break;
    }
    case 'df': {
      rowField = scope.rowField;
      const df = orgs.boundedDf(query.df as string | undefined);
      if (df !== undefined) query.df = df;
      break;
    }
    case 'rows':
      rowField = scope.field;
      break;
    case 'unscoped':
      orgs.assertUnbounded(toolName, scope.reason);
      break;
  }

  const path = fillPath(route.path, pathValues);

  // Lists.
  if (route.list) return runList(route, route.list, path, query, args, ctx, org, rowField);

  // Single reads.
  if (route.kind === 'read') {
    const data = await client.request('GET', path, { query });
    if (rowField && isRow(data)) orgs.assertAllowed(data[rowField] as string | undefined, 'This record');
    return { ...(org ? { org } : {}), data };
  }

  // Writes.
  const readBackPath = route.readBack ? fillPath(route.readBack, pathValues) : undefined;
  const before = readBackPath ? await client.request('GET', readBackPath).catch(() => undefined) : undefined;
  const body = args.body;

  if (route.dryRun && args.dry_run !== false) {
    return {
      dry_run: true,
      applied: false,
      request: { method: route.method, path, query, body: body ?? null },
      ...(before === undefined ? {} : { before }),
      next_step: `Review the request, then call ${toolName} again with the same arguments and dry_run: false to apply it.`,
    };
  }

  const result = await client.request(route.method, path, { query, body, noRetry: route.noRetry ?? false });
  const after = readBackPath && route.kind !== 'destructive' ? await client.request('GET', readBackPath).catch(() => undefined) : undefined;
  return {
    applied: true,
    ...(org ? { org } : {}),
    request: { method: route.method, path },
    result: result ?? null,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

async function runList(
  route: Route,
  spec: ListSpec,
  path: string,
  query: Record<string, QueryValue>,
  args: Args,
  ctx: ToolContext,
  org: { id: string; name: string } | undefined,
  rowField: string | undefined,
): Promise<unknown> {
  const max = spec.maxPage ?? MAX_PAGE_SIZE;
  const limit = Math.min((args.limit as number | undefined) ?? DEFAULT_PAGE_SIZE, max);
  const state = decodeCursor(args.cursor as string | undefined);
  const paging = spec.paging;
  const where = `GET ${path}`;

  if (paging.style === 'id') query[paging.sizeParam ?? 'pageSize'] = limit;
  if (paging.style === 'cursor' || paging.style === 'pageInfo') query[paging.sizeParam ?? 'pageSize'] = limit;
  if (state.u !== undefined) {
    if (paging.style === 'id') query[paging.cursorParam] = state.u;
    else if (paging.style === 'cursor') query.cursor = state.u;
    else if (paging.style === 'pageInfo') query.after = state.u;
  }

  const body = await ctx.client.request('GET', path, { query });
  let { rows } = rowsOf(body, spec, where);
  let next: string | undefined;
  let warning: string | undefined;

  switch (paging.style) {
    case 'id': {
      if (rows.length >= limit) {
        const ids = rows.map((r) => r[paging.idField ?? 'id']).filter((v) => v !== undefined && v !== null);
        const pick = paging.lowest ? ids.reduce((a, b) => (Number(b) < Number(a) ? b : a), ids[0]) : ids[ids.length - 1];
        if (pick !== undefined) next = encodeCursor({ u: String(pick) });
        else warning = 'The page was full but rows carry no id, so the next page cannot be requested.';
      }
      break;
    }
    case 'cursor': {
      const name = isRow(body) && isRow(body.cursor) && typeof body.cursor.name === 'string' ? body.cursor.name : undefined;
      if (rows.length >= limit && name) next = encodeCursor({ u: name });
      break;
    }
    case 'pageInfo': {
      const info = isRow(body) && isRow(body.pageInfo) ? body.pageInfo : undefined;
      if (info?.hasMore === true && typeof info.nextCursor === 'string') next = encodeCursor({ u: info.nextCursor });
      break;
    }
    case 'local': {
      const offset = state.o ?? 0;
      const total = rows.length;
      rows = rows.slice(offset, offset + limit);
      if (offset + limit < total) next = encodeCursor({ o: offset + limit });
      break;
    }
  }

  // Boundary re-check on rows that carry an organization.
  if (rowField && ctx.config.allowedOrgIds) {
    const allowed = ctx.config.allowedOrgIds;
    const before = rows.length;
    rows = rows.filter((r) => r[rowField] !== undefined && allowed.includes(String(r[rowField])));
    const hidden = before - rows.length;
    if (hidden > 0) warning = `${hidden} row(s) outside NINJAONE_ALLOWED_ORG_IDS were removed from this page.`;
  }

  const items = rows.map((r) => (spec.compact ? pickFields(r, spec.compact, args.fields as Fields) : pickFields(r, Object.keys(r), args.fields as Fields)));
  return { ...(org ? { org } : {}), ...page(items, next, warning) };
}

/** Register every route as a tool. */
export function registerRoutes(server: McpServer, ctx: ToolContext, routes: readonly Route[]): void {
  for (const route of routes) {
    const handler = (args: Record<string, unknown>, c: ToolContext) => runRoute(route, args, c);
    if (!ctx.config.toolsets.has(toolsetForRoute(route))) {
      // Not listed, but composed tools and views may still read through it.
      if (route.kind === 'read') ctx.readers.set(`${TOOL_PREFIX}_${route.tool}`, handler);
      continue;
    }
    defineTool(server, ctx, {
      name: `${TOOL_PREFIX}_${route.tool}`,
      kind: route.kind,
      description: describe(route),
      idempotent: route.kind === 'read' ? true : (route.idempotent ?? false),
      openWorld: route.openWorld ?? false,
      inputSchema: inputShapeFor(route),
      handler: (args, c) => runRoute(route, args as Args, c),
    });
  }
}
