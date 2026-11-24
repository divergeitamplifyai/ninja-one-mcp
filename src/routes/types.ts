/**
 * The route table vocabulary.
 *
 * Most NinjaOne tools are one HTTP call with scoping, paging and safety rules
 * around it. Each is declared as a Route, and src/engine.ts turns every Route
 * into a tool through the same audited path: one place for the gate, the org
 * boundary, paging, read-back and dry runs. Hand-written tools in src/tools/
 * cover what is not one call (profiles, fleet reports, views).
 */

import type { Method } from '../client.js';
import type { ToolKind } from '../gate.js';

export type ParamType =
  | 'int'
  | 'number'
  | 'string'
  | 'bool'
  | 'date'
  | 'int[]'
  | 'string[]'
  | { enum: readonly [string, ...string[]] }
  | { enumList: readonly [string, ...string[]] };

export interface Param {
  in: 'path' | 'query';
  type: ParamType;
  /** What the model should know: meaning, format, example. */
  desc: string;
  required?: boolean;
  /** Upstream name when it differs from the tool argument (snake_case in, camelCase out). */
  wire?: string;
}

/**
 * How a route is held inside the organization boundary.
 *
 * - account:    account-wide configuration (policies, roles, templates). Reads are
 *               allowed under a boundary; writes are refused under one.
 * - org:        the path carries an organization id, resolved from `org`.
 * - orgFilter:  an optional query filter takes organization ids; under a boundary
 *               it is forced to the allowed ids. `rowField` re-checks rows.
 * - device:     the path carries a device id, checked against the boundary.
 * - df:         a device filter, narrowed to the boundary.
 * - rows:       cross-organization rows that carry an org field; rows outside the
 *               boundary are dropped and counted.
 * - unscoped:   cross-organization data with no org field: refused under a boundary.
 */
export type Scope =
  | { kind: 'account' }
  | { kind: 'org'; param: string }
  | { kind: 'orgFilter'; param: string; list: boolean; rowField?: string }
  | { kind: 'device'; param: string }
  | { kind: 'df'; rowField?: string }
  | { kind: 'rows'; field: string }
  | { kind: 'unscoped'; reason: string };

/**
 * Upstream paging style.
 *
 * - id:       pageSize + an id cursor param (after, olderThan, anchorId). The next
 *             cursor is the last row's id when the page came back full.
 * - cursor:   /v2/queries/* style: pageSize + cursor (name), response
 *             { cursor: { name }, results }.
 * - pageInfo: ITAM style: pageSize + after, response { results, pageInfo: { hasMore, nextCursor } }.
 * - local:    the endpoint returns everything; this server pages locally.
 */
export type Paging =
  | { style: 'id'; cursorParam: string; sizeParam?: string; idField?: string; lowest?: boolean }
  | { style: 'cursor'; sizeParam?: string }
  | { style: 'pageInfo'; sizeParam?: string }
  | { style: 'local' };

export interface ListSpec {
  paging: Paging;
  /** Key of the array in an object response (`results`, `activities`). Arrays need none. */
  items?: string;
  /** Compact field set returned by default. Omit to return whole rows. */
  compact?: readonly string[];
  /** Largest page this endpoint accepts. */
  maxPage?: number;
}

export interface BodySpec {
  /** object, array of objects, or a bare array of integer ids. */
  shape: 'object' | 'array' | 'ids';
  /** operationId whose request schema documents the body (see src/generated/bodies.ts). */
  op: string;
  required?: boolean;
  /** Extra guidance appended to the generated field list. */
  note?: string;
}

export interface Route {
  /** Tool name without the prefix: `list_devices`. */
  tool: string;
  kind: ToolKind;
  method: Method;
  /** Path template with {placeholders} named by Param.wire or the param key. */
  path: string;
  /** operationIds this tool covers, for docs/api-coverage.md. */
  ops: readonly string[];
  /** What it does, when to use it, what it returns, what to call next. */
  description: string;
  scope: Scope;
  params?: Record<string, Param>;
  body?: BodySpec;
  list?: ListSpec;
  /** Writes: a repeat call with the same arguments changes nothing more. */
  idempotent?: boolean;
  /** Can reach arbitrary external destinations (a webhook URL). */
  openWorld?: boolean;
  /** Never retry, even on 429 (scripts, reboots, patch apply). */
  noRetry?: boolean;
  /** The result carries secret values (signed URLs, installer links): requires reveal: true. */
  secret?: boolean;
  /** GET path template read before a write (returned as `before`) and after it (`after`). */
  readBack?: string;
  /** Batch or wide writes: take dry_run (default true) and return the request without sending it. */
  dryRun?: boolean;
  /** Fixed query values always sent (and never overridable). */
  fixedQuery?: Record<string, string | number | boolean>;
}
