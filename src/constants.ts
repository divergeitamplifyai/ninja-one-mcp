/**
 * Names, environment variables, regions and limits. Keep the prefixes in sync
 * with `mcpServer` in package.json, which the conformance script reads.
 */

/** Tool name prefix: every tool is `${TOOL_PREFIX}_<verb>_<noun>`. */
export const TOOL_PREFIX = 'ninjaone';

/** Environment variable prefix: `${ENV_PREFIX}_MODE`, `${ENV_PREFIX}_CLIENT_ID`, ... */
export const ENV_PREFIX = 'NINJAONE';

export const SERVER_NAME = 'ninja-one-mcp';
export const SERVER_TITLE = 'NinjaOne';
export const SERVER_VERSION = '0.1.0';

/**
 * NinjaOne instances are regional, and an API client exists in exactly one of
 * them. There is no default: sending a credential to the wrong region fails,
 * and guessing would hide which instance the operator meant.
 */
export const REGIONS: Readonly<Record<string, string>> = {
  us: 'https://app.ninjarmm.com',
  us2: 'https://us2.ninjarmm.com',
  eu: 'https://eu.ninjarmm.com',
  ca: 'https://ca.ninjarmm.com',
  oc: 'https://oc.ninjarmm.com',
};

/** OAuth 2.0 token endpoint, relative to the instance base URL. */
export const TOKEN_PATH = '/ws/oauth/token';

/** OAuth scopes NinjaOne issues to API clients. */
export const SCOPES = ['monitoring', 'management', 'control'] as const;
export type Scope = (typeof SCOPES)[number];

export const ENV = {
  clientId: `${ENV_PREFIX}_CLIENT_ID`,
  clientSecret: `${ENV_PREFIX}_CLIENT_SECRET`,
  region: `${ENV_PREFIX}_REGION`,
  baseUrl: `${ENV_PREFIX}_BASE_URL`,
  scopes: `${ENV_PREFIX}_SCOPES`,
  orgId: `${ENV_PREFIX}_ORG_ID`,
  allowedOrgIds: `${ENV_PREFIX}_ALLOWED_ORG_IDS`,
  mode: `${ENV_PREFIX}_MODE`,
  allowDestructive: `${ENV_PREFIX}_ALLOW_DESTRUCTIVE`,
  writeAllowlist: `${ENV_PREFIX}_WRITE_ALLOWLIST`,
  maxConcurrency: `${ENV_PREFIX}_MAX_CONCURRENCY`,
  toolsets: `${ENV_PREFIX}_TOOLSETS`,
} as const;

/** Largest tool result we return. Clients reject or cut results past this. */
export const MAX_RESULT_CHARS = 100_000;

/** Default and maximum page size for list tools. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

/** Per-request timeout for upstream calls. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Refresh the access token this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;
