/**
 * Errors that tell the caller what to do next.
 *
 * Every error a tool returns ends with a line that starts `Next step:`. The
 * calling model reads that line and acts on it, so it names the argument,
 * environment variable, or tool that fixes the problem.
 */

import { ENV, TOOL_PREFIX } from './constants.js';
import { redact } from './redact.js';

export class ToolError extends Error {
  constructor(
    message: string,
    readonly nextStep: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A refusal from the write gate or the confirm check. Nothing was sent upstream. */
export class GateError extends ToolError {}

/** A non-2xx response from the upstream API. */
export class ApiError extends ToolError {
  constructor(
    message: string,
    nextStep: string,
    readonly status: number,
  ) {
    super(message, nextStep);
  }
}

/** Map an upstream status to a message and a next step. */
/** Pull NinjaOne's own error text (resultCode, errorMessage, message) out of a response body, kept short. */
export function upstreamDetail(body: string | undefined): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const parts = ['resultCode', 'errorMessage', 'message', 'error', 'error_description', 'incidentId']
      .map((key) => (typeof parsed[key] === 'string' && parsed[key] !== '' ? `${key}: ${parsed[key] as string}` : undefined))
      .filter(Boolean);
    if (parts.length > 0) return ` NinjaOne said: ${parts.join('; ').slice(0, 300)}.`;
  } catch {
    // not JSON
  }
  const text = body.replace(/\s+/g, ' ').trim();
  return text && text.length <= 200 && !text.startsWith('<') ? ` NinjaOne said: ${text}.` : '';
}

export function apiErrorFor(status: number, method: string, path: string, retryAfterSeconds?: number, body?: string): ApiError {
  const where = `${method} ${path}`;
  const said = upstreamDetail(body);
  switch (status) {
    case 400:
    case 422:
      return new ApiError(
        `The API rejected ${where} as invalid (${status}).${said}`,
        'Check the arguments against the tool description and retry with corrected values.',
        status,
      );
    case 401:
      return new ApiError(
        `NinjaOne rejected the access token on ${where} (401), even after a fresh token.${said}`,
        `Check ${ENV.clientId}, ${ENV.clientSecret} and ${ENV.region}, then call ${TOOL_PREFIX}_test_connection.`,
        status,
      );
    case 403:
      return new ApiError(
        `The API client is not permitted to call ${where} (403).${said}`,
        `Check the scopes in ${ENV.scopes} (writes need management; scripts and remote actions need control) and the API client's permissions in NinjaOne (Administration > Apps > API). Do not retry unchanged.`,
        status,
      );
    case 404:
      return new ApiError(
        `Nothing exists at ${where} (404).${said}`,
        `Check the id with the matching list tool. Some NinjaOne features (ticketing, documentation, backup, billing) return 404 when the feature is not enabled on the account.`,
        status,
      );
    case 409:
      return new ApiError(
        `The API reported a conflict on ${where} (409).${said}`,
        'Read the record again and retry against its current state.',
        status,
      );
    case 429:
      return new ApiError(
        `The API is rate limiting ${where} (429) and retries were exhausted.`,
        `Wait ${retryAfterSeconds ?? 60} seconds, then retry once. Narrow the request if it fans out.`,
        status,
      );
    default:
      if (status >= 500) {
        return new ApiError(
          `The API returned a server error on ${where} (${status}).${said}`,
          'This is an upstream fault. Retry later; a write may or may not have applied, so read the record before retrying a write.',
          status,
        );
      }
      return new ApiError(`The API returned an unexpected status ${status} on ${where}.${said}`, 'Retry once, then report it.', status);
  }
}

/** Render any thrown value as a redacted message that ends with the next step. */
export function formatError(error: unknown): string {
  if (error instanceof ToolError) {
    return redact(`${error.message}\nNext step: ${error.nextStep}`);
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'The request to the API timed out.\nNext step: Retry once, or narrow the request with filters or a smaller limit.';
  }
  const detail = error instanceof Error ? error.message : String(error);
  return redact(
    `Unexpected error: ${detail}\nNext step: Call ${TOOL_PREFIX}_status_server to check configuration, then retry.`,
  );
}
