/**
 * Credential redaction.
 *
 * A live credential must never reach a tool result, an error, or a log line.
 * Every value that is a secret is registered here at startup, and everything
 * printable passes through `redact` on the way out.
 */

const REDACTED = '[REDACTED]';
const secrets: string[] = [];

/** Register a value that must never appear in output. Short values are ignored. */
export function registerSecret(value: string | undefined): void {
  if (!value || value.length < 8 || secrets.includes(value)) return;
  secrets.push(value);
  // Longest first, so a secret that contains another is scrubbed whole.
  secrets.sort((a, b) => b.length - a.length);
}

/** Credential-shaped text that was never registered, scrubbed anyway. */
const PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/gi,
  /\b(api[_-]?key|access_token|refresh_token|client_secret|client_id|token|secret|password)=[^&\s"']+/gi,
  /"(access_token|refresh_token|client_secret)"\s*:\s*"[^"]+"/gi,
];

export function redact(input: string): string {
  let out = input;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match) => {
      if (match.startsWith('"')) return `${match.slice(0, match.indexOf(':') + 1)} "${REDACTED}"`;
      const eq = match.indexOf('=');
      if (eq !== -1) return `${match.slice(0, eq + 1)}${REDACTED}`;
      return `Bearer ${REDACTED}`;
    });
  }
  return out;
}

/**
 * Log to stderr as one JSON line. stdout is the JSON-RPC channel on stdio, so
 * nothing else may ever write there. On Workers, where there is no stderr
 * stream, the line goes to console.error, which Workers Logs collects.
 */
export function logStderr(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const line = redact(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }));
  const stderr = typeof process !== 'undefined' ? process.stderr : undefined;
  if (stderr && typeof stderr.write === 'function') stderr.write(`${line}\n`);
  else console.error(line);
}
