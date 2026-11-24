/**
 * The organization directory and the deployment boundary.
 *
 * NinjaOne organizations are the tenants. This module is the single place that
 * turns an `org` argument into an organization id, checks a device against the
 * boundary, and narrows a device filter (`df`) to it. Rules (STANDARD.md S1-S4):
 *
 *  - The `org` argument wins over NINJAONE_ORG_ID.
 *  - An id or a unique, case-insensitive name fragment; ambiguity is refused.
 *  - Nothing is inferred.
 *  - NINJAONE_ALLOWED_ORG_IDS bounds every call, discovery and fan-out.
 */

import type { ApiClient } from './client.js';
import type { Config } from './config.js';
import { ENV, TOOL_PREFIX } from './constants.js';
import { ToolError } from './errors.js';
import { resolveOrg, visibleOrgs, type Org } from './tenants.js';

const DIRECTORY_TTL_MS = 5 * 60_000;
const DIRECTORY_PAGE = 500;
const DEVICE_ORG_TTL_MS = 10 * 60_000;

export interface OrgRecord extends Org {
  raw: Record<string, unknown>;
}

function asRecords(body: unknown, path: string): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object');
  throw new ToolError(`GET ${path} returned a response that is not a list.`, 'Report this as a server bug. Do not treat it as an empty result.');
}

export class OrgDirectory {
  private cache: { at: number; orgs: OrgRecord[] } | undefined;
  private deviceOrgs = new Map<string, { at: number; orgId: string }>();

  constructor(
    private readonly client: ApiClient,
    private readonly config: Config,
  ) {}

  /** Every organization the API client can see, paged with `after`. Cached for five minutes. */
  async all(): Promise<OrgRecord[]> {
    if (this.cache && Date.now() - this.cache.at < DIRECTORY_TTL_MS) return this.cache.orgs;
    const orgs: OrgRecord[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 200; guard++) {
      const body = await this.client.request('GET', '/v2/organizations', { query: { pageSize: DIRECTORY_PAGE, after } });
      const rows = asRecords(body, '/v2/organizations');
      for (const row of rows) {
        if (row.id === undefined || row.id === null) continue;
        orgs.push({ id: String(row.id), name: typeof row.name === 'string' ? row.name : `Organization ${String(row.id)}`, raw: row });
      }
      if (rows.length < DIRECTORY_PAGE) break;
      after = String(rows[rows.length - 1]?.id);
    }
    this.cache = { at: Date.now(), orgs };
    return orgs;
  }

  /** Organizations inside the boundary. */
  async visible(): Promise<OrgRecord[]> {
    return visibleOrgs(await this.all(), { allowedOrgIds: this.config.allowedOrgIds }) as OrgRecord[];
  }

  /** Resolve the `org` argument (or the default) to one organization inside the boundary. */
  async resolve(requested: string | undefined): Promise<OrgRecord> {
    const { defaultOrg, allowedOrgIds } = this.config;
    // A numeric id inside the boundary needs no directory read.
    const input = requested?.trim() || defaultOrg;
    if (input && /^\d+$/.test(input) && (!allowedOrgIds || allowedOrgIds.includes(input))) {
      const cached = this.cache?.orgs.find((o) => o.id === input);
      return cached ?? { id: input, name: `Organization ${input}`, raw: {} };
    }
    return resolveOrg(requested, await this.all(), { defaultOrg, allowedOrgIds }) as OrgRecord;
  }

  /** Refuse an organization id outside the boundary. No-op when there is no boundary. */
  assertAllowed(orgId: string | number | undefined, what: string): void {
    const allowed = this.config.allowedOrgIds;
    if (!allowed) return;
    if (orgId === undefined || orgId === null || !allowed.includes(String(orgId))) {
      throw new ToolError(
        `${what} belongs to organization ${orgId ?? '(unknown)'}, which is outside this deployment's boundary (${ENV.allowedOrgIds}).`,
        'Use a record inside the boundary. Widening it is an operator configuration change, not a tool argument.',
      );
    }
  }

  /** Check a device against the boundary. Reads the device only when a boundary is set. */
  async assertDevice(deviceId: string | number): Promise<void> {
    if (!this.config.allowedOrgIds) return;
    const key = String(deviceId);
    const hit = this.deviceOrgs.get(key);
    let orgId = hit && Date.now() - hit.at < DEVICE_ORG_TTL_MS ? hit.orgId : undefined;
    if (orgId === undefined) {
      const device = await this.client.request<Record<string, unknown>>('GET', `/v2/device/${encodeURIComponent(key)}`);
      orgId = device && device.organizationId !== undefined ? String(device.organizationId) : undefined;
      if (orgId !== undefined) this.deviceOrgs.set(key, { at: Date.now(), orgId });
    }
    this.assertAllowed(orgId, `Device ${key}`);
  }

  /** The device filter to send: the caller's filter narrowed to the boundary. */
  boundedDf(df: string | undefined): string | undefined {
    const allowed = this.config.allowedOrgIds;
    const own = df?.trim() || undefined;
    if (!allowed) return own;
    // NinjaOne device filters only combine with AND, so appending narrows and can never widen.
    const bound = `org in (${allowed.join(',')})`;
    return own ? `${own} AND ${bound}` : bound;
  }

  /** Refuse a call that cannot be scoped while a boundary is set. */
  assertUnbounded(tool: string, reason: string): void {
    if (!this.config.allowedOrgIds) return;
    throw new ToolError(
      `${tool} cannot be limited to the organizations in ${ENV.allowedOrgIds} (${reason}), so it is refused while that boundary is set.`,
      `Use an organization-scoped tool instead (${TOOL_PREFIX}_list_organizations lists them), or ask the operator to clear ${ENV.allowedOrgIds} for this deployment.`,
    );
  }
}
