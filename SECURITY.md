# Security

This server sits between an AI agent and a live RMM that can reboot machines and run scripts across many client organizations. Its gates, scoping and redaction are the reason it exists.

## Reporting a vulnerability

Report privately through [GitHub private vulnerability reporting](https://github.com/divergeitamplifyai/ninja-one-mcp/security/advisories/new). Include a description and, if you have one, a reproduction.

- Do not open a public issue, pull request or discussion for anything exploitable.
- Do not include credentials, tokens, tenant ids or client data in a report. If a secret was exposed, say which one and where, not its value.

You can expect an acknowledgement within three business days.

Vulnerabilities in NinjaOne itself go to NinjaOne: https://www.ninjaone.com/product-security/

## What the server is built to refuse

- **Changes by default.** It stays in read mode until `NINJAONE_MODE=write`. The destructive tier also needs `NINJAONE_ALLOW_DESTRUCTIVE=true`. Every change needs `confirm: true`, and wide changes are dry runs first.
- **Guessing a tenant.** No organization is inferred, ambiguous names are refused, and `NINJAONE_ALLOWED_ORG_IDS` is a hard boundary. Device filters can only be narrowed, devices are checked, and tools that cannot be scoped refuse.
- **Leaking a credential.**
  - The client secret travels only in the OAuth form body, and the token only in a bearer header.
  - Both are redacted from every result, error and log line.
  - Plaintext `http:` is refused off loopback.
  - Secure custom field values are never requested.
  - Signed URLs need both gates and `reveal: true`.
- **Replaying an action.** Scripts, reboots, patch installs and service control never retry, and a 5xx on a write is never replayed.
- **Following instructions in data.** Device names, ticket text and documents are data. The bundled skills tell the model to ignore instructions inside them.
- **Reporting a short read as complete.** Unknown response shapes are errors, and truncation and dropped rows are announced.

## Remote deployments

When the server runs over HTTP:

- It refuses to start off loopback without inbound authentication: Entra ID tokens, or shared tokens of at least 32 characters.
- Entra tokens are checked for signature, issuer, tenant, audience, lifetime and scope or role.
- Browser `Origin` headers must be allowed.
- The caller's token is never forwarded to NinjaOne.
- Bodies are capped at 1 MB.

On Cloudflare, the Worker in front also refuses to start a container without inbound auth, serves only the MCP, health and metadata paths, and replaces caller `X-Forwarded-*` headers.

See [docs/AZURE.md](docs/AZURE.md) and [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) for the trust boundaries.

## The real boundary

The gates bind this server only. Anyone holding the same API client credential can call NinjaOne directly, so grant the API client only the scopes it needs. `monitoring` alone makes every write impossible, whatever this server is configured to do.

## Supply chain

- Two runtime dependencies, the official MCP SDK and Zod, pinned exactly, with a committed lockfile.
- The single-file bundle in `plugins/ninjaone/server/` is rebuilt in CI and must match the committed copy.
- CI runs with read-only permissions, SHA-pinned actions and no secrets.
- Tests make no network calls beyond loopback.
