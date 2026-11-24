# Conformance checklist

Use this to review a server, new or existing, against [STANDARD.md](STANDARD.md).
Copy it into the pull request or review issue and tick each line. Rule ids are in
brackets.

Items marked **(auto)** are checked by `npm run conformance` against the built
server. A green run covers them; the rest need a person.

## Before you start

- [ ] `npm ci && npm run build && npm test && npm run conformance` passes locally.
- [ ] `package.json` `mcpServer.toolPrefix` and `mcpServer.envPrefix` match the code.

## Naming and annotations

- [ ] Every tool is `<prefix>_<verb>_<noun>`, lowercase snake_case, at most 64 characters. [N1] **(auto)**
- [ ] Every verb is in the standard's lists. [N2] **(auto)**
- [ ] Every tool has a title and a description of 40+ characters. [N3] **(auto)**
- [ ] Descriptions say what the tool does, when to use it, what it returns, and what to call next. [N3]
- [ ] No shipped tool was renamed or had its schema broken without a major version. [N4]
- [ ] All four annotation hints are set on every tool. [A1] **(auto)**
- [ ] `readOnlyHint` agrees with the verb. [A2] **(auto)**
- [ ] Every tool the API cannot undo is `destructiveHint: true`, and nothing else is. [A3]
- [ ] `idempotentHint` and `openWorldHint` are honest. [A4]
- [ ] Annotations do not depend on configuration. [A5]

## Write gate

- [ ] With no gate variables set, every write refuses. [G1] **(auto)**
- [ ] `<PREFIX>_MODE=write` and `<PREFIX>_ALLOW_DESTRUCTIVE=true` are the only gate switches, and typos leave them shut. [G2]
- [ ] `mcpServer.writeTools` in `package.json` says `listed` or `hidden`. [G3] **(auto)**
- [ ] `listed`: `tools/list` is the same in every mode. `hidden`: read tools are always listed, and `status_gate` names every withheld tool. [G3] **(auto)**
- [ ] Read-mode refusals of listed write tools name `<PREFIX>_MODE=write`; destructive refusals name `<PREFIX>_ALLOW_DESTRUCTIVE=true`. [G3] **(auto)**
- [ ] Every write and destructive tool requires `confirm` with `const: true`. [G4] **(auto)**
- [ ] The gate is checked before any upstream request, including argument lookups. [G5]
- [ ] Writes that touch more than one object take `dry_run`, defaulting to true. [G6]
- [ ] Write attempts are logged to stderr without arguments. [G7]
- [ ] Writes read back; destructive tools return what they removed. [G8]
- [ ] Batch writes continue past a failed item and report `complete: false`. [G9]

## Diagnostics

- [ ] `status_server`, `status_gate` and `test_connection` exist and are read-only. [D1] **(auto)**
- [ ] The server starts with no credential, and `status_server` names the missing variable. [D2] **(auto)**
- [ ] `test_connection` makes one cheap call and turns 401 and 403 into a next step. [D1]

## Scoping

- [ ] Organization-scoped tools take an org argument that overrides `<PREFIX>_ORG_ID`. [S1]
- [ ] Nothing infers an organization. Search the code for "first", `[0]`, and single-result fallbacks. [S2]
- [ ] Ambiguous names are refused with candidates. [S3]
- [ ] `<PREFIX>_ALLOWED_ORG_IDS` bounds every call, discovery, and fan-out. [S4]
- [ ] On HTTP, caller claims intersect the boundary. [S5]

## Reads

- [ ] Lists are compact by default and accept `fields: "all"`. [L1]
- [ ] Lists page with `limit`, `cursor`, `has_more`, `next_cursor`. [L2]
- [ ] An unknown envelope is an error; dropped rows and truncation are announced. [L3]
- [ ] Results are size-capped. [L4]
- [ ] Fan-out has a concurrency cap and per-organization rows. [L5]
- [ ] 429 retries any method with `Retry-After`; 5xx retries GET only. [L6]

## Errors and secrets

- [ ] Failures are `isError` results. [E1]
- [ ] Every error ends with a `Next step:` line. [E2] **(auto for gate refusals)**
- [ ] Errors and logs are redacted. [E3]
- [ ] No tool takes or returns a credential. [X1] **(auto for diagnostics)**
- [ ] Secrets are registered with the redactor at startup and sent only in headers. [X2]
- [ ] Nothing but JSON-RPC is written to stdout. [X3]
- [ ] Secret-revealing tools are gated like destructive tools. [X4]
- [ ] Plaintext base URLs are refused except loopback. [X5]

## Passthrough, manifest, views, instructions

- [ ] No passthrough, or exactly `<prefix>_api_get` (read) and `<prefix>_api_write` (destructive). [P1, P2] **(auto)**
- [ ] Passthrough validates paths, scopes organizations, and strips secrets. [P3]
- [ ] `mutations.json` lists exactly the tools, agrees with annotations, and has blast radius and rollback for every write. [M1, M2] **(auto)**
- [ ] Rollback text says how a person actually undoes it, or what the recovery path is. [M1]
- [ ] View tools are read-only, return JSON for hosts without Apps, and their buttons call gated tools. [V1] **(auto for read-only)**
- [ ] Server instructions cover kinds, gates, scoping, diagnostics, and deliberate omissions. [I1] **(auto for presence)**

## Transport and repository

- [ ] stdio works. [T1] **(auto)**
- [ ] If HTTP is offered: auth fails closed off loopback, Origin is validated, one server per request, no SSE, no token forwarding. [T2]
- [ ] `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, `.env.example`, `.gitignore`, `mutations.json` exist. [R1] **(auto)**
- [ ] Dependencies pinned exactly, lockfile committed, each dependency justified. [R2]
- [ ] CI runs build, test and conformance with read-only permissions and SHA-pinned actions. [R3]
- [ ] Tests make no network calls beyond loopback, and mocks reproduce the API's dangerous behaviors. [R4]
- [ ] No secrets, tenant ids, or client names anywhere in the repository. [R5]
