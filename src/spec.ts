/**
 * The one way to register a tool.
 *
 * `defineTool` decides, in one place, what a tool is called, what it is titled,
 * which annotations it carries, which gate it sits behind, and how its result
 * and errors are shaped. No tool can be registered without a title, a full
 * annotation set, and (for writes) a `confirm` parameter, and no write handler
 * can run before the gate has been checked.
 *
 * The naming verb list is canonical in scripts/check-conformance.mjs, which CI
 * runs against the built server.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ApiClient } from './client.js';
import type { Config } from './config.js';
import type { OrgDirectory } from './orgs.js';
import { MAX_RESULT_CHARS, TOOL_PREFIX } from './constants.js';
import { formatError } from './errors.js';
import { gateRefusal, type ToolKind } from './gate.js';
import { capText } from './paging.js';
import { logStderr } from './redact.js';

export interface ToolContext {
  config: Config;
  client: ApiClient;
  orgs: OrgDirectory;
  /** Every registered tool and its kind. Read by ninjaone_status_gate. */
  tools: Map<string, ToolKind>;
  /** Read handlers by tool name, so composed tools and views reuse a tool without the SDK's internals. */
  readers: Map<string, (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>>;
}

export interface ToolSpec<S extends ZodRawShapeCompat, O extends ZodRawShapeCompat> {
  /** Wire name: `${TOOL_PREFIX}_<verb>_<noun>`, lowercase snake_case. */
  name: string;
  /** Display title. Derived from the name when omitted ("List Widgets"). */
  title?: string;
  /** What it does, when to use it, what it returns, and what to call next. */
  description: string;
  kind: ToolKind;
  /** Writes only: repeating the call with the same arguments changes nothing more. */
  idempotent?: boolean;
  /** True only when the tool can reach arbitrary external entities (any URL, any recipient). */
  openWorld?: boolean;
  inputSchema: S;
  outputSchema?: O;
  /** Tool metadata, e.g. the MCP Apps ui:// resource of a view tool. */
  meta?: Record<string, unknown>;
  handler: (args: ShapeOutput<S>, ctx: ToolContext) => Promise<unknown>;
}

const NAME_PATTERN = new RegExp(`^${TOOL_PREFIX}_[a-z0-9]+(?:_[a-z0-9]+)+$`);

const SHOUTED: Record<string, string> = { api: 'API', id: 'ID', ids: 'IDs', url: 'URL', urls: 'URLs', os: 'OS', kb: 'KB', csv: 'CSV', psa: 'PSA', itam: 'ITAM', raid: 'RAID' };

export function titleFromName(name: string): string {
  return name
    .slice(TOOL_PREFIX.length + 1)
    .split('_')
    .map((word) => SHOUTED[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Every annotation is set explicitly. The spec defaults destructiveHint to true and openWorldHint to true. */
export function annotationsFor(kind: ToolKind, title: string, idempotent: boolean, openWorld: boolean): ToolAnnotations {
  return {
    title,
    readOnlyHint: kind === 'read',
    destructiveHint: kind === 'destructive',
    idempotentHint: kind === 'read' ? true : idempotent,
    openWorldHint: openWorld,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function defineTool<S extends ZodRawShapeCompat, O extends ZodRawShapeCompat = ZodRawShapeCompat>(
  server: McpServer,
  ctx: ToolContext,
  spec: ToolSpec<S, O>,
): void {
  if (!NAME_PATTERN.test(spec.name)) {
    throw new Error(`Tool name "${spec.name}" is not ${TOOL_PREFIX}_<verb>_<noun> in lowercase snake_case.`);
  }
  if (ctx.tools.has(spec.name)) throw new Error(`Tool "${spec.name}" is registered twice.`);
  if (spec.kind !== 'read' && !('confirm' in spec.inputSchema)) {
    throw new Error(`${spec.name} is a ${spec.kind} tool and must take confirm (use confirmParam).`);
  }
  ctx.tools.set(spec.name, spec.kind);
  if (spec.kind === 'read') ctx.readers.set(spec.name, spec.handler as (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>);

  const title = spec.title ?? titleFromName(spec.name);

  const run = async (args: ShapeOutput<S>): Promise<CallToolResult> => {
    const refusal = gateRefusal(spec.kind, spec.name, ctx.config);
    if (refusal) {
      logStderr('warn', 'write_refused', { tool: spec.name, kind: spec.kind });
      return { isError: true, content: [{ type: 'text', text: formatError(refusal) }] };
    }
    try {
      const data = await spec.handler(args, ctx);
      if (spec.kind !== 'read') logStderr('info', 'write_applied', { tool: spec.name, kind: spec.kind });
      const text = capText(JSON.stringify(data), MAX_RESULT_CHARS, spec.name);
      return {
        content: [{ type: 'text', text }],
        ...(isPlainObject(data) ? { structuredContent: data } : {}),
      };
    } catch (error) {
      const message = formatError(error);
      // Arguments are never logged: they can carry client data.
      logStderr('error', 'tool_failed', { tool: spec.name, kind: spec.kind });
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  };

  server.registerTool(
    spec.name,
    {
      title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
      ...(spec.meta ? { _meta: spec.meta } : {}),
      annotations: annotationsFor(spec.kind, title, spec.idempotent ?? false, spec.openWorld ?? false),
    },
    // The SDK's callback generics do not narrow across a schema-agnostic helper.
    // The runtime contract (validated args in, CallToolResult out) is exact.
    run as never,
  );
}
