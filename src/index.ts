#!/usr/bin/env node
/**
 * Entry point: stdio transport.
 *
 * stdout carries JSON-RPC and nothing else. Every log line goes to stderr
 * through logStderr, which redacts registered secrets.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { applyEnvFile } from './envfile.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';
import { logStderr, registerSecret } from './redact.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const envFile = applyEnvFile();
  const config = loadConfig();
  config.envFile = envFile;
  if (envFile?.problem) config.problems.push(envFile.problem);
  // Before anything can log.
  registerSecret(config.clientSecret);
  registerSecret(config.clientId);

  const { server, tools } = createServer(config);
  await server.connect(new StdioServerTransport());
  // Exit when the client closes stdin, instead of lingering as an orphan.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));

  logStderr('info', 'started', {
    server: SERVER_NAME,
    version: SERVER_VERSION,
    tools: tools.size,
    mode: config.writeMode ? 'write' : 'read',
    destructive_allowed: config.destructiveAllowed,
    region: config.region ?? null,
    credentials_configured: config.clientId !== undefined && config.clientSecret !== undefined,
    missing_env_vars: config.missing,
    config_problems: config.problems,
    env_file_keys: config.envFile?.loaded ?? [],
  });
}

main().catch((error: unknown) => {
  logStderr('error', 'fatal', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
