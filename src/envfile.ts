/**
 * Optional credentials file, for hosts that do not pass environment variables
 * to MCP servers (some plugin hosts start servers with a filtered environment).
 *
 * Path: NINJAONE_ENV_FILE ("none" disables it), else $XDG_CONFIG_HOME/ninja-one-mcp/.env, else
 * ~/.config/ninja-one-mcp/.env. Format: KEY=VALUE lines, # comments.
 *
 * Rules:
 *  - Only NINJAONE_* keys are read. Anything else is ignored.
 *  - The process environment always wins over the file.
 *  - On POSIX the file must not be readable by group or others (chmod 600);
 *    otherwise it is ignored and status_server says why.
 *  - Values are never logged; only key names are reported.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ENV_PREFIX } from './constants.js';

export interface EnvFileResult {
  path: string;
  /** Keys taken from the file (not already set in the environment). */
  loaded: string[];
  problem?: string;
}

export function defaultEnvFilePath(env: Record<string, string | undefined> = process.env): string {
  if (env[`${ENV_PREFIX}_ENV_FILE`]) return env[`${ENV_PREFIX}_ENV_FILE`] as string;
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'ninja-one-mcp', '.env');
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !m[1]?.startsWith(`${ENV_PREFIX}_`)) continue;
    let value = (m[2] ?? '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

/** Merge the file into `env` in place (environment wins). Never throws. */
export function applyEnvFile(env: Record<string, string | undefined> = process.env): EnvFileResult | undefined {
  if (env[`${ENV_PREFIX}_ENV_FILE`]?.toLowerCase() === 'none') return undefined;
  const path = defaultEnvFilePath(env);
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return env[`${ENV_PREFIX}_ENV_FILE`] ? { path, loaded: [], problem: `${ENV_PREFIX}_ENV_FILE points to ${path}, which does not exist.` } : undefined;
  }
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    return { path, loaded: [], problem: `${path} is readable by other users, so it was ignored. Run: chmod 600 "${path}"` };
  }
  try {
    const values = parseEnvFile(readFileSync(path, 'utf8'));
    const loaded: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (env[key] === undefined || env[key] === '') {
        env[key] = value;
        loaded.push(key);
      }
    }
    return { path, loaded };
  } catch (error) {
    return { path, loaded: [], problem: `${path} could not be read (${error instanceof Error ? error.message : 'error'}).` };
  }
}
