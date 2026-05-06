# Sharing-domain boundary enforcement checkpoint

**Date:** 2026-05-06
**Bead:** `codemem-ov4g.9`
**Status:** signed off for the documentation/release docs track

## Scope

This checkpoint reviews the implementation evidence required by
`codemem-ov4g.9` before the `ov4g.7.*` documentation beads can proceed. It
does not change the Sharing-domain model; it records whether the current main
branch still preserves the invariants from
`docs/plans/2026-04-30-sharing-domain-scope-design.md`.

## Fresh validation

Validated on `main` after PR #1053 merged:

| Check | Result |
|---|---|
| `pnpm exec vitest run packages/core/src/sync-mixed-scope.test.ts packages/core/src/scope-regression.test.ts` | Passed: 2 files, 11 tests |
| `pnpm exec tsx --conditions source e2e/scripts/sharing-domain-smoke.ts --db-path <tmp-db-path>` | Passed |
| `CODEMEM_E2E_BUILD=1 CODEMEM_E2E_JSON=1 pnpm run e2e:sharing-domains -- --json` | Passed |

## Gate review

| Requirement | Evidence | Decision |
|---|---|---|
| `ov4g.4.6` mixed personal/work sync integration passes, including hostile fixtures. | `packages/core/src/sync-mixed-scope.test.ts`; bead closed after PR #1016 merged. | Green |
| `ov4g.5.6` retrieval/MCP leakage regression passes for FTS, semantic, pack, plugin, MCP, viewer/API, export/import, explain, expand, and timeline paths. | `packages/core/src/scope-regression.test.ts`; closed bead notes cite the broader targeted Vitest suite and reviewer signoff. | Green |
| `ov4g.6.6` personal/work/OSS E2E smoke passes with legacy-peer behavior and revocation. | PR #1053 merged; fresh direct and Docker smoke runs passed. | Green |
| Phase state and UI copy cannot claim stronger enforcement than the runtime. | `codemem-ov4g.8` signed off the foundation gate. Current shipped capability remains explicitly negotiated (`aware` vs `enforcing`) and there is no independent operator toggle that can make UI copy outrun runtime behavior. | Green for docs-track unblock |
| Hard rejection is enforced before diagnostics; diagnostics cannot weaken the gate. | `codemem-ov4g.4.7` hard rejection and `codemem-ov4g.4.8` diagnostics are separate closed beads. `codemem-ov4g.4.5` rollup closed only after both were merged. | Green |
| Scope reassignment uses the atomic `reassign_scope` op and warns about already-copied data. | Write-path and guardrail beads are closed; the PR #1053 hostile fixture rejects unauthorized `reassign_scope` attempts. | Green |
| Hinted handoff does not bypass membership. | Hinted handoff is not shipped in this scope release. No release docs should describe it as available. | Not applicable / no shipped path |
| Local-only scopes never replicate outbound. | `sync-mixed-scope.test.ts` asserts default/local scope ops do not route even under widened project filters; PR #1053 also rejects `local-default` hostile inbound ops. | Green |
| Inbound `scope_id` is taken from the op row; payload mismatch rejects. | `codemem-ov4g.4.7` and PR #1053 hostile fixtures cover payload-vs-row mismatch as `scope_mismatch`. | Green |
| Legacy compatibility constraints are explicit and default-deny. | PR #1053 asserts legacy-peer receives nothing by default; user/coordinator docs must preserve the audited-exception wording and avoid broad compatibility grants. | Green for docs-track unblock |

## Signoff

The boundary-enforcement implementation evidence is green enough to unblock the
documentation beads:

1. `codemem-ov4g.7.1` — user docs for Sharing domains and mixed-device safety.
2. `codemem-ov4g.7.2` — coordinator docs for scope membership and revocation.
3. `codemem-ov4g.7.3` — anchor-peer deployment docs.

The docs track must preserve these review conclusions:

- Sharing domains / `scope_id` are the hard data boundary.
- Project include/exclude filters only narrow; they never grant access.
- Coordinator group membership is not data access.
- The coordinator is not a memory data path.
- Revocation stops future sync but does not erase already-copied data.
- Seed/anchor peers are ordinary peers with high uptime, not special protocol roles.
