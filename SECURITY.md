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

The Node HTTP lane (Azure Container Apps) and the Cloudflare Worker share one handler, `src/remote/`, and refuse the same things (LANES.md, section 4):

- No inbound auth configured: the container exits, the Worker answers 503. `MCP_HTTP_AUTH=none` works on loopback only.
- Entra ID tokens are checked for signature, issuer, tenant, audience, lifetime and scope or role. Cloudflare Access tokens are read from `Cf-Access-Jwt-Assertion` only, with the team domain and AUD pinned. Shared tokens must be at least 32 characters and are compared in constant time.
- Browser `Origin` headers must be allowed. A loopback listener answers loopback `Host` names only.
- Nothing is read from the URL: `/mcp` refuses query strings and extra path segments.
- The caller's token never reaches a tool, a log line or NinjaOne.
- Bodies are capped at 1 MB. Only `POST` is served; there are no sessions.

See [docs/deploy-azure.md](docs/deploy-azure.md) and [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md) for the trust boundaries.

## The real boundary

The gates bind this server only. Anyone holding the same API client credential can call NinjaOne directly, so grant the API client only the scopes it needs. `monitoring` alone makes every write impossible, whatever this server is configured to do.

## Supply chain

- Three runtime dependencies, the official MCP SDK, Zod and jose (JWT checks on the remote lanes), pinned exactly, with a committed lockfile.
- The single-file bundle in `plugins/ninjaone/server/` is rebuilt in CI and must match the committed copy.
- CI runs with read-only permissions, SHA-pinned actions and no secrets.
- Tests make no network calls beyond loopback.
