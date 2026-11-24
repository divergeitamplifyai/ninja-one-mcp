# MCP server standard

Version 1.0, 2026-11-08.

How these MCP servers are built. It is derived from the servers already in
production, and it settles the places where they disagreed. The starter in
`src/` implements every MUST, and `scripts/check-conformance.mjs` checks the ones
a machine can check.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119
and RFC 8174. Each rule has an id for review comments and a one-line reason.

Placeholders: `<prefix>` is the tool name prefix (`example` in the starter),
`<PREFIX>` is the environment variable prefix (`EXAMPLE`).

Baseline: MCP specification 2026-07-28, TypeScript SDK `@modelcontextprotocol/sdk`
1.x.

---

## 1. Naming

**N1. MUST** name every tool `<prefix>_<verb>_<noun>`: lowercase ASCII, words
joined by single underscores, one prefix for the whole server, at most 64
characters.
_Why:_ hosts merge tools from many servers; the prefix is the namespace, and
some clients cap the full name.

**N2. MUST** use a verb from the lists below. The verb says what kind of tool it
is. The lists are canonical in `scripts/check-conformance.mjs`; add a verb there
and here in the same pull request.

| Kind | Verbs |
|---|---|
| read | `list`, `get`, `search`, `find`, `test`, `status`, `report`, `plan`, `preview` |
| interactive (read) | `view` |
| write | `create`, `update`, `set`, `add`, `remove`, `delete`, `run`, `execute`, `send`, `rotate`, `assign`, `unassign`, `sync`, `restart`, `reboot`, `start`, `stop`, `move`, `rename`, `enable`, `disable`, `dismiss`, `restore`, `cycle`, `claim`, `lock`, `unlock`, `wipe`, `retire`, `install`, `uninstall`, `apply`, `post`, `revoke`, `approve`, `reject`, `import`, `reset`, `clear`, `invite`, `suspend`, `resume`, `authorize`, `unauthorize`, `adopt`, `unadopt`, `reorder`, `attach`, `detach`, `trigger`, `issue`, `reconcile`, `close`, `reopen`, `upload`, `archive`, `cancel`, `pause`, `unpause`, `redact`, `download` |

_Why:_ a person scanning a permission list, and a model deciding what is safe to
run in parallel, both read the verb first.

**N3. MUST** give every tool a `title` (Title Case, derived from the name unless
there is a reason not to) and a description that says what the tool does, when
to use it, what it returns, and what to call next.
_Why:_ the title is what a person approves; the description is what the model
plans with.

**N4. SHOULD NOT** rename a shipped tool or change its input schema
incompatibly without a major version bump.
_Why:_ tool names and schemas are a contract with installed clients and with
saved approval settings.

## 2. Annotations

**A1. MUST** set all four hints on every tool: `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`.
_Why:_ the spec defaults `destructiveHint` and `openWorldHint` to true, so an
unset hint makes a harmless tool look dangerous, and hosts only auto-approve or
parallelize what is declared read-only.

**A2. MUST** set `readOnlyHint: true` on exactly the read and `view` tools.
_Why:_ the verb and the hint are two statements of one fact; CI checks they
agree.

**A3. MUST** set `destructiveHint: true` on exactly the destructive tier (rule
G2). The destructive tier is every write the API cannot give back: deletes,
reboots and power actions, secret or key rotation, wipes, raw non-GET
passthrough, and overwrites of a value the API keeps no history of.
_Why:_ one definition for the hint and the gate means a tool that warns the host
is also behind the second gate.

**A4. SHOULD** set `idempotentHint` honestly on writes (true only when a repeat
call changes nothing more), and `openWorldHint: false` for tools that reach only
the configured account. Set `openWorldHint: true` only when a tool can reach
arbitrary destinations (any URL, any recipient).
_Why:_ the spec's open world is the web-search case, not one vendor tenant.

**A5. MUST NOT** change annotations with configuration.
_Why:_ approval settings are saved per tool; a hint that flips with an
environment variable makes a saved "always allow" mean something else.

