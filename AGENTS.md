# Agent instructions

The canonical instructions for any AI coding agent working in this repository. `CLAUDE.md` imports this file, so edit this one.

This repository is an MCP server built to [STANDARD.md](STANDARD.md). Read the standard and [docs/DESIGN.md](docs/DESIGN.md) before you change a tool.

## Purpose

`ninja-one-mcp` is a stdio MCP server for the NinjaOne RMM Public API v2. It covers every operation in `spec/ninjaone-public-api-v2.yaml`, for agents that manage many client organizations. It must never:

- change anything while the gates are shut;
- touch an organization outside `NINJAONE_ALLOWED_ORG_IDS`;
- request secure custom field values;
- replay an action;
- let a credential reach a result, error or log.

## Commands

```bash
npm ci                 # install from the lockfile
npm run build          # tsc -> dist/
npm test               # build, then node:test against dist/ (loopback only)
npm run conformance    # standard checks against the built server (all toolsets)
npm run check          # everything CI runs, including drift checks on generated files
npm run gen            # regenerate body docs, views runtime, catalog, coverage, plugin bundle
npm run pack:mcpb      # build/ninja-one-mcp.mcpb
```

## Layout

```
src/
  routes/*.ts      Route tables. One Route per endpoint. Most tool changes happen here.
  engine.ts        Route -> tool: gate, scope, request, before, dry run, send, after, shape
  tools/           Hand-written tools: workflows, views, passthrough, diagnostics, resources
  auth.ts          OAuth client credentials and the token cache
  client.ts        HTTP, retries, noRetry
  orgs.ts          Organization directory and boundary
  config.ts        Environment parsing; never throws; fails closed
  envfile.ts       Optional credentials file
  gate.ts spec.ts  Gates, confirm, annotations; defineTool is the only registration path
  toolsets.ts      Listing groups
  http/            Streamable HTTP transport: config, inbound auth, server
  generated/       Generated files: body docs and the views runtime. Do not edit.
spec/              NinjaOne OpenAPI spec (source of truth)
scripts/           conformance, coverage, catalog, generators, bundle, pack
plugins/ninjaone/  The NinjaOne plugin (Claude Code and Codex) and the committed bundle
site/              GitHub Pages site
test/              harness.mjs (loopback NinjaOne mock), server, unit and http tests
infra/, azure.yaml Azure Container Apps deployment (Bicep, azd); Dockerfile builds the image
```

## Rules that outrank everything else

1. **Every tool goes through `defineTool`** (directly, or through `registerRoutes`). Never call `server.registerTool`.
2. **The kind is the safety fact.**
   - `read` changes nothing.
   - `write` is something the API can undo, or the tool returns `before`.
   - `destructive` is everything else: deletes, reboots, scripts, patch apply, full replacements, secret reveals and raw writes.
   - The verb must match the kind, and the conformance script fails a mismatch.
3. **Every route declares its scope.** If you cannot say how a route is held inside the boundary, it is `unscoped` and refuses under one.
4. **Use only operationIds that exist in the spec.** Every route lists its `ops`. `spec-coverage.mjs` fails on an unknown id and on any spec operation left uncovered. Endpoints you deliberately leave to passthrough go in a `// PASSTHROUGH_ONLY: <operationId>: <reason>` comment.
5. **Adding, removing or reclassifying a tool means updating `mutations.json`** in the same change (`npm run mutations`, then edit its blast radius and rollback so a person can follow them).
6. **Never infer an organization.** Resolve it through `OrgDirectory`.
7. **No credential in arguments, results, errors or logs.** stdout is JSON-RPC only. Log with `logStderr`.
8. **Every error ends with `Next step:`.** Throw `ToolError(message, nextStep)`.
9. **Retries:** 429 on any method; 5xx and network errors on GET only. Actions set `noRetry`.
10. **Make the mock dangerous.** When a real endpoint replaces, overwrites or may half-apply, the mock in `test/harness.mjs` must too.

## Adding an endpoint

1. Find the operation in the spec: method, path, parameters, request body.
2. Add a `Route` to the right file in `src/routes/`. Set:
   - the tool name, as `<verb>_<noun>` with a verb from STANDARD.md N2;
   - `kind` and `scope`;
   - `params` (snake_case keys, and `wire` set to NinjaOne's name);
   - `list` paging for lists;
   - `body.op` for writes;
   - `readBack` where a GET can show the record;
   - `dryRun` for wide writes;
   - `noRetry` for actions.
3. `npm run gen`, then `npm run mutations`. Review the new manifest entries.
4. Add a test when the route introduces behavior the existing tests do not cover.
5. `npm run check`.

## Definition of done

- `npm run check` passes.
- Refusal and error paths were tested, not only the happy path.
- `mutations.json`, the README, `docs/TOOLS.md` (generated) and this file are current.
- Report the commands you ran, their results, and anything you did not verify.

## Repository hygiene

- No secrets, tenant ids, or real client or company names in code, tests, fixtures, logs or commits. Fixtures use made-up names such as "Alpha Org" and "Example Org".
- Dependencies are pinned exactly. Ask before adding one, and justify it in the pull request.
- Conventional Commits. No AI attribution in commits, pull requests or files.
- No em dashes or emojis in committed text.
