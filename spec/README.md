# NinjaOne Public API spec

`ninjaone-public-api-v2.yaml` is NinjaOne's published OpenAPI 3.0.1 document, "NinjaOne Public API 2.0", version `2.0.9-draft`. It has 254 paths, 315 operations and 416 schemas. It is committed unchanged as the source of truth for:

- `scripts/spec-coverage.mjs`: every operation must map to a tool, or be marked passthrough-only with a reason.
- `scripts/gen-bodies.mjs`: the request-body field lists in write tool descriptions.

It was pulled on 2026-11-23 from https://app.ninjarmm.com/apidocs-beta/NinjaRMM-API-v2.yaml (the US instance; us2 serves the same file). The EU, CA and OC instances serve a slightly larger variant with the same 315 operations.

The spec is NinjaOne's work, included here for reference and tooling. It is not covered by this repository's MIT license.

## Refresh

```bash
curl -fsSL https://app.ninjarmm.com/apidocs-beta/NinjaRMM-API-v2.yaml -o spec/ninjaone-public-api-v2.yaml
npm run gen
git diff --stat
```

Then follow CONTRIBUTING.md, "Updating the spec".
