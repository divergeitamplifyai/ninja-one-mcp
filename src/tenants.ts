/**
 * Organization (tenant) scoping for multi-tenant and MSP accounts.
 *
 * One wrong organization id reads or writes another client's data, so this is
 * the single place that decides which organization a call may touch:
 *
 *  - The `org` argument wins over the `${ENV_PREFIX}_ORG_ID` default.
 *  - `org` accepts an id or a unique, case-insensitive name fragment.
 *  - An ambiguous name is refused with the candidates. Never pick the first.
 *  - Never infer an organization: no "first in the list", no "only one visible".
 *  - `${ENV_PREFIX}_ALLOWED_ORG_IDS`, when set, bounds everything, and
 *    organizations outside it are not even offered as candidates.
 */

import { z } from 'zod';
import { ENV, TOOL_PREFIX } from './constants.js';
import { ToolError } from './errors.js';

export interface Org {
  id: string;
  name: string;
}

export const orgParam = z
  .string()
  .min(1)
  .optional()
  .describe(
    `Organization id, or a unique part of its name (case-insensitive). Overrides ${ENV.orgId}. ` +
      `An ambiguous name is refused with the candidates; call ${TOOL_PREFIX}_list_organizations to see them all.`,
  );

export interface ScopeOptions {
  defaultOrg?: string | undefined;
  allowedOrgIds?: string[] | undefined;
}

/** Organizations this deployment may see at all. */
export function visibleOrgs(orgs: Org[], options: ScopeOptions): Org[] {
  const allowed = options.allowedOrgIds;
  return allowed ? orgs.filter((org) => allowed.includes(org.id)) : orgs;
}

const MAX_CANDIDATES = 10;

/** Resolve the organization for one call, or throw a ToolError that says what to pass instead. */
export function resolveOrg(requested: string | undefined, orgs: Org[], options: ScopeOptions): Org {
  const input = requested?.trim() || options.defaultOrg;
  if (!input) {
    throw new ToolError(
      'This call needs an organization and none was given. The server does not infer one.',
      `Pass org (an id or a unique name fragment), or set ${ENV.orgId}. Call ${TOOL_PREFIX}_list_organizations to see the choices.`,
    );
  }

  const visible = visibleOrgs(orgs, options);

  const byId = visible.find((org) => org.id === input);
  if (byId) return byId;

  // An id outside the allowlist is refused by name, not treated as "not found",
  // so the caller learns it is a boundary rather than a typo.
  if (options.allowedOrgIds && orgs.some((org) => org.id === input)) {
    throw new ToolError(
      `Organization ${input} is outside this deployment's boundary (${ENV.allowedOrgIds}).`,
      'Use an organization inside the boundary. Widening it is an operator configuration change, not a tool argument.',
    );
  }

  const needle = input.toLowerCase();
  const exact = visible.filter((org) => org.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0] as Org;

  const partial = exact.length > 1 ? exact : visible.filter((org) => org.name.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0] as Org;

  if (partial.length > 1) {
    const shown = partial.slice(0, MAX_CANDIDATES).map((org) => `${org.name} (${org.id})`);
    const more = partial.length > MAX_CANDIDATES ? ` and ${partial.length - MAX_CANDIDATES} more` : '';
    throw new ToolError(
      `"${input}" matches ${partial.length} organizations: ${shown.join('; ')}${more}.`,
      'Retry with the id of the one you mean, or a longer part of its name.',
    );
  }

  throw new ToolError(
    `No organization matches "${input}".`,
    `Call ${TOOL_PREFIX}_list_organizations or ${TOOL_PREFIX}_find_organization and retry with an id from it.`,
  );
}
