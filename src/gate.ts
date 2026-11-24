/**
 * The write gate.
 *
 * Two independent gates, both opened by a person editing the MCP client
 * configuration, never by a tool call:
 *
 *   1. `${ENV_PREFIX}_MODE=write` enables the write tier.
 *   2. `${ENV_PREFIX}_ALLOW_DESTRUCTIVE=true` additionally enables the
 *      destructive tier: deletes, reboots, secret rotation, raw non-GET
 *      passthrough, anything the API cannot undo.
 *
 * Write tools stay listed in read mode and refuse with the setting to change.
 * On top of both gates every write call carries `confirm: true`: the settings
 * are the operator's standing decision, `confirm` is the model stating that it
 * means this specific call.
 *
 * These gates bind this server only. An agent holding the same credential can
 * call the API directly; a read-only credential is the only boundary that binds
 * both paths.
 */

import { z } from 'zod';
import type { Config } from './config.js';
import { ENV, TOOL_PREFIX } from './constants.js';
import { GateError } from './errors.js';

export type ToolKind = 'read' | 'write' | 'destructive';

/** The `confirm` parameter every write and destructive tool takes. */
export const confirmParam = z
  .literal(true)
  .describe('Must be exactly true. States that this call changes live data. There is no undo from this server.');

/** The refusal for a tool of this kind under this configuration, or undefined when it may run. */
export function gateRefusal(kind: ToolKind, tool: string, config: Config): GateError | undefined {
  if (kind === 'read') return undefined;
  if (!config.writeMode) {
    return new GateError(
      `${tool} changes live data and this server is in read mode. Nothing was sent.`,
      `Ask the operator to set ${ENV.mode}=write in the MCP client configuration and restart the client. Do not retry until then.`,
    );
  }
  if (kind === 'destructive' && !config.destructiveAllowed) {
    return new GateError(
      `${tool} is in the destructive tier and the second gate is closed. Nothing was sent.`,
      `Ask the operator to set ${ENV.allowDestructive}=true (on top of ${ENV.mode}=write) and restart the client. Do not retry until then.`,
    );
  }
  if (config.writeAllowlist && !config.writeAllowlist.includes(tool)) {
    return new GateError(
      `${tool} is not in ${ENV.writeAllowlist}, which narrows the write tools this deployment may run. Nothing was sent.`,
      `Ask the operator to add ${tool} to ${ENV.writeAllowlist} (or clear it) and restart the client. Do not retry until then.`,
    );
  }
  return undefined;
}

/** Tools named in the write allowlist that this server does not register as writes. */
export function unknownAllowlistEntries(config: Config, tools: ReadonlyMap<string, ToolKind>): string[] {
  return (config.writeAllowlist ?? []).filter((name) => {
    const kind = tools.get(name);
    return kind === undefined || kind === 'read';
  });
}

/** What ninjaone_status_gate reports. */
export function gateStatus(config: Config, tools: ReadonlyMap<string, ToolKind>): Record<string, unknown> {
  const byKind = (kind: ToolKind) => [...tools].filter(([, k]) => k === kind).map(([name]) => name).sort();
  return {
    mode: config.writeMode ? 'write' : 'read',
    mode_env_var: ENV.mode,
    destructive_allowed: config.destructiveAllowed,
    destructive_env_var: ENV.allowDestructive,
    write_tools: byKind('write'),
    write_tools_runnable: config.writeMode,
    destructive_tools: byKind('destructive'),
    destructive_tools_runnable: config.destructiveAllowed,
    write_allowlist: config.writeAllowlist ?? null,
    write_allowlist_env_var: ENV.writeAllowlist,
    write_allowlist_unknown: unknownAllowlistEntries(config, tools),
    confirm_required: 'Every write and destructive call must pass confirm: true.',
    note:
      `When a write refuses, relay the refusal; it names the setting. These gates bind ${TOOL_PREFIX} tools only. ` +
      'A read-only API credential is the only boundary that also binds direct API use.',
  };
}
