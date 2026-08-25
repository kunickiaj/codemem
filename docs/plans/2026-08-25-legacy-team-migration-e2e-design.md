# Legacy Team Migration E2E Design

**Status:** Approved for implementation on 2026-08-25

## Goal

Add one dedicated, registered end-to-end scenario proving that reviewed legacy Team setup preserves existing access until confirmation and atomically establishes the exact confirmed Team, Project, recipient, and device policy afterward. Document the same workflow in user-facing terms.

## Scenario architecture

The scenario uses the existing Docker Compose harness, a coordinator-backed roster, and the real local viewer HTTP API. A focused fixture script seeds and inspects only legacy Team migration state; it does not duplicate the broader Project Sharing scenario.

The scenario exercises two overlapping legacy groups and proves:

- one device assignment can be reused by both Team drafts;
- another device can be excluded from only one Team;
- unresolved Project mappings and stale confirmation evidence block activation without writes;
- Project identity repair and recipients change only during the confirmed atomic finish;
- a later active device outside the reviewed roster remains ineligible;
- conflicting reassignment fails closed; and
- retrying after a simulated lost finish response returns the immutable completed result.

Assertions inspect both viewer-safe API responses and canonical database summaries. Fixture output remains bounded and contains only synthetic E2E identifiers.

## Registration and diagnostics

Register `legacyTeamMigration` in the local runner, expose `pnpm run e2e:legacy-team-migration`, and add an independent CI matrix entry with failure artifacts. Document the command and covered guarantees in `e2e/README.md`.

## User documentation

Add a Team setup section to `docs/user-guide.md` explaining where setup appears, how device and Project decisions persist, why review can become stale, what finish changes atomically, and how to recover safely. Use product terms and omit opaque references, coordinator internals, and migration implementation details.

## Validation

- Focused fixture/unit checks where practical.
- `pnpm run e2e:legacy-team-migration -- --json`.
- `pnpm run check` and `pnpm run build` at the stack tip.
