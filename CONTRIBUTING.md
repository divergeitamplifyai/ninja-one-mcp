# Contributing

Thanks for helping. This project puts safety first: a change that adds a feature and weakens a gate will not be merged.

## Before you start

- Open an issue for anything larger than a small fix, so we can agree on the approach.
- Never include real tenant data, client names, credentials, or console screenshots with identifiers in issues, pull requests, tests or fixtures.

## Setup

```bash
git clone https://github.com/patrickking67/ninja-one-mcp.git
cd ninja-one-mcp
npm ci
npm run check
```

Node 22 or later. Tests run against a loopback mock, so no NinjaOne account is needed.

To try it against a real instance, use a read-only API client (`monitoring` scope):

```bash
NINJAONE_CLIENT_ID=... NINJAONE_CLIENT_SECRET=... NINJAONE_REGION=us npx @modelcontextprotocol/inspector node dist/index.js
```

## Making a change

- Read [AGENTS.md](AGENTS.md) ("Rules that outrank everything else") and [docs/DESIGN.md](docs/DESIGN.md).
- Most endpoint work is a `Route` in `src/routes/`. The engine applies the gate, scope, paging and read-back for you.
- Run `npm run gen` after changing routes, tools or the spec, then `npm run mutations`, and review the new entries' blast radius and rollback.
- `npm run check` must pass. CI also fails on drift in the generated files, so commit them.
- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), one logical change per commit.

## Updating the spec

1. Download the latest spec (see [spec/README.md](spec/README.md)) over `spec/ninjaone-public-api-v2.yaml`.
2. Run `npm run gen`. `spec-coverage` lists any new operation without a tool. Add routes for them, or mark them `PASSTHROUGH_ONLY` with a reason.
3. Note the spec version in CHANGELOG.md.

## Code of conduct

Be kind and assume good faith. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
