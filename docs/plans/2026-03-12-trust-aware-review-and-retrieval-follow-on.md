# Trust-Aware Review and Retrieval Follow-on

**Bead:** `codemem-2av`  
**Status:** Design  
**Date:** 2026-03-12

## Problem

`trust_state` exists today, but it is mostly inert. That was the right MVP choice.

Now that identity-aware provenance and explicit shared/private controls exist, the next question is not
"should trust_state become auth policy?" It absolutely should not. The real question is simpler:

- what is the minimum useful review and retrieval behavior that makes provenance quality visible
- without hiding shared context by default
- and without turning trust_state into a permission engine

## Goal

Define the first narrow behavior change for `trust_state` across retrieval and review surfaces.

The first follow-on slice should:

- make provenance quality visible in product surfaces
- make trust state queryable and filterable where useful
- optionally apply a small ranking preference against lower-confidence shared memories
- avoid any sync allow/deny semantics

## Non-goals

- No auth or access-control behavior.
- No blocking sync based on trust state.
- No mandatory manual review queue before shared memories are usable.
- No cryptographic verification model.
- No actor-specific trust policies in this slice.

## Current baseline

Today:

- `trusted` is the default for normal local and explicit-provenance synced memories
- `legacy_unknown` marks backfilled provenance from older sync history
- `unreviewed` exists as a reserved enum but is not yet operationally meaningful

The viewer can surface trust badges, but retrieval does not yet use trust state beyond plain display.

## Recommended first follow-on behavior

### 1) Review behavior: make trust visible, not blocking

The first review improvement should be a lightweight provenance review surface, not a moderation system.

Recommended behavior:

- show trust state clearly on shared memories in the viewer/feed
- allow users to filter for low-confidence shared memories (`legacy_unknown`, later `unreviewed`)
- add a minimal action to mark a memory as reviewed/trusted when the product eventually exposes item editing beyond
  visibility controls

This is enough to make the field useful without pretending codemem has a human review workflow platform.

### 2) Retrieval behavior: soft penalty only for lower-confidence shared results

The first retrieval behavior should be intentionally mild.

Recommended rule:

- do not penalize or alter local/private memories based on trust state
- apply at most a small ranking penalty to shared memories with `trust_state in {legacy_unknown, unreviewed}`
- never remove these memories from results solely because of trust state unless the caller explicitly filters them out

This keeps trust-state behavior as a ranking refinement rather than a hidden censorship layer.

## Proposed states and transitions

### `trusted`

Meaning:

- provenance is explicit enough to treat the memory as ordinary first-class context

Transitions in first follow-on slice:

- default for normal local/shared writes
- destination state when a user explicitly reviews a lower-confidence shared memory

### `legacy_unknown`

Meaning:

- provenance was synthesized from legacy sync history

Transitions in first follow-on slice:

- set automatically by legacy backfill paths
- may transition to `trusted` when the operator resolves provenance confidence through explicit review or actor cleanup

### `unreviewed`

Meaning:

- provenance is explicit enough to be useful, but the memory has not yet been reviewed in a future shared-review flow

First-slice recommendation:

- do not mass-assign `unreviewed` yet
- reserve it for future product surfaces that create or import shared memories needing review semantics

This avoids inventing a noisy state transition just to feel busy.

## Product surfaces for the first slice

### Viewer/feed

Add the minimum useful trust-aware UI:

- visible trust badge for non-`trusted` shared memories
- optional feed/search filter for low-confidence trust states
- simple explanatory copy for `legacy_unknown`

Recommended copy:

- `legacy provenance`
- `shared provenance not fully confirmed`

Short and human. No compliance theater.

### Search and pack APIs

Add optional trust filters:

- `include_trust_states`
- `exclude_trust_states`

And optionally a caller-controlled ranking flag:

- `trust_bias: off|soft`

Default recommendation:

- `off` for direct search surfaces until evaluated
- `soft` may be reasonable later for pack-building or widened shared retrieval, but only after examples are reviewed

## Ranking guidance

If trust-aware ranking is enabled, keep it small.

Recommended first-pass weights:

- `trusted`: no change
- `legacy_unknown`: small penalty
- `unreviewed`: same or slightly smaller penalty than `legacy_unknown`

The penalty should be weaker than personal-first bias and weaker than obvious lexical/semantic relevance. The goal is
"prefer cleaner provenance when results are otherwise similar," not "bury anything imperfect."

## Evaluation plan

Before enabling trust-aware ranking by default, inspect real examples for:

- whether `legacy_unknown` results actually look noisier than `trusted` shared results
- whether the penalty hides useful historical context too aggressively
- whether users reach for explicit trust filters in the viewer

Minimum telemetry:

- trust-state distribution in result sets
- when a trust filter was used
- when a ranking penalty changed top-N ordering

## Failure modes to avoid

Do not:

- turn `trust_state` into an implicit access-control gate
- hide `legacy_unknown` results by default
- apply trust penalties to the local actor's own memories
- overload `unreviewed` before a real review workflow exists
- mix trust semantics with sync authorization

## Out of scope for this slice

- per-actor trust policies
- reviewer identities or audit logs
- sync quarantine queues
- cryptographic attestation
- automatic promotion from `legacy_unknown` based on weak heuristics alone

## Acceptance criteria

This design is successful when:

1. The minimum useful trust-aware behavior is defined without becoming auth policy.
2. Review behavior and ranking behavior are clearly separated.
3. The states, transitions, and product surfaces are explicit.
4. The first implementation remains conservative and reversible.