## 3. The write gate

**G1. MUST** start read-only. Writes are off unless an operator turns them on in
the client configuration.
_Why:_ the safe state must be the one you get by doing nothing.

**G2. MUST** use two independent gates:

- `<PREFIX>_MODE=write` enables the write tier.
- `<PREFIX>_ALLOW_DESTRUCTIVE=true` additionally enables the destructive tier,
  and has no effect without the first.

Any other value, including typos, leaves the gate shut, and
`<prefix>_status_server` reports it.
_Why:_ most work needs ordinary writes; the disruptive tier is a separate,
deliberate decision.

**G3. MUST** handle a gated tool in one of two ways, and declare which in
`package.json` under `mcpServer.writeTools`:
- `"listed"` (the default, and what the starter does): write and destructive
  tools stay listed in every mode. While gated they refuse with a message that
  names the setting to change, and send nothing upstream.
- `"hidden"`: a gated tool is left out of `tools/list` until its gate opens, and
  `<prefix>_status_gate` names every tool it withholds and the setting that
  would list it. Read tools are listed in every mode either way.

_Why:_ a listed tool that refuses tells the user exactly what to change and
keeps `tools/list` stable for saved approvals. A hidden tool is one an agent
cannot plan around, which some servers prefer for client systems. Either is
fine as long as nothing is withheld silently.

**G4. MUST** require `confirm` on every write and destructive tool, declared as
required with `const: true` (Zod `z.literal(true)`).
_Why:_ the environment variables are the operator's standing decision; `confirm`
is the model stating, per call, that it means this change.

**G5. MUST** check the gate before any upstream request, including lookups the
tool would make to resolve its arguments.
_Why:_ "nothing was sent" has to be true when the refusal says so.

**G6. SHOULD** give writes whose blast radius is more than one object a
`dry_run` argument that defaults to true and returns the full change set.
_Why:_ a fleet-wide action is reviewed as a list before it runs.

**G7. SHOULD** log every write attempt (refused, applied, failed) to stderr with
the tool name, kind and outcome, and never the arguments.
_Why:_ the operator can answer "did it run?" without the log carrying client
data.

**G8. SHOULD** read back after a write and return the stored values, with the
prior values (`before`) where the API allows it. Destructive tools SHOULD return
the record they removed.
_Why:_ an API that ignores an unknown field returns success; the read-back is
what shows the change landed, and `before` is the undo.

**G9. MUST** have batch writes continue past a failed item and report a status
per item, with `complete: false` when any item failed.
_Why:_ most APIs have no transactions; stopping half way with no record of
which items landed is the worst outcome.

**G10. MAY** narrow the write surface further with `<PREFIX>_WRITE_ALLOWLIST`
(tool names). It can only narrow, and unknown names are reported at startup.
_Why:_ a deployment that needs three writes should not carry fifteen.

These gates bind the server, not the credential. Issue read-only API credentials
wherever writes are not intended; that is the only boundary that also binds an
agent calling the API directly.

## 4. Diagnostics

**D1. MUST** always register these three read tools, whatever the configuration:

| Tool | Does |
|---|---|
| `<prefix>_status_server` | Reports configuration with no API call: version, base URL, whether a credential is set (never its value), missing variables by name, unusable settings, scoping defaults, gate state. |
| `<prefix>_status_gate` | Reports the gate: mode, destructive state, which tools each gate covers, and the variables that change it. |
| `<prefix>_test_connection` | Makes one cheap authenticated call and reports the account and base URL. |

_Why:_ a broken setup has to be able to explain itself from inside the client.

**D2. MUST** start without credentials. Missing or invalid configuration is
reported by `status_server`, and tools that need the API refuse naming the
variable.
_Why:_ a server that exits at boot cannot tell anyone why.

## 5. Organization scoping (multi-tenant and MSP)

