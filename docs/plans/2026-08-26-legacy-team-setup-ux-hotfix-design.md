# Legacy Team setup UX hotfix design

## Context

The `0.43.0` legacy Team setup flow preserves access safety, but dogfooding exposed two usability failures for a valid large migration:

- a Team with 63 automatically mapped Projects skips directly from Devices to Review;
- six included devices produce 509 exact changes, including a 63-by-6 device-access cross-product that is technically correct but not reviewable as a flat list.

The same pass exposed overlapping numbered step labels and excessive spacing in the Team setup candidate list. Multiple distinct legacy groups can also share the fallback label `Legacy Team`, making their actions difficult to distinguish.

Dogfooding after the initial hotfix found a more fundamental discovery gap. A coordinator group can still back active replication scopes and current access without appearing in `sync_coordinator_groups`. The existing loader considers only configured groups, so this production-shaped legacy Team never reaches the otherwise complete guided migration flow.

## Goals

- Make automatic Project inclusion explicit without changing which Projects migrate.
- Keep the exact server-confirmed access delta available while presenting a useful summary first.
- Safely group repeated human-readable labels without exposing coordinator, group, device, or canonical Project identifiers.
- Repair the wizard stepper and Team setup candidate layout across supported widths.
- Preserve server-authoritative refresh, confirmation digests, atomic activation, and fail-closed behavior.
- Discover a legacy group when this node has active coordinator-backed scope evidence for it, even if another group is the only configured sync group.
- Present scope-backed roster devices as proposed migration decisions that require review; never infer Team membership directly from scope membership.

## Non-goals

- Add Project inclusion or exclusion controls.
- Change device decisions, Team membership, recipient policy, or activation semantics.
- Recompute or replace the server-provided access delta in the browser.
- Expose opaque identifiers to disambiguate repeated labels.
- Enumerate every administrator-visible coordinator group without local access evidence.
- Automatically admit scope members to a Sharing Team.

## Design

### Wizard progression

An unfinished setup visits Devices, Projects, then Review even when all Project mappings are deterministic. The Projects step explains that all mapped Projects will be included and shows resolved and unresolved totals. Deterministic rows remain read-only; only unresolved mappings expose controls.

The stepper uses explicit number elements inside equal-width step items rather than native ordered-list markers. Desktop layouts retain three columns. Narrow layouts stack without marker overlap and preserve logical keyboard and reading order.

### Team setup candidate list

Candidate entries use compact rows with three aligned areas: Team label, status, and action. Native bullets are removed. Narrow layouts stack the status and action beneath the label.

When multiple candidates have the same normalized display label, the overview groups them under one label and reports the count. Each underlying candidate keeps its own setup action and opaque candidate reference, but visible action labels include a safe ordinal such as `Continue setup for Legacy Team 1 of 2`. No coordinator or group identifier is rendered.

The overview names unfinished candidates as `Legacy groups to migrate` and uses `Review and migrate` for the primary action. This makes the existing setup dialog the explicit bridge into Sharing rather than presenting legacy and Sharing Teams as unrelated inventories.

### Scope-backed discovery

Candidate loading uses the bounded union of configured sync groups and group IDs from active coordinator-authoritative replication scopes whose coordinator matches the configured coordinator. The loader then applies the existing current-group and current-roster validation to every candidate. Groups visible only through coordinator administration remain excluded.

Scope membership is discovery evidence, not reviewed Team membership. The current coordinator roster supplies the migration's device inventory, and each device must still be assigned to an identity and explicitly included, excluded, or removed in the guided workflow. Finish continues to create or update the Sharing Team, reviewed memberships, Project recipients, and setup-owned scope mappings atomically from the confirmed preview.

### Review summary

The Review step reconciles the raw mutation count across the five exact change categories:

- Team policy changes;
- membership changes;
- Project mapping changes;
- recipient changes;
- device-access changes.

Project and device inventory counts appear separately as migration scope. Repeated labels are grouped with counts, for example `greenroom — 34 Projects with this name, 34 Project changes`. When grouping reduces a large Project mapping, recipient, or device-access section, the grouped summary appears by default and native `details` and `summary` disclosures expose every exact server-provided row. Small sections and large sections whose labels cannot be usefully grouped keep their exact rows visible.

The confirmation checkbox continues to bind to the attempt, finish, access-delta, and viewer-access-delta digests. Expanding or collapsing details does not alter evidence or the finish request.

## Accessibility

- Step labels retain ordered semantics and expose the current step.
- Candidate actions remain real buttons with unique accessible names.
- Summary disclosures use native keyboard-accessible elements.
- Counts and grouping do not rely on color.
- Focus movement and live-region behavior remain unchanged.

## Validation

- Add failing component tests for automatic Project progression, duplicate candidate labels, stepper hooks, and responsive candidate-row structure.
- Add a production-shaped server regression where configuration contains only one group while a second current group has an active coordinator-backed scope and roster. Both groups must be discoverable, and unrelated administrator-visible groups must remain absent.
- Assert that scope-backed devices remain unresolved until reviewed and are not converted directly into Team memberships.
- Add review tests modeling 63 Projects, six devices, repeated labels, 509 exact changes, grouped summaries, and expandable exact details.
- Assert that confirmation evidence and the finish request remain unchanged.
- Extend the legacy Team migration E2E fixture so the migrated group is scope-backed but absent from `sync_coordinator_groups`.
- Run targeted Vitest files, TypeScript, lint, the full workspace test suite, UI build, and legacy Team migration E2E.

## Delivery

1. `codemem-r4lc.1`: wizard progression, candidate layout, and stepper fixes.
2. `codemem-r4lc.2`: grouped review summary and exact-detail disclosures.
3. `codemem-r4lc.3`: focused `0.43.1` release preparation after both fixes merge.

Tagging and public publication remain separately approval-gated.
