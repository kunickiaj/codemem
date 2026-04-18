# Cross-Project Fallback Retrieval Design

**Status:** Draft
**Date:** 2026-04-17
**Primary bead:** `codemem-n5un`
**Related code:**
- `packages/core/src/search.ts` (primary scope)
- `packages/core/src/project.ts`
- `packages/ui/src/tabs/feed.ts` (consumer)

## Purpose

Let retrieval broaden past the current project's memories when
current-project results are empty or weak, without losing the default
preference for current-project context.

The original `codemem-n5un` framing was "explore an alternative to per-memory
project reassignment". Direct reassignment is costly because memory project
identity is derived from `sessions.project`, not stored per-memory, so moving a
single memory across projects implies re-parenting (or duplicating) its
session. A retrieval-time fallback avoids that bookkeeping entirely and is
reversible per query.

## Non-goals

- Reassigning memory project membership. Out of scope; this design sidesteps
  it.
- Changing how projects are resolved (git anchor, override). See
  `projectBasename` / `resolveProject` in `project.ts`.
- Cross-*actor* widening. Already handled by `widenSharedWhenWeak` (see
  `search.ts:772-806`). The new flow is orthogonal and composable.

## Current behavior

`search()` applies `filters.project` as a hard SQL filter (`projectClause` →
`WHERE sessions.project = ? OR sessions.project LIKE ?`). Items in other
projects are not considered at all. There is no project-aware relaxation when
results are thin.

The existing `widenSharedWhenWeak` path is the closest precedent:

1. Run primary search.
2. Measure "weak" as `personalResults.length < MIN && topScore < MIN_SCORE`.
3. Run a second search with relaxed ownership filters.
4. Merge, marking widened items via `markWideningMetadata`.

The cross-project fallback should mirror that shape.

## Proposed flow

### Inputs

New optional filters on `MemoryFilters`:

- `widen_project_when_weak: boolean` — default `false`. Must be explicitly set
  for the fallback to run. No implicit behavior change.
- `widen_project_min_results: number` — default `3`. If primary-project
  results count is below this, treat as weak.
- `widen_project_min_score: number` — default a conservative value anchored to
  observed bm25 scores (to be measured; suggested initial `2.0`).
- `widen_project_max_results: number` — default `3`. Cap on how many
  cross-project items can be appended.

### Algorithm

1. Run `searchOnce(store, query, limit, filters)` with the project filter in
   place (current behavior). Call the result `primary`.
2. If widening is disabled, or the query looks project-specific (e.g. query
   mentions paths/concepts clearly rooted in the current project — reuse
   `queryPathHints`/`queryConceptHints` for a signal), return `primary`.
3. Measure weakness on the *primary-project subset* of `primary`:
   `primary.length < widen_project_min_results` OR
   `max(score) < widen_project_min_score`.
4. If strong enough, return `primary`.
5. Otherwise, run `searchOnce(store, query, widen_project_max_results,
   projectWideningFilters(filters))` — where `projectWideningFilters` clears
   `project` from the filter set and disables re-widening.
6. Drop any items that are already in `primary`, and drop items whose
   `session.project` equals the current project (those were already considered).
7. Tag the kept items with `metadata.widened_from_project = true` and, where
   available, `metadata.source_project = <project_name>`. These metadata keys
   are additive, so existing consumers ignore them safely.
8. Append the cross-project items to `primary`. Do **not** interleave — the
   contract is current-project-first ordering.

### Ranking

Primary-project items keep their existing score ordering. Cross-project items
are always sorted below primary-project items, regardless of raw score. This
is the simplest way to preserve "current project wins" while still surfacing
useful fallback context.

If we later want smarter blending (e.g. a very-high-score cross-project item
that beats a very-low-score current-project item), that is a follow-up
decision and should be gated on empirical review, not assumed up front.

### Labeling

`MemoryResult.matches.project_match` already exists and is populated by
`projectMatchesFilter`. For widened items it will be `false`, which is the
correct signal for the UI.

The viewer/feed UI should show a badge like "Other project" (source_project
when present) on any item where `project_match === false` and
`metadata.widened_from_project === true`. Packs built from these results
should mark the cross-project section distinctly so the consumer (agent) sees
the provenance, not just the content.

## Safety boundaries

- **Off by default.** This is a retrieval relaxation; it changes recall, not
  authority. Requires an explicit opt-in filter.
- **Respects ownership/visibility filters.** `projectWideningFilters` only
  clears the `project` field; `ownership_scope`, `include_visibility`,
  `include_workspace_ids`, and `exclude_*` are preserved unchanged. A private
  memory from another project stays private from the viewer's perspective.
- **Blocks on explicit project-scoped queries.** If the query looks
  project-specific (path hints or concept hints resolve in the current
  project), skip widening. Use the same short-circuit shape as
  `queryBlocksSharedWidening`.
- **Bounded result count.** `widen_project_max_results` caps the appended
  cross-project items so a very-broad query can't flood the primary results.

## Composition with existing widening

When both `widen_shared_when_weak` and `widen_project_when_weak` are enabled,
apply them in this order:

1. Primary (own project, own visibility).
2. Widen shared (other actors, same project).
3. Widen project (other projects, same ownership).

Each widening step passes `widen_*_when_weak: false` in its own filters to
prevent recursion. The net effect: strict results first, then actor
broadening within the project, then cross-project broadening.

## Implementation sketch

- Add the four new fields to `MemoryFilters` (both TS types and whatever
  serialization boundary the API uses).
- Add `widenProjectWhenWeakEnabled`, `widenProjectMinResults`,
  `widenProjectMinScore`, `widenProjectMaxResults`, and
  `projectWideningFilters` helpers mirroring the existing shared-widening
  ones.
- Insert the widening step in `search()` after the shared-widening block.
- Add regression tests in `packages/core/src/search.test.ts` covering:
  - Disabled → no fallback runs.
  - Enabled + strong primary → no fallback runs.
  - Enabled + weak primary → fallback runs, cross-project items appended,
    primary-first ordering preserved.
  - Visibility filters suppress cross-project items that should not be visible.
  - Cross-project items carry `metadata.widened_from_project` and
    `metadata.source_project`.
  - Query-shape short-circuit blocks widening.
- UI follow-up (separate bead): badge rendering in feed and pack sections.

## Open questions

1. Should widening be restricted to memories from projects that share a
   repository root or belong to the same user, or is any-project fallback
   acceptable? Default proposal: any-project fallback, because visibility
   filters already gate peer/team privacy. Revisit if dogfooding exposes
   noisy bleed-through.
2. Should the trigger threshold weights be tunable per call, or left as
   implementation defaults? Proposal: filter-level tunables plus sensible
   defaults, matching the shared-widening pattern.
3. Should packs produced from widened results be annotated distinctly in the
   pack header? Proposal: yes, same metadata fields bubble through; the pack
   layer includes a "source_projects" summary when widening contributed.

## Follow-up beads (not yet created)

- Implement `widen_project_when_weak` filter and helpers in
  `packages/core/src/search.ts` with tests.
- Surface `widened_from_project` and `source_project` in feed/pack UI with an
  "Other project" badge.
- Add retrieval diagnostics counter for widening activations (observability).
