/**
 * The three diagnostics every server carries. They are always registered,
 * whatever the configuration, so a broken setup can still explain itself.
 *
 *  - status_server: configuration only, no API call. Names missing variables.
 *  - status_gate: why a write would refuse right now.
 *  - test_connection: one token request and one cheap authenticated call.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ENV, REGIONS, SERVER_NAME, SERVER_VERSION, TOOL_PREFIX } from '../constants.js';
import { gateStatus } from '../gate.js';
import { DEFAULT_TOOLSETS, TOOLSETS } from '../toolsets.js';
import { defineTool, type ToolContext } from '../spec.js';

export function registerDiagnosticTools(server: McpServer, ctx: ToolContext): void {
  defineTool(server, ctx, {
    name: `${TOOL_PREFIX}_status_server`,
    kind: 'read',
    description:
      "Report this server's configuration without calling NinjaOne: version, region and base URL, whether the client id and secret are set " +
      '(never their values), requested OAuth scopes and what they allow, missing environment variables, unusable settings, the organization ' +
      `default and boundary, and the write gate. Call this first when tools fail or seem missing, then ${TOOL_PREFIX}_test_connection.`,
    inputSchema: {},
    async handler(_args, { config, transport }) {
      const ready = config.missing.length === 0;
      const where =
        transport === 'stdio'
          ? `in the MCP client configuration${config.envFilePath ? ` (or in ${config.envFilePath} with chmod 600)` : ''} and restart the client`
          : transport === 'worker'
            ? 'as wrangler secrets (wrangler secret put) and redeploy'
            : 'in the deployment (Key Vault secrets on Azure) and restart the container';
      const scopes = config.scopes;
      return {
        server: SERVER_NAME,
        version: SERVER_VERSION,
        transport,
        region: config.region ?? null,
        base_url: config.baseUrl ?? null,
        known_regions: REGIONS,
        client_id_configured: config.clientId !== undefined,
        client_secret_configured: config.clientSecret !== undefined,
        scopes,
        scope_coverage: {
          reads: scopes.includes('monitoring'),
          writes: scopes.includes('management'),
          scripts_and_remote_actions: scopes.includes('control'),
        },
        env_file: config.envFile ? { path: config.envFile.path, keys_loaded: config.envFile.loaded } : null,
        missing_env_vars: config.missing,
        config_problems: config.problems,
        default_org: config.defaultOrg ?? null,
        allowed_org_ids: config.allowedOrgIds ?? null,
        mode: config.writeMode ? 'write' : 'read',
        destructive_allowed: config.destructiveAllowed,
        write_allowlist: config.writeAllowlist ?? null,
        max_concurrency: config.maxConcurrency,
        toolsets_enabled: [...config.toolsets].sort(),
        toolsets_available: TOOLSETS,
        toolsets_default: DEFAULT_TOOLSETS,
        toolsets_env_var: ENV.toolsets,
        tools_listed: ctx.tools.size,
        ready,
        next_step: ready
          ? `Call ${TOOL_PREFIX}_test_connection to prove the credential works.`
          : `Set ${config.missing.join(', ')} ${where}. Create the API client in NinjaOne under Administration > Apps > API (client credentials grant).`,
      };
    },
  });

  defineTool(server, ctx, {
    name: `${TOOL_PREFIX}_status_gate`,
    kind: 'read',
    description:
      'Explain the write gate: the current mode, whether the destructive tier is open, the optional write allowlist, which tools each gate ' +
      `covers, and the environment variables (${ENV.mode}, ${ENV.allowDestructive}, ${ENV.writeAllowlist}) that change it. Call this when a write refuses.`,
    inputSchema: {},
    async handler(_args, { config, tools }) {
      return gateStatus(config, tools);
    },
  });

  defineTool(server, ctx, {
    name: `${TOOL_PREFIX}_test_connection`,
    kind: 'read',
    description:
      'Prove the credential works: requests an OAuth token and makes one cheap call (the first organization). Returns the base URL, the ' +
      'scopes granted, an organization count sample, and the round-trip time. A token error here means the client id, secret or region is wrong.',
    inputSchema: {},
    async handler(_args, { config, client }) {
      const started = Date.now();
      const orgs = await client.request<unknown>('GET', '/v2/organizations', { query: { pageSize: 1 } });
      const first = Array.isArray(orgs) && orgs[0] && typeof orgs[0] === 'object' ? (orgs[0] as Record<string, unknown>) : undefined;
      return {
        ok: true,
        base_url: config.baseUrl,
        region: config.region ?? null,
        scopes_requested: config.scopes,
        sample_organization: first ? { id: first.id ?? null, name: first.name ?? null } : null,
        latency_ms: Date.now() - started,
        next_step: `Call ${TOOL_PREFIX}_list_organizations or ${TOOL_PREFIX}_report_fleet_health.`,
      };
    },
  });
}
