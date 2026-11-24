/**
 * Raw API passthrough (STANDARD.md P1-P3), for the operations no typed tool
 * covers (docs/api-coverage.md lists them).
 *
 *  - ninjaone_api_get    read: any GET under /v2/
 *  - ninjaone_api_write  destructive tier: POST, PUT, PATCH, DELETE under /v2/
 *
 * Raw paths cannot be held inside an organization boundary, so both refuse
 * while NINJAONE_ALLOWED_ORG_IDS is set. showSecureValues is always forced off,
 * and signed-URL routes are refused here (use the gated download tools).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { QueryValue } from '../client.js';
import { TOOL_PREFIX } from '../constants.js';
import { ToolError } from '../errors.js';
import { confirmParam } from '../gate.js';
import { defineTool, type ToolContext } from '../spec.js';

const P = TOOL_PREFIX;
const SECRET_ROUTE = /(signed-urls|\/installer\/|generate-installer|\/download(\/|$)|\/export(\/|$)|\/secure(\/|$))/i;

export function validatePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('/v2/')) {
    throw new ToolError(`path must start with /v2/ (got "${trimmed.slice(0, 80)}").`, 'Pass a relative NinjaOne API path such as /v2/organizations.');
  }
  if (/\.\.|\/\/|[\s?#\\]/.test(trimmed) || /%2e|%2f/i.test(trimmed)) {
    throw new ToolError('path contains "..", "//", whitespace, a query string or an encoded separator.', 'Pass the path only, and put query values in query.');
  }
  return trimmed;
}

function cleanQuery(query: Record<string, string | number | boolean> | undefined): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (key.toLowerCase() === 'showsecurevalues') continue;
    out[key] = value;
  }
  out.showSecureValues = undefined;
  return out;
}

const queryParam = z
  .record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .describe('Query parameters, e.g. {"pageSize": 100, "df": "org = 12"}. showSecureValues is always forced off.');

export function registerPassthroughTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: `${P}_api_get`,
    kind: 'read',
    description:
      'Call any NinjaOne Public API GET under /v2/ that no typed tool covers (docs/api-coverage.md lists them). Prefer a typed tool: it pages, ' +
      'scopes and shapes results. Refused while NINJAONE_ALLOWED_ORG_IDS is set, because raw paths cannot be held inside the boundary. ' +
      'Secure custom field values are never requested, and signed-URL routes are refused.',
    inputSchema: { path: z.string().min(4).describe('Relative path, e.g. /v2/custom-fields.'), query: queryParam },
    async handler(args, c) {
      const path = validatePath(args.path);
      c.orgs.assertUnbounded(`${P}_api_get`, 'raw paths are not organization scoped');
      if (SECRET_ROUTE.test(path)) {
        throw new ToolError(`${path} returns secret values (signed or tokenized URLs) and is not available through ${P}_api_get.`, `Use the matching ${P}_download_* tool, which is gated and needs reveal: true.`);
      }
      const data = await c.client.request('GET', path, { query: cleanQuery(args.query) });
      return { path, data };
    },
  });

  defineTool(server, ctx, {
    name: `${P}_api_write`,
    kind: 'destructive',
    description:
      'Send a POST, PUT, PATCH or DELETE to any NinjaOne Public API path under /v2/ that no typed tool covers. Destructive tier: nothing checks ' +
      'what the call changes, so it needs NINJAONE_MODE=write, NINJAONE_ALLOW_DESTRUCTIVE=true and confirm: true, and is refused while ' +
      'NINJAONE_ALLOWED_ORG_IDS is set. Never retried automatically.',
    inputSchema: {
      method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method.'),
      path: z.string().min(4).describe('Relative path, e.g. /v2/noderole.'),
      query: queryParam,
      body: z.unknown().optional().describe('JSON body as NinjaOne documents it for the operation.'),
      confirm: confirmParam,
    },
    async handler(args, c) {
      const path = validatePath(args.path);
      c.orgs.assertUnbounded(`${P}_api_write`, 'raw paths are not organization scoped');
      const result = await c.client.request(args.method, path, { query: cleanQuery(args.query), body: args.body, noRetry: true });
      return { applied: true, request: { method: args.method, path }, result: result ?? null };
    },
  });
}
