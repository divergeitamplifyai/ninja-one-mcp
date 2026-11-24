<!--
README template for AmplifyAI MCP servers (LANES.md, section 9).
Keep every section, in this order, with these headings. Replace <...> and the
example rows. Delete this comment. No em dashes, no emojis.
-->

# <Vendor> MCP server

<One line: what the server lets an agent do, against which API, and that it is read only by default.>

## What it does

<Two to four sentences: who it is for, the main jobs (triage, reporting, changes), what it deliberately does not do (no raw passthrough, no secret reveal, and so on).>

## Install

Every lane runs the same server and reads the same settings (see Configuration).

### Local (stdio)

Requires Node 22 or later.

```bash
npm ci
npm run build
```

```json
{
  "mcpServers": {
    "<prefix>": {
      "command": "node",
      "args": ["/absolute/path/to/<repo>/dist/index.js"],
      "env": { "<PREFIX>_API_KEY": "<from your secret manager>", "<PREFIX>_MODE": "read" }
    }
  }
}
```

### Claude Desktop (.mcpb)

Download `<repo>-<version>.mcpb` from the latest release and open it. Fill in the
fields under Settings > Extensions. The credential field is stored by Claude
Desktop, not in a file.

### Claude Code plugin

```bash
claude plugin marketplace add divergeitamplifyai/<repo>
claude plugin install <name>@<repo>
```

Set `<PREFIX>_API_KEY` in your environment before starting Claude Code.

## Configuration

Every variable, from [.env.example](.env.example). With nothing set the server
still starts; `<prefix>_status_server` says what is missing.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `<PREFIX>_API_KEY` | yes | | <Vendor> API credential. Read only scopes unless writes are intended. |
| `<PREFIX>_BASE_URL` | no | `<https://api.vendor.example>` | Regional host. https only. |
| `<PREFIX>_ORG_ID` | no | | Default organization when a call omits `org`. |
| `<PREFIX>_ALLOWED_ORG_IDS` | no | | Hard boundary: comma-separated organization ids. |
| `<PREFIX>_MODE` | no | `read` | `write` enables the write tier. |
| `<PREFIX>_ALLOW_DESTRUCTIVE` | no | `false` | `true` also enables the destructive tier. Needs write mode. |
| `<PREFIX>_MAX_CONCURRENCY` | no | `4` | Fan-out cap for cross-organization reads. |

Remote hosting adds the `MCP_*` transport settings in
[LANES.md](LANES.md#3-environment-variables).

## Safety model

- **Read only by default.** Write tools are listed but refuse until
  `<PREFIX>_MODE=write`. The destructive tier (<deletes, reboots, rotation, ...>)
  also needs `<PREFIX>_ALLOW_DESTRUCTIVE=true`.
- **Every write takes `confirm: true`**, on the call itself.
- **No guessed tenants.** Organization-scoped tools take `org`; ambiguous names
  are refused with the candidates; `<PREFIX>_ALLOWED_ORG_IDS` is a hard boundary.
- **No credential in the transcript.** Credentials come from the environment,
  travel only in headers, and are redacted from results, errors and logs.
- **The real boundary is the credential.** The gates bind this server only;
  issue a read-only <vendor> credential wherever writes are not intended.

`mutations.json` records each tool's blast radius and rollback.

## Tools

<N> tools: <r> read, <v> interactive views, <w> write, <d> destructive.

### Diagnostics (3)

| Tool | Kind | Does |
|---|---|---|
| `<prefix>_status_server` | read | Configuration and missing settings, no API call. |
| `<prefix>_status_gate` | read | Gate state and the settings that change it. |
| `<prefix>_test_connection` | read | One cheap authenticated call. |

### <Group> (<count>)

| Tool | Kind | Does |
|---|---|---|
| `<prefix>_list_<noun>` | read | <...> |
| `<prefix>_update_<noun>` | write | <...> |
| `<prefix>_delete_<noun>` | destructive | <...> |

## Remote hosting

The same server runs as a shared remote MCP endpoint, read only by default:

- **Azure Container Apps**, Entra ID sign-in, credential in Key Vault:
  [docs/deploy-azure.md](docs/deploy-azure.md).
- **Cloudflare Workers**, Cloudflare Access or a bearer token:
  [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md).

Both deploy workflows are manual and off until `DEPLOY_AZURE_ENABLED` or
`DEPLOY_CLOUDFLARE_ENABLED` is set. Lane rules: [LANES.md](LANES.md).

## Development

```bash
npm ci
npm run check          # typecheck, tests, conformance, lane checks
npm run start:http     # local Streamable HTTP on 127.0.0.1:8080 (set MCP_HTTP_AUTH)
```

Tests use `node:test` against loopback mocks only. Standard and review checklist:
[STANDARD.md](STANDARD.md), [CHECKLIST.md](CHECKLIST.md). Agent instructions:
[AGENTS.md](AGENTS.md).

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Never include credentials, tenant ids or client data in an issue.

## License

<License, matching package.json.>
