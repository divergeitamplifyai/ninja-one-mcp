#!/usr/bin/env node
/**
 * Entry point for the Node HTTP lane: `node dist/http/main.js`.
 *
 * Binds MCP_HTTP_HOST (default 127.0.0.1) on MCP_HTTP_PORT (default 8080).
 * Exits non-zero, before listening, when the settings are unsafe; the log line
 * names each problem and the variable that fixes it.
 */

import { loadConfig } from '../config.js';
import { SERVER_NAME, SERVER_VERSION } from '../constants.js';
import { logStderr, registerSecret } from '../redact.js';
import { loadRemoteSettings } from '../remote/settings.js';
import { startHttpServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  registerSecret(config.clientSecret);
  registerSecret(config.clientId);
  const settings = loadRemoteSettings(process.env, 'node');
  if (settings.auth.mode === 'bearer') for (const token of settings.auth.tokens) registerSecret(token);

  if (settings.fatal.length > 0) {
    for (const problem of settings.fatal) logStderr('error', 'http_settings_unsafe', { problem });
    logStderr('error', 'fatal', { error: 'Refusing to start the HTTP listener. Fix the settings above and start again.' });
    process.exit(1);
  }

  const running = await startHttpServer({ config, settings });
  logStderr('info', 'started', {
    server: SERVER_NAME,
    version: SERVER_VERSION,
    transport: 'http',
    port: running.port,
    credentials_configured: config.clientId !== undefined && config.clientSecret !== undefined,
    missing_env_vars: config.missing,
    config_problems: config.problems,
  });

  const stop = (signal: string) => {
    logStderr('info', 'stopping', { signal });
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  logStderr('error', 'fatal', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
