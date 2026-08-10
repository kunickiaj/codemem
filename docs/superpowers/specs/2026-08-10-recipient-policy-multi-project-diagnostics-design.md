# Recipient-policy multi-project diagnostics

**Date:** 2026-08-10
**Target:** 0.40.2
**Status:** Approved

## Problem

Legacy recipient-policy projection deliberately refuses to infer per-Project recipient intent when one enforcement scope contains multiple canonical Projects. That fail-closed behavior is correct. The review layer currently converts every projection diagnostic into a repairable `Blocked` card, however, so an intentional umbrella scope is presented as a broken Project-to-scope mapping for every Project it contains.

Accurately moving Projects into their existing umbrella scopes therefore creates more apparent failures even though placement and enforcement are correct.

## Decision

Keep `ambiguous_multi_project_scope` in the legacy projection and continue suppressing recipient inference and actionable migration decisions for affected Projects. For known legacy umbrella scope kinds (`user`, `personal`, `team`, `team_default`, `org`, and `client`), do not convert this diagnostic into a repairable blocked review item. Count it in the existing collapsed `legacy_access_preserved` continuity message instead, so the ambiguity remains observable without producing one false repair card per Project. A collision in a project-specific `managed_project` scope remains repairable, and unknown future scope kinds fail closed as repairable rather than being assumed to be umbrellas.

Treat `wildcard_scope_mapping` the same way: a deliberate catch-all mapping can be ambiguous for recipient migration without being broken. Continue producing blocked review items for source-state defects that have a concrete repair path, including noncanonical Project identities, conflicting Project-to-scope mappings, and inactive boundaries.

This changes presentation only. It does not create recipient intent, change current access, promote recipient-policy authority, resolve migration findings, or weaken scope enforcement.

## Implementation

- Add an exhaustive, typed presentation classification for every `LegacyRecipientPolicyConditionCodeV1`: actionable, repairable blocked, or preserved continuity. Adding a future condition code must fail compilation until its presentation is selected explicitly.
- Classify `ambiguous_multi_project_scope` as preserved continuity only for legacy umbrella scope kinds, and keep a `managed_project` collision repairable. Classify `wildcard_scope_mapping` as preserved continuity; classify noncanonical identities, conflicting mappings, and inactive boundaries as repairable blocked conditions.
- Count suppressed diagnostics in the existing `continuity.findingCount` alongside unresolved deferred review items.
- Preserve the existing `hasDiagnostic` gate so ambiguous Projects remain fail-closed and do not gain actionable review options.
- When continuity and genuine blocked items coexist, title the surface `Sharing needs repair` and retain the deferred-finding count. Suppress the continuity-only `No action is required` introduction in this mixed state so the copy does not contradict the repair cards.
- Add regression coverage proving that a multi-Project umbrella scope remains ambiguous in projection, contributes to continuity, and does not become a blocked repair card.
- Cover mixed intentional and repairable diagnostics, retained blocked-item ID stability, and migration remaining skipped without authoritative evidence.
- Preserve blocked-card coverage for a genuinely noncanonical Project identity and UI coverage for continuity-only and mixed states. The mixed-state test must intentionally replace its previous `Existing sharing kept as-is` and `No action is required` expectations.
- Cover the exhaustive presentation classification so a newly added condition code cannot silently disappear from review.

The review response shape and contract version remain unchanged. The legacy projection condition shape is additively extended with optional `scopeKinds` evidence. `continuity` is already an additive V1 field; this patch only corrects which legacy findings contribute to it versus `blockedItems`.

## Validation

- Focused recipient-policy projection, review, migration, and Projects UI tests.
- TypeScript, lint, and workspace tests.
- Confirm the review API no longer emits one blocked card per Project solely because an intentional scope contains multiple Projects.
- Run the release version script for 0.40.2 and build the UI before release submission.
