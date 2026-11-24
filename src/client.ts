/**
 * NinjaOne Public API client.
 *
 *  - The bearer token goes in a header, never a query string, and is never logged.
 *  - A 401 drops the cached token and retries once with a fresh one.
 *  - 429 means the request was not processed, so any method may retry, honoring
 *    Retry-After. 5xx and network errors are ambiguous, so only GET retries:
 *    replaying a POST can run a script or create a ticket twice.
 *  - Calls marked `noRetry` (scripts, patch apply, reboots) never retry, not
 *    even on 429, so an action is never queued twice.
 */

import { TokenProvider } from './auth.js';
import type { Config } from './config.js';
import { REQUEST_TIMEOUT_MS, SERVER_NAME, SERVER_VERSION } from './constants.js';
import { apiErrorFor } from './errors.js';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type QueryValue = string | number | boolean | undefined | readonly (string | number)[];

export interface RequestOptions {
  query?: Record<string, QueryValue> | undefined;
  /** JSON body. */
  body?: unknown;
  /** Multipart body, for upload endpoints. */
  form?: FormData;
  /** Never retry this call, even on 429. */
  noRetry?: boolean;
  /** Return the raw text instead of parsing JSON (downloads). */
  raw?: boolean;
}

const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_SECONDS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  // Full jitter: a random wait up to an exponentially growing ceiling.
  return Math.floor(Math.random() * 250 * 2 ** attempt);
}

export function buildUrl(baseUrl: string, path: string, query: Record<string, QueryValue> = {}): URL {
  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    // NinjaOne takes list filters as comma-separated values.
    url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return url;
}

export class ApiClient {
  readonly tokens: TokenProvider;

  constructor(private readonly config: Config) {
    this.tokens = new TokenProvider(config);
  }

  async request<T = unknown>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
    const { baseUrl } = this.tokens.assertConfigured();
    const url = buildUrl(baseUrl, path, options.query);
    let refreshed = false;

    for (let attempt = 1; ; attempt++) {
      const token = await this.tokens.token();
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: options.raw ? '*/*' : 'application/json',
            'user-agent': `${SERVER_NAME}/${SERVER_VERSION}`,
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(options.form ? { body: options.form } : options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (method === 'GET' && !options.noRetry && attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw error;
      }

      if (response.status === 401 && !refreshed) {
        // The token may have been revoked or expired early. One fresh try.
        await response.body?.cancel();
        this.tokens.invalidate();
        refreshed = true;
        attempt--;
        continue;
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        if (options.raw) return text as T;
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          // Some NinjaOne endpoints answer with plain text (a URL, an id).
          return text as T;
        }
      }

      const retryAfter = Number(response.headers.get('retry-after'));
      const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;
      const retriable = !options.noRetry && (response.status === 429 || (method === 'GET' && response.status >= 500));
      if (retriable && attempt < MAX_ATTEMPTS && (retryAfterSeconds ?? 0) <= MAX_RETRY_AFTER_SECONDS) {
        await response.body?.cancel();
        await sleep(retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : backoffMs(attempt));
        continue;
      }
      const detail = await response.text().catch(() => '');
      throw apiErrorFor(response.status, method, url.pathname, retryAfterSeconds, detail);
    }
  }
}
