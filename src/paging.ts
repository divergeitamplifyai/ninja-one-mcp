/**
 * List shaping: compact fields by default, opt-in full records, cursor paging,
 * and announced truncation.
 *
 * A list that floods the context is a list the model cannot use, and a list
 * that is quietly short is worse: it reads as a complete answer. So the default
 * is a compact field set, `fields: "all"` returns full records, every page says
 * whether there is more, and anything cut says so.
 */

import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './constants.js';

export const fieldsParam = z
  .union([z.literal('all'), z.array(z.string().min(1)).min(1)])
  .optional()
  .describe('Omit for the compact field set. "all" returns full records; a list of names returns just those fields.');

export const pageParams = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .describe(`Records per page, 1 to ${MAX_PAGE_SIZE}. Default ${DEFAULT_PAGE_SIZE}.`),
  cursor: z.string().min(1).optional().describe('Opaque cursor from next_cursor on the previous page. Omit for the first page.'),
};

export type Fields = 'all' | string[] | undefined;

/** Project a record onto the requested fields. Missing fields are omitted, not nulled. */
export function pickFields(record: Record<string, unknown>, compact: readonly string[], fields: Fields): Record<string, unknown> {
  if (fields === 'all') return record;
  const keys = fields ?? compact;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in record) out[key] = record[key];
  }
  return out;
}

export interface Page<T> {
  count: number;
  has_more: boolean;
  next_cursor?: string;
  items: T[];
  /** Present when a read came up short for a reason other than paging. */
  warning?: string;
}

export function page<T>(items: T[], nextCursor: string | undefined, warning?: string): Page<T> {
  return {
    count: items.length,
    has_more: nextCursor !== undefined,
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
    items,
    ...(warning === undefined ? {} : { warning }),
  };
}

/** For APIs paged by offset: an opaque cursor so callers never do offset arithmetic. */
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0) return parsed.o;
  } catch {
    // fall through
  }
  throw new Error('cursor is not one this server issued');
}

/** Keep text inside the budget, and say so when it was cut. */
export function capText(text: string, maxChars: number, tool: string): string {
  if (text.length <= maxChars) return text;
  const note =
    `\n\n[TRUNCATED] ${tool} returned ${text.length} characters, over the ${maxChars} limit. ` +
    'The JSON above is cut and will not parse. Retry with a smaller limit, fewer fields, or narrower filters.';
  return text.slice(0, Math.max(0, maxChars - note.length)) + note;
}