**S1. MUST** take the organization as an argument (`org`, or the vendor's word
for it) on every organization-scoped tool. The argument wins over
`<PREFIX>_ORG_ID`, which is only a default.
_Why:_ one deployment serves many clients; the call has to say which.

**S2. MUST NOT** infer an organization: no "first in the list", no "the only one
visible".
_Why:_ an inference that is right in a one-tenant account silently retargets the
day a second tenant appears.

**S3. SHOULD** accept an id or a unique, case-insensitive name fragment, and
**MUST** refuse an ambiguous name with the candidates (id and name).
_Why:_ people say client names; a guessed match acts on the wrong client.

**S4. SHOULD** support `<PREFIX>_ALLOWED_ORG_IDS`, a hard boundary applied to
every call, to discovery tools, and to fan-out. Organizations outside it are
refused by name and never offered as candidates.
_Why:_ the default is a convenience; the boundary is a control.

**S5.** On remote HTTP, a caller's own organization claim MUST be intersected
with the deployment boundary. Neither may widen the other.

## 6. Reads and lists

**L1. MUST** return a compact field set from list tools by default, and accept
`fields: "all"` (full records) or a list of field names.
_Why:_ a list that floods the context is a list the model cannot use.

**L2. MUST** page list tools with `limit` (bounded) and an opaque `cursor`
input, and return `has_more` and `next_cursor`.
_Why:_ one shape across servers; a cursor saves the model from offset
arithmetic.

**L3. MUST** make every short read say so. An unrecognized response envelope is
an error, not zero rows; records dropped as unparseable are counted in a
`warning`; results cut to fit are marked `[TRUNCATED]` with how to narrow.
_Why:_ a quietly short count reads as a correct answer and gets acted on.

**L4. MUST** cap result size (the starter uses 100,000 characters).
_Why:_ clients reject or silently cut oversized results.

**L5. SHOULD** run cross-organization fan-out with a configurable concurrency
cap (`<PREFIX>_MAX_CONCURRENCY`), and report each organization on its own row,
with its error when it failed.
_Why:_ unbounded fan-out trips the vendor's rate limit for every integration on
the account, and one bad tenant must not sink the answer.

**L6. MUST** retry 429 for any method, honoring `Retry-After`, and retry 5xx
and network errors for GET only, with bounded attempts and jittered backoff.
Endpoints with their own published limits get their own budget.
_Why:_ 429 means not processed; a 5xx on a POST may have applied, and replaying
it can create a record twice.

## 7. Errors

**E1. MUST** return failures as tool results with `isError: true`, never as
protocol errors or crashes.
_Why:_ the model can read and act on a result; it cannot act on a dropped
request.

**E2. MUST** end every error with a line that starts `Next step:` and names the
argument, environment variable, or tool that fixes it.
_Why:_ an error that names its own remedy is one the caller recovers from
without a person.

**E3. MUST** redact every error before it leaves the server (see X2).

## 8. Secrets

**X1. MUST** read credentials from the environment or a secret manager only.
Never accept a credential as a tool argument, and never return, log or echo one.
_Why:_ anything in the transcript is stored, shared and replayed.

**X2. MUST** register every secret with the redactor before anything can log,
and send credentials in headers, never in query strings.
_Why:_ query strings land in access logs and proxies.

**X3. MUST** write only JSON-RPC to stdout on stdio. All logging goes to stderr.
_Why:_ one stray line corrupts the protocol stream.

**X4. MUST** gate any tool that reveals a secret value (a stored password, a key,
a pre-signed URL) like a destructive tool, and require an explicit argument to
reveal it. Lists and views MUST NOT carry secret values. SHOULD return a
short-lived, single-use handle instead of a bearer URL where the transport allows.
_Why:_ a revealed secret cannot be un-revealed.

**X5. MUST** refuse a plaintext (`http:`) base URL except for loopback.
_Why:_ a credential on a plaintext connection is a compromised credential.

## 9. Raw API passthrough

