# Recipient-policy multi-project diagnostics

**Date:** 2026-08-10
**Target:** 0.40.2
**Status:** Approved
**Amended:** 2026-09-06 to separate review, continuity, and repair presentation

## Problem

Legacy recipient-policy projection deliberately refuses to infer per-Project recipient intent when one enforcement scope contains multiple canonical Projects. That fail-closed behavior is correct. The review layer currently converts every projection diagnostic into a repairable `Blocked` card, however, so an intentional umbrella scope is presented as a broken Project-to-scope mapping for every Project it contains.

Accurately moving Projects into their existing umbrella scopes therefore creates more apparent failures even though placement and enforcement are correct.

## Decision

Keep `ambiguous_multi_project_scope` in the legacy projection and continue suppressing recipient inference and actionable migration decisions for affected Projects. For known legacy umbrella scope kinds (`user`, `personal`, `team`, `team_default`, `org`, and `client`), do not convert this diagnostic into a repairable blocked review item. Count it in the existing collapsed `legacy_access_preserved` continuity message instead, so the ambiguity remains observable without producing one false repair card per Project. A collision in a project-specific `managed_project` scope remains repairable, and unknown future scope kinds fail closed as repairable rather than being assumed to be umbrellas.

Treat `wildcard_scope_mapping` the same way: a deliberate catch-all mapping can be ambiguous for recipient migration without being broken. Continue producing blocked review items for source-state defects that have a concrete repair path, including noncanonical Project identities, conflicting Project-to-scope mappings, and inactive boundaries.

This changes presentation only. It does not create recipient intent, change current access, promote recipient-policy authority, resolve migration findings, or weaken scope enforcement.

The amended Projects surface presents actionable review decisions, preserved legacy continuity, and blocked source repairs as separate categories under the neutral title `Sharing review`. Each category scopes its access and action guidance to its own findings, so preserved continuity cannot make a mixed response look repaired or blocked. The V1 response adds `categoryCounts`; `continuity.findingCount` remains the compatible aggregate for older clients.

## Implementation

- Add an exhaustive, typed presentation classification for every `LegacyRecipientPolicyConditionCodeV1`: actionable, repairable blocked, or preserved continuity. Adding a future condition code must fail compilation until its presentation is selected explicitly.
- Classify `ambiguous_multi_project_scope` as preserved continuity only for legacy umbrella scope kinds, and keep a `managed_project` collision repairable. Classify `wildcard_scope_mapping` as preserved continuity; classify noncanonical identities, conflicting mappings, and inactive boundaries as repairable blocked conditions.
- Count suppressed diagnostics in `categoryCounts.preservedContinuity`; retain the existing aggregate `continuity.findingCount` for older clients.
- Preserve the existing `hasDiagnostic` gate so ambiguous Projects remain fail-closed and do not gain actionable review options.
- Render separate `Review decisions`, `Preserved legacy continuity`, and `Blocked source repairs` sections with independent counts, and preserve repair controls only in the blocked section.
- Add regression coverage proving that a multi-Project umbrella scope remains ambiguous in projection, contributes to continuity, and does not become a blocked repair card.
- Cover mixed intentional and repairable diagnostics, retained blocked-item ID stability, and migration remaining skipped without authoritative evidence.
- Preserve blocked-card coverage for a genuinely noncanonical Project identity and UI coverage for continuity-only and mixed states. Mixed-state tests must prove continuity findings do not appear as repair blockers.
- Cover the exhaustive presentation classification so a newly added condition code cannot silently disappear from review.

The contract version remains unchanged. The response additively includes `categoryCounts`, and the legacy projection condition shape retains optional `scopeKinds` evidence. Older clients can continue reading `continuity` and `blockedItems`.

## Validation

- Focused recipient-policy projection, review, migration, and Projects UI tests.
- TypeScript, lint, and workspace tests.
- Confirm the review API no longer emits one blocked card per Project solely because an intentional scope contains multiple Projects.
- Run the release version script for 0.40.2 and build the UI before release submission.
