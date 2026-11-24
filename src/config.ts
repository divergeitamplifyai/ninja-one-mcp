/**
 * Configuration, read once from the environment at startup.
 *
 * Loading never throws. A server that exits on a missing variable cannot tell
 * anyone why, so problems are collected here and reported by
 * ninjaone_status_server, and each tool that needs a missing value refuses with
 * the variable's name. Security settings fail closed: an unrecognized gate value
 * means the gate stays shut.
 */

import { ENV, REGIONS, SCOPES, type Scope } from './constants.js';
import type { EnvFileResult } from './envfile.js';
import { parseToolsets, type Toolset } from './toolsets.js';

type Env = Record<string, string | undefined>;

export interface Config {
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** Region key when NINJAONE_REGION picked the host, otherwise undefined. */
  region: string | undefined;
  /** Instance base URL, or undefined when neither region nor base URL is usable. */
  baseUrl: string | undefined;
  /** Scopes requested for the access token. */
  scopes: Scope[];
  /** Default organization when a call omits `org`. The argument always wins. */
  defaultOrg: string | undefined;
  /** Hard boundary. When set, no call may touch an organization outside it. */
  allowedOrgIds: string[] | undefined;
  /** First gate: `NINJAONE_MODE=write`. */
  writeMode: boolean;
  /** Second gate: `NINJAONE_ALLOW_DESTRUCTIVE=true`, on top of write mode. */
  destructiveAllowed: boolean;
  /** Optional narrowing of the write surface to these tool names. */
  writeAllowlist: string[] | undefined;
  maxConcurrency: number;
  /** Toolsets this deployment lists (NINJAONE_TOOLSETS). */
  toolsets: Set<Toolset>;
  /** The credentials file, when one was found (set by the entry point). */
  envFile?: EnvFileResult | undefined;
  /** Required variables that are not set. */
  missing: string[];
  /** Values that are set but not usable, each naming the variable. */
  problems: string[];
}

function value(env: Env, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw ? raw : undefined;
}

function list(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return parts.length > 0 ? parts : undefined;
}

export function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === 'localhost';
}

export function loadConfig(env: Env = process.env): Config {
  const missing: string[] = [];
  const problems: string[] = [];

  const clientId = value(env, ENV.clientId);
  if (!clientId) missing.push(ENV.clientId);
  const clientSecret = value(env, ENV.clientSecret);
  if (!clientSecret) missing.push(ENV.clientSecret);

  // Host: NINJAONE_BASE_URL wins, then NINJAONE_REGION. No default region.
  let baseUrl: string | undefined;
  let region: string | undefined;
  const rawBase = value(env, ENV.baseUrl);
  const rawRegion = value(env, ENV.region)?.toLowerCase();
  if (rawBase) {
    try {
      const parsed = new URL(rawBase);
      // A credential must never cross a plaintext connection. Plain http is
      // accepted only for loopback, which is how tests reach a mock API.
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
        problems.push(`${ENV.baseUrl} must use https (plain http is allowed only for loopback). It was ignored.`);
      } else {
        baseUrl = `${parsed.protocol}//${parsed.host}`;
        if (parsed.pathname !== '/' && parsed.pathname !== '') {
          problems.push(`${ENV.baseUrl} should be the instance origin only; the path "${parsed.pathname}" was dropped.`);
        }
      }
    } catch {
      problems.push(`${ENV.baseUrl} is not an absolute URL. It was ignored.`);
    }
  }
  if (rawRegion) {
    const host = REGIONS[rawRegion];
    if (!host) {
      problems.push(`${ENV.region} is "${rawRegion}", which is not one of ${Object.keys(REGIONS).join(', ')}.`);
    } else if (!baseUrl) {
      baseUrl = host;
      region = rawRegion;
    } else if (!rawBase) {
      region = rawRegion;
    }
  }
  if (!baseUrl) missing.push(ENV.region);

  // Scopes. Default monitoring only: the least a read-only server needs.
  let scopes: Scope[] = ['monitoring'];
  const rawScopes = list(value(env, ENV.scopes)?.toLowerCase());
  if (rawScopes) {
    const unknown = rawScopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
    if (unknown.length > 0) problems.push(`${ENV.scopes} has unknown scopes: ${unknown.join(', ')}. They were dropped.`);
    const known = rawScopes.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
    if (known.length > 0) scopes = [...new Set(known)];
  }

  const mode = value(env, ENV.mode)?.toLowerCase();
  if (mode !== undefined && mode !== 'read' && mode !== 'write') {
    problems.push(`${ENV.mode} is "${mode}", which is not "read" or "write". Writes stay off.`);
  }
  const writeMode = mode === 'write';

  const destructive = value(env, ENV.allowDestructive)?.toLowerCase();
  if (destructive !== undefined && destructive !== 'true' && destructive !== 'false') {
    problems.push(`${ENV.allowDestructive} is "${destructive}", which is not "true" or "false". The destructive tier stays off.`);
  }
  const destructiveAllowed = destructive === 'true';
  if (destructiveAllowed && !writeMode) {
    problems.push(`${ENV.allowDestructive}=true has no effect until ${ENV.mode}=write is also set.`);
  }
  if (writeMode && !scopes.includes('management')) {
    problems.push(`${ENV.mode}=write is set but ${ENV.scopes} does not include management, so most writes will be rejected by NinjaOne (403).`);
  }

  const allowedOrgIds = list(value(env, ENV.allowedOrgIds));
  if (allowedOrgIds) {
    const bad = allowedOrgIds.filter((id) => !/^\d+$/.test(id));
    if (bad.length > 0) problems.push(`${ENV.allowedOrgIds} must be numeric organization ids; these are not: ${bad.join(', ')}.`);
  }

  const defaultOrg = value(env, ENV.orgId);
  if (defaultOrg && allowedOrgIds && /^\d+$/.test(defaultOrg) && !allowedOrgIds.includes(defaultOrg)) {
    problems.push(`${ENV.orgId} (${defaultOrg}) is not in ${ENV.allowedOrgIds}. Calls that rely on the default will be refused.`);
  }

  const writeAllowlist = list(value(env, ENV.writeAllowlist));

  let maxConcurrency = 4;
  const rawConcurrency = value(env, ENV.maxConcurrency);
  if (rawConcurrency) {
    const n = Number(rawConcurrency);
    if (Number.isInteger(n) && n >= 1 && n <= 16) maxConcurrency = n;
    else problems.push(`${ENV.maxConcurrency} must be an integer from 1 to 16. Using 4.`);
  }

  const toolsets = parseToolsets(value(env, ENV.toolsets));
  problems.push(...toolsets.problems);

  return {
    clientId,
    clientSecret,
    region,
    baseUrl,
    scopes,
    defaultOrg,
    allowedOrgIds,
    writeMode,
    destructiveAllowed: writeMode && destructiveAllowed,
    writeAllowlist,
    maxConcurrency,
    toolsets: toolsets.enabled,
    missing,
    problems,
  };
}