**P1. MAY** offer passthrough. A server that cannot enforce scoping and paging on
raw paths SHOULD ship none and say so in its instructions.
_Why:_ passthrough bypasses the organization guard and the paging guarantees
unless it reimplements them.

**P2.** If present, it MUST be two tools: `<prefix>_api_get` (read) and
`<prefix>_api_write` (destructive tier, both gates, `confirm`). Not one tool
with a method argument.
_Why:_ annotations are static (A5); a single tool cannot be honestly both.

**P3.** Passthrough MUST validate the path (relative, no `..`), apply
organization scoping, redact output, and strip secret values on secret routes.

## 10. Mutation manifest

**M1. MUST** ship `mutations.json` at the repository root, in the schema the MSP
plugin marketplace uses: `server`, `source` (`verified` or `derived`), `reviewed`
(ISO date), and per tool `mutating`, plus `blastRadius` (`none`,
`single-object`, `single-tenant`, `multi-tenant`) and `rollback` (how a person
undoes it) for every mutating tool.
_Why:_ the plugin guard that confirms writes reads this file, and it fails
closed: a tool it does not list asks every time.

**M1a.** A repository that ships more than one server from one codebase (for
example one bundle per product) ships one manifest per server, named in
`package.json` `mcpServer[].mutations`, and lists each server as its own
`mcpServer` entry so the conformance check runs once per server.

**M2. MUST** list exactly the registered tools, with `mutating` equal to
`!readOnlyHint`. CI fails on drift. Classification is a reviewed decision
recorded here, not inferred from a name.
_Why:_ a manifest that lags the server is the gap the guard exists to close.

**M3.** Connectors that reach client systems MUST be published with their
manifest, copied unchanged into the plugin, with `source: "verified"`.

## 11. Interactive views

**V1.** `<prefix>_view_*` tools MUST be read-only, MUST return the same data as
JSON text (and `structuredContent`) for hosts without MCP Apps, and SHOULD
declare their `ui://` resource in `_meta`. Buttons in a view MUST call the
server's own gated tools, never a private write path.
_Why:_ a view is presentation; the safety facts underneath it do not change.

## 12. Server instructions

**I1. MUST** provide server instructions, kept short, that cover: the naming
scheme and kinds, the gates and their variables, scoping, the diagnostics tools,
and any deliberate omissions (for example "no raw passthrough").
_Why:_ instructions are the one thing every host shows the model before the
first call.

## 13. Transport

**T1. MUST** support stdio.

**T2.** Remote HTTP is optional. When offered it MUST use Streamable HTTP (no
SSE), build one server per request (no per-user state in module scope), refuse
to start without inbound authentication except on loopback, bind loopback by
default, validate `Origin`, act as an OAuth 2.1 resource server per the MCP
authorization spec (audience validated against this server, RFC 9728 metadata)
or use a shared bearer token of at least 32 characters compared in constant
time, and never forward the inbound token upstream. Gate settings come from
deployment configuration, not from the caller.
_Why:_ an unauthenticated listener off-host exposes every tenant the credential
can read.

## 14. Repository

**R1. MUST** carry: `AGENTS.md` (canonical agent instructions), `CLAUDE.md`
(imports `AGENTS.md`), `SECURITY.md`, `.env.example` with every variable and no
values, `.gitignore` covering `.env`, and `mutations.json`.

**R2. MUST** pin dependency versions exactly, commit the lockfile, use the
official MCP SDK, and justify each added dependency (identity, maintenance,
license, advisories).

**R3. MUST** run in CI on every pull request: install from the lockfile, build,
test, and `scripts/check-conformance.mjs`, with `permissions: contents: read`
and third-party actions pinned to a commit SHA.

**R4. MUST** keep tests off the network beyond loopback. Mocks MUST reproduce
the API's dangerous behaviors (for example a PUT that replaces a whole array)
so a tool that would cause damage fails a test, not a tenant.

**R5.** No secrets, tenant ids, or client or customer names in code, tests,
fixtures, logs or commits.
