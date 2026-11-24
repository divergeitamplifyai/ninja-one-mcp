/**
 * OAuth 2.0 client credentials against the NinjaOne instance.
 *
 * The client id and secret travel in a form-encoded POST body to the token
 * endpoint, never in a query string. The access token is cached until shortly
 * before it expires, concurrent callers share one in-flight request, and every
 * token is registered with the redactor the moment it arrives.
 */

import type { Config } from './config.js';
import { ENV, REQUEST_TIMEOUT_MS, SERVER_NAME, SERVER_VERSION, TOKEN_PATH, TOKEN_REFRESH_MARGIN_MS, TOOL_PREFIX } from './constants.js';
import { ToolError } from './errors.js';
import { registerSecret } from './redact.js';

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class TokenProvider {
  private cached: CachedToken | undefined;
  private inflight: Promise<string> | undefined;

  constructor(
    private readonly config: Config,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws a ToolError naming the variable when the server cannot authenticate at all. */
  assertConfigured(): { baseUrl: string; clientId: string; clientSecret: string } {
    const { baseUrl, clientId, clientSecret } = this.config;
    const missing = [!clientId && ENV.clientId, !clientSecret && ENV.clientSecret, !baseUrl && ENV.region].filter(Boolean);
    if (missing.length > 0 || !baseUrl || !clientId || !clientSecret) {
      throw new ToolError(
        `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set, so this server cannot call NinjaOne.`,
        `Ask the operator to set ${missing.join(', ')} in the MCP client configuration and restart the client. ${TOOL_PREFIX}_status_server shows the full configuration.`,
      );
    }
    return { baseUrl, clientId, clientSecret };
  }

  /** Forget the cached token, e.g. after the API rejected it with 401. */
  invalidate(): void {
    this.cached = undefined;
  }

  async token(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) return this.cached.value;
    if (!this.inflight) {
      this.inflight = this.fetchToken().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const { baseUrl, clientId, clientSecret } = this.assertConfigured();
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: this.config.scopes.join(' '),
    });
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${TOKEN_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': `${SERVER_NAME}/${SERVER_VERSION}`,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ToolError(
        `Could not reach the NinjaOne token endpoint at ${baseUrl}${TOKEN_PATH} (${error instanceof Error ? error.name : 'network error'}).`,
        `Check ${ENV.region} or ${ENV.baseUrl}: the API client exists in exactly one regional instance.`,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      // NinjaOne answers a bad client id or secret with 400/401 invalid_client.
      if (/client app not exist/i.test(text)) {
        throw new ToolError(
          `NinjaOne has no API client with this id in ${baseUrl} (${response.status}: client app not exist).`,
          `An API client exists in one regional instance only. Check ${ENV.region} (us, us2, eu, ca, oc) matches the instance you sign in to, then check ${ENV.clientId}.`,
        );
      }
      const reason = /invalid_client|unauthorized|invalid_grant/i.test(text) ? ' (invalid client credentials)' : /invalid_scope/i.test(text) ? ' (scope not allowed for this client)' : '';
      throw new ToolError(
        `NinjaOne refused the token request with ${response.status}${reason}.`,
        reason.includes('scope')
          ? `Set ${ENV.scopes} to scopes this API client is allowed (Administration > Apps > API in NinjaOne), then restart.`
          : `Check ${ENV.clientId}, ${ENV.clientSecret} and ${ENV.region}. The API client must use the Client Credentials grant. Then call ${TOOL_PREFIX}_test_connection.`,
      );
    }
    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new ToolError('The NinjaOne token endpoint returned a response that is not JSON.', `Check ${ENV.baseUrl}; it must be the instance origin, not a proxy or web page.`);
    }
    if (typeof parsed.access_token !== 'string' || parsed.access_token === '') {
      throw new ToolError('The NinjaOne token endpoint returned no access_token.', 'Report this as a server bug, with the region in use.');
    }
    registerSecret(parsed.access_token);
    const seconds = typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : 3600;
    this.cached = { value: parsed.access_token, expiresAt: this.now() + seconds * 1000 };
    return parsed.access_token;
  }
}
