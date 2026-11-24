/**
 * Server assembly. One McpServer per process on stdio.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiClient } from './client.js';
import type { Config } from './config.js';
import { ENV, SERVER_NAME, SERVER_TITLE, SERVER_VERSION, TOOL_PREFIX } from './constants.js';
import { registerRoutes } from './engine.js';
import type { ToolKind } from './gate.js';
import { OrgDirectory } from './orgs.js';
import { ALL_ROUTES } from './routes/index.js';
import type { ToolContext } from './spec.js';
import { registerDiagnosticTools } from './tools/diagnostics.js';
import { registerPassthroughTools } from './tools/passthrough.js';
import { registerPrompts } from './tools/prompts.js';
import { registerResources } from './tools/resources.js';
import { registerViewTools } from './tools/views.js';
import { registerWorkflowTools } from './tools/workflows.js';

const p = TOOL_PREFIX;

/** What the model reads before it calls anything. Kinds, gates, scoping, diagnostics, omissions. */
export const INSTRUCTIONS = [
  `NinjaOne (RMM) Public API v2. Every tool is named ${p}_<verb>_<noun>, and the verb says what kind it is:`,
  `- read: ${p}_list_*, _get_*, _search_*, _find_*, _report_*, _status_*, _test_*. Safe to call freely and in parallel. Lists are compact by default (fields: "all" for full rows) and paged: when has_more is true, pass next_cursor as cursor.`,
  `- view: ${p}_view_* render an interactive page where the host supports MCP Apps, and return the same data as JSON elsewhere.`,
  `- write: create, update, set, add, run, approve, archive, restore, reset, cancel and similar. They stay listed in read mode and refuse until ${ENV.mode}=write; the destructive tier (deletes, reboots, scripts, patch installs, replacements, secret-bearing downloads, raw writes) also needs ${ENV.allowDestructive}=true. Every write takes confirm: true. Wide writes are dry runs until dry_run: false. When a write refuses, relay the refusal; it names the setting.`,
  `- OAuth scopes (${ENV.scopes}) are a second, upstream limit: monitoring reads, management writes, control runs scripts and remote actions.`,
  '',
  `Scoping: organization tools take org (an id or a unique part of the name; ${p}_find_organization matches names). It overrides ${ENV.orgId}; ambiguity is refused with the candidates. Device tools take device_id. Fleet tools take df, NinjaOne's device filter: terms joined by AND, e.g. "org = 12 AND class = WINDOWS_SERVER AND offline". When ${ENV.allowedOrgIds} is set, every call is held inside it: df is narrowed, devices are checked, and tools that cannot be scoped (including ${p}_api_get and ${p}_api_write) refuse.`,
  '',
  `Start here: ${p}_report_fleet_health (every client at a glance), ${p}_get_device_profile (one device in depth), ${p}_report_* (fleet inventory and patch reports), ${p}_list_alerts.`,
  '',
  `Diagnostics: ${p}_status_server (configuration, no API call), ${p}_status_gate (why a write refused), ${p}_test_connection (proves the credential).`,
  '',
  'Secrets: secure custom field values are never requested. Signed and tokenized URLs (attachments, installers, exports) come only from the gated download tools with reveal: true.',
  '',
  'Prompts: fleet_triage, patch_review, device_triage and setup_check run the common workflows.',
  '',
  'Docs: the ninjaone://docs/llms.txt resource indexes NinjaOne\'s public API and help documentation. Every error ends with a "Next step:" line; follow it rather than retrying unchanged.',
].join('\n');

export interface CreatedServer {
  server: McpServer;
  tools: Map<string, ToolKind>;
}

/** Deployment-level state shared across requests: the upstream client (token cache) and org directory. */
export interface Shared {
  client: ApiClient;
  orgs: OrgDirectory;
}

export function createShared(config: Config): Shared {
  const client = new ApiClient(config);
  return { client, orgs: new OrgDirectory(client, config) };
}

/**
 * Build one McpServer. stdio builds one per process; HTTP builds one per
 * request and passes the shared upstream state, so no caller state lives in it.
 */
export function createServer(config: Config, shared: Shared = createShared(config)): CreatedServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  const ctx: ToolContext = { config, client: shared.client, orgs: shared.orgs, tools: new Map(), readers: new Map() };
  const on = config.toolsets;
  registerDiagnosticTools(server, ctx);
  registerRoutes(server, ctx, ALL_ROUTES);
  registerWorkflowTools(server, ctx);
  if (on.has('api')) registerPassthroughTools(server, ctx);
  if (on.has('views')) registerViewTools(server, ctx);
  registerResources(server);
  registerPrompts(server);
  return { server, tools: ctx.tools };
}
