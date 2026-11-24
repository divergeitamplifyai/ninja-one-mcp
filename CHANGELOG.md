# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-23

First release.

### Added

- **Coverage:** all 315 operations in the NinjaOne Public API v2 (spec 2.0.9-draft), with 302 typed tools and 13 operations reachable through the gated passthrough. `docs/api-coverage.md` maps each one.
- **Tools:** 315 in all, in 16 toolsets. The default set lists 107.
- **Safety:**
  - Read-only by default, with two gates (`NINJAONE_MODE`, `NINJAONE_ALLOW_DESTRUCTIVE`), `confirm: true` on every change, and an optional write allowlist.
  - Dry runs for wide writes, and `before`/`after` read-back on writes.
  - Organization boundary (`NINJAONE_ALLOWED_ORG_IDS`) with `df` narrowing, device checks and row re-checks.
  - Secrets: secure values are never requested, signed URLs only behind both gates and `reveal: true`, and redaction everywhere.
- **Auth:** OAuth 2.0 client credentials for every NinjaOne region, with token caching and single-flight refresh.
- **Workflows:** `ninjaone_report_fleet_health`, `ninjaone_get_device_profile`, `ninjaone_list_board_tickets`, `ninjaone_add_ticket_comment`.
- **Views:** interactive MCP Apps views for the fleet, a device, and alerts.
- **Resources:** NinjaOne's public docs index (`llms.txt`) and the device filter guide.
- **Plugin:** the NinjaOne plugin for Claude Code and Codex, with a bundled server and four skills.
- **Claude Desktop:** a `.mcpb` bundle.
- **Configuration:** an optional credentials file for hosts that filter the environment.
- **Tests:**
  - A conformance suite with 5,184 checks.
  - 47 tests against a loopback NinjaOne mock that reproduces the API's dangerous behaviors, including the HTTP transport and Entra token validation.
  - CI drift checks on every generated file.
- **Website:** at https://patrickking67.github.io/ninja-one-mcp/.
- **Remote transport:** Streamable HTTP (`--http`), stateless, with Microsoft Entra ID or shared-token auth, RFC 9728 protected resource metadata, Origin checks and `/healthz`.
- **Azure Container Apps deployment:** Bicep, azd, Key Vault, managed identity, a distroless image published to GHCR, an Entra app registration script, and docs/AZURE.md.
- **Prompts:** fleet triage, patch review, device triage and connection check.
- **Ticketing:** `ninjaone_add_ticket_comment` posts internal notes only. `ninjaone_send_ticket_reply` sends public replies and sits in the destructive tier.
