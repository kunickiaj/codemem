# Adaptive Widening from Personal to Shared Retrieval

**Bead:** `codemem-qth`  
**Status:** Design  
**Date:** 2026-03-12

## Problem

Identity-aware retrieval now has the right default instinct: stay personal-first.

That improves relevance, but it also creates a new failure mode. Some questions are genuinely about work the
current actor has not touched directly, even though trusted shared memories exist. Right now the only safe answer is
to widen explicitly. That is predictable, but it is also brittle:

- callers need to know in advance when personal-only retrieval will be too narrow
- weak or empty result sets can look like "codemem knows nothing" even when shared context exists
- blindly blending personal and shared results would fix recall at the cost of noisy attribution and trust

We need a narrow, explicit widening design that helps weak personal queries without making shared teammate memory feel
like ambient background radiation.

## Goals

- Keep personal-first retrieval as the default behavior.
- Define when widening is allowed to trigger automatically.
- Keep widened shared results visibly distinct from personal results.
- Preserve explicit caller control over whether widening is allowed.
- Define an evaluation plan before rollout.

## Non-goals

- No hidden default blend of personal and shared results for all queries.
- No trust-state weighting in this slice.
- No teammate-specific routing heuristics or social graph logic.
- No changes to sync scope or replication policy.
- No automatic widening for clearly private/personal questions.

## Current baseline

The current search layer already supports the right raw ingredients:

- personal-first bias via `PERSONAL_FIRST_BONUS`
- ownership filters (`mine|theirs`)
- explicit visibility and workspace filters
- actor/workspace include/exclude filters

The missing piece is a contract for controlled second-pass widening when a personal-first search is weak.

## Proposed retrieval model

### Phase 1: personal-first primary pass

The first pass remains unchanged:

- personal-first bias enabled
- no automatic inclusion of extra shared-only candidates beyond what current filters already allow
- current ranking remains optimized for personal relevance

This preserves existing single-user behavior and keeps the baseline understandable.

### Phase 2: optional widening pass

If the caller explicitly enables widening, codemem may run a second retrieval pass against shared scope when the first
pass is weak.

Recommended API shape:

- `widen_shared_when_weak: bool = False`
- optional `widen_shared_min_personal_results`
- optional `widen_shared_min_personal_score`

Default policy:

- disabled unless the caller opts in

That means the first implementation is still explicit, but callers like memory-pack generation can choose to use it.

## Weak-result trigger rules

The widening trigger should be conservative.

Recommended first-pass trigger:

Widen only when all of the following are true:

1. `widen_shared_when_weak = True`
2. the caller did not already request explicit shared-only or explicit workspace filters that make widening redundant
3. the personal-first pass returns fewer than `N` strong results
4. the query is not obviously personal/private in wording or filters

Recommended initial thresholds:

- `N = 3` results
- strong result = score above a configurable floor derived from current search score normalization

Implementation note:

- start with count-based gating plus a low score floor rather than a fancy confidence model

That is easier to reason about and easier to evaluate.

## Queries that should not auto-widen

Do not widen for:

- queries explicitly filtered to `mine`
- queries explicitly filtered to personal/private visibility or personal workspace only
- queries whose wording strongly signals personal/private intent, for example:
  - "what did I decide"
  - "my notes"
  - "my last session"
  - "my machine"

The first implementation can keep this language guardrail extremely simple:

- only block widening for a short denylist of obvious first-person patterns
- do not attempt full intent classification

## Shared-pass constraints

When widening triggers, the second pass should search only within shared scope.

Recommended constraints:

- `include_visibility = ["shared"]`
- optionally `include_workspace_kinds = ["shared"]`
- preserve explicit include/exclude actor and workspace filters from the caller
- disable personal-first bias in the widened pass

This ensures the second pass is truly additive rather than just rerunning the same search with slightly different rank
weights.

## Result blending contract

Do not fully interleave personal and widened shared results by score alone.

Recommended first implementation:

- keep personal-pass results first
- append at most `M` widened shared results after them
- mark widened results with an explanation flag

Recommended initial limit:

- `M = 2`

This gives the user a visible "here are a couple shared leads" escape hatch without turning the full result set into a
mixed pile.

## Output labeling

Widened shared results must be labeled in the response surface.

Recommended response fields:

- per-result: `widened_from_shared: true|false`
- aggregate metadata:
  - `widening_applied: true|false`
  - `personal_result_count`
  - `shared_result_count`

UI and prompt-pack callers can then render this clearly instead of pretending the results all came from the same pass.

Recommended copy style for product surfaces:

- "Added shared context because personal results were weak."

Short, factual, not mystical.

## Ranking inside the widened shared pass

Use the existing retrieval/rerank logic inside the widened pass with two constraints:

- no personal-first bonus
- no trust-state weighting yet

This keeps the shared pass consistent with the current search stack while avoiding premature ranking complexity.

## Telemetry and evaluation plan

Before broad rollout, capture enough telemetry to answer whether widening helps or just adds noise.

Minimum telemetry:

- whether widening was enabled by the caller
- whether widening triggered
- personal result count before widening
- widened shared result count
- top shared result scores
- actor IDs of widened results

Evaluation questions:

- how often do personal-first queries fall below the trigger threshold?
- how often would widening have added shared results?
- do widened results cluster around a few actors or projects?
- do widened shared additions correlate with better downstream pack usefulness or obvious noise?

For the first implementation, offline inspection plus targeted dogfooding is enough. No need for a giant analytics
program.

## Rollout plan

1. Add opt-in widening flags to the relevant retrieval API surfaces.
2. Instrument widening decisions and result counts.
3. Enable it first for pack-building or other high-context callers that can explain the added shared context.
4. Review real examples before enabling in broader search surfaces.

## Failure modes to avoid

The first implementation must not:

- widen silently for all queries
- insert many shared results ahead of strong personal results
- widen when the caller explicitly asked for `mine`
- widen private/personal scoped queries
- hide whether widened results came from shared scope

## Out of scope for the first implementation

- trust-aware result weighting
- actor affinity or teammate-priority ranking
- automatic widening based on long conversational state
- project-specific widening heuristics beyond explicit filters already present
- UI affordances for per-result "why was this widened" deep inspection

## Acceptance criteria

This design is successful when:

1. The trigger conditions for widening are explicit and conservative.
2. The widened pass is constrained to shared scope and preserves caller filters.
3. Blending rules keep personal results primary and shared results visibly secondary.
4. Telemetry/evaluation requirements are defined before rollout.
5. Failure modes and out-of-scope behaviors are explicit enough to prevent a noisy first implementation.
