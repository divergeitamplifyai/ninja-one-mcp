#!/usr/bin/env node
/**
 * Entry point.
 *
 *   stdio (default)              local clients: Claude Code, Claude Desktop, Codex, Cursor, VS Code
 *   --http or NINJAONE_TRANSPORT=http   remote: Streamable HTTP (Azure Container Apps), see docs/AZURE.md
 *
 * On stdio, stdout carries JSON-RPC and nothing else. Every log line goes to
 * stderr through logStderr, which redacts registered secrets.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { applyEnvFile } from './envfile.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';
import { loadHttpConfig, wantsHttp } from './http/config.js';
import { startHttpServer } from './http/server.js';
import { logStderr, registerSecret } from './redact.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const http = wantsHttp(process.argv.slice(2), process.env);
  // A container has no home-directory credentials file; only stdio reads it.
  const envFile = http ? undefined : applyEnvFile();
  const config = loadConfig();
  config.envFile = envFile;
  if (envFile?.problem) config.problems.push(envFile.problem);
  // Before anything can log.
  registerSecret(config.clientSecret);
  registerSecret(config.clientId);

  const summary = {
    server: SERVER_NAME,
    version: SERVER_VERSION,
    transport: http ? 'http' : 'stdio',
    mode: config.writeMode ? 'write' : 'read',
    destructive_allowed: config.destructiveAllowed,
    region: config.region ?? null,
    credentials_configured: config.clientId !== undefined && config.clientSecret !== undefined,
    missing_env_vars: config.missing,
    config_problems: config.problems,
    env_file_keys: config.envFile?.loaded ?? [],
  };

  if (http) {
    const httpConfig = loadHttpConfig(process.env);
    if (httpConfig.auth.mode === 'bearer') httpConfig.auth.tokens.forEach((t) => registerSecret(t));
    if (httpConfig.fatal.length > 0) {
      logStderr('error', 'http_config_invalid', { problems: httpConfig.fatal });
      process.exit(2);
    }
    await startHttpServer(config, httpConfig);
    logStderr('info', 'started', summary);
    const stop = () => process.exit(0);
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    return;
  }

  const { server, tools } = createServer(config);
  await server.connect(new StdioServerTransport());
  // Exit when the client closes stdin, instead of lingering as an orphan.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  logStderr('info', 'started', { ...summary, tools: tools.size });
}

main().catch((error: unknown) => {
  logStderr('error', 'fatal', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
