#!/usr/bin/env node
/**
 * Entry point for the stdio lanes (LANES.md a, b and c): local clients such as
 * Claude Code, Claude Desktop, Codex, Cursor and VS Code. The remote lanes have
 * their own entries: src/http/main.ts (Node, the container) and
 * src/worker/index.ts (Cloudflare Workers).
 *
 * stdout carries JSON-RPC and nothing else. Every log line goes to stderr
 * through logStderr, which redacts registered secrets.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { applyEnvFile, defaultEnvFilePath } from './envfile.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';
import { logStderr, registerSecret } from './redact.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  // Only stdio reads the credentials file; a container or Worker has none.
  const envFile = applyEnvFile();
  const config = loadConfig();
  config.envFile = envFile;
  config.envFilePath = defaultEnvFilePath();
  if (envFile?.problem) config.problems.push(envFile.problem);
  // Before anything can log.
  registerSecret(config.clientSecret);
  registerSecret(config.clientId);

  const { server, tools } = createServer(config, { transport: 'stdio' });
  await server.connect(new StdioServerTransport());
  // Exit when the client closes stdin, instead of lingering as an orphan.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  logStderr('info', 'started', {
    server: SERVER_NAME,
    version: SERVER_VERSION,
    transport: 'stdio',
    mode: config.writeMode ? 'write' : 'read',
    destructive_allowed: config.destructiveAllowed,
    region: config.region ?? null,
    credentials_configured: config.clientId !== undefined && config.clientSecret !== undefined,
    missing_env_vars: config.missing,
    config_problems: config.problems,
    env_file_keys: config.envFile?.loaded ?? [],
    tools: tools.size,
  });
}

main().catch((error: unknown) => {
  logStderr('error', 'fatal', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
