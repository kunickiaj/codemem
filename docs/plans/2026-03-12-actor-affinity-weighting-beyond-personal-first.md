# Actor-Affinity Weighting Beyond Personal-First

**Bead:** `codemem-831`  
**Status:** Design  
**Date:** 2026-03-12

## Problem

codemem already has a personal-first retrieval bias. That means the current actor's own memories tend to rank above
memories from other actors when all else is roughly equal.

The open question is whether retrieval should go further and add a distinct actor-affinity weighting model beyond the
current personal-first bonus.

The intuition is reasonable:

- your own memories often match your vocabulary, habits, and decision style better than teammates' memories
- teammate memories may still be useful, but often as secondary context

But this should be treated as a retrieval-quality hypothesis, not folded into trust semantics and not assumed correct
without examples.

## Goal

Define whether there is a meaningful retrieval improvement available beyond the current personal-first bias, and if so,
what the smallest safe next slice should be.

## Non-goals

- Do not overload `trust_state` with actor-affinity meaning.
- Do not add hidden global teammate suppression.
- Do not change sync or visibility policy.
- Do not implement a full social graph or collaborator preference system.

## Current baseline

Today codemem already has:

- `PERSONAL_FIRST_BONUS` in search ranking
- actor/workspace include-exclude filters
- adaptive widening from personal to shared retrieval when enabled
- soft trust-aware penalties for lower-confidence shared memories

That means any new actor-affinity work must answer a specific question:

- what retrieval problem still exists after personal-first bias and adaptive widening?

## Working hypothesis

The likely residual issue is not "prefer my memories over everyone else's" in a blanket sense.
It is narrower:

- among shared results, some actors may consistently be more or less useful to a given user
- current ranking may still bring in teammate context too early when lexical/semantic scores are close

## Recommendation

### Recommendation: do not add a second always-on actor bonus yet

The first recommendation is conservative:

- keep the current personal-first bonus as the main own-memory preference
- do not add another unconditional ranking weight for the current actor yet
- instead, instrument and evaluate whether real examples still show a useful gap

Reason:

- a second always-on own-actor boost may just duplicate current personal-first behavior
- it could hide useful teammate context, especially once widening is active
- we do not yet have evidence that a stronger own-actor preference improves outcomes instead of just feeling intuitively
  correct

## If a follow-on slice is justified later

The first safe extension should be narrow.

Recommended shape:

- apply a very small additional actor-affinity weight only inside widened shared results, not on the full result set
- keep the weight weaker than personal-first bias and weaker than strong lexical/semantic relevance
- make it explicitly optional or shadow-only at first

This treats actor affinity as a tie-breaker inside shared context, not as a new top-level ranking law.

## Interaction with existing behavior

### Personal-first bias

- remains the primary own-memory preference
- actor-affinity work should not replace it

### Adaptive widening

- if actor affinity is explored later, widened shared results are the right place to apply it first
- this reduces the risk of suppressing teammate memories before widening is even needed

### Trust weighting

- stays separate
- trust answers "how confident are we in provenance/review"
- actor affinity answers "whose working style is more likely to match the current user"

## Evaluation plan

Before implementing any new ranking weight, gather examples from dogfooding.

Minimum evaluation method:

1. collect queries where current results feel too teammate-heavy even with personal-first enabled
2. compare current ranking against a shadow-scored variant with a tiny actor-affinity tie-breaker
3. review whether the change improves top-N usefulness without hiding important shared context

Useful signals:

- how often the current actor already dominates top results
- how often teammate memories appear in top-N despite clearly weaker practical usefulness
- whether the problem occurs mainly in widened shared results rather than baseline personal-first search

## Success criteria for future implementation

Only implement actor-affinity weighting if we can show that:

1. current personal-first bias is not enough for a meaningful subset of queries
2. the benefit is visible in real examples, not just intuition
3. the weighting can remain smaller than semantic relevance and smaller than personal-first bias
4. the behavior can be introduced in an optional or shadow-evaluated way first

## Acceptance criteria

This task is successful when:

1. actor affinity is clearly separated from trust semantics
2. the overlap with personal-first and adaptive widening is explicit
3. the recommended next step is grounded in evaluation rather than intuition alone
