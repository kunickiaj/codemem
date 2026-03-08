# Shared Memory Trust-State Semantics

**Bead:** `codemem-d2a.7`  
**Status:** Implemented for MVP  
**Date:** 2026-03-08

## Goal

Define what `trust_state` means in the first identity-aware sync release without turning it into a permissions system.

## MVP stance

`trust_state` is descriptive metadata, not an authorization gate.

In MVP it does **not**:

- block sync
- block retrieval
- force separate storage pools
- rewrite ranking beyond existing `personal_first` behavior

In MVP it **does**:

- preserve provenance quality on stored and replicated memories
- distinguish normal known-local writes from legacy synced data with incomplete provenance
- give the viewer and future retrieval work a stable field to surface and refine

## Values

### `trusted`

Use for memories whose provenance is fully known under the current MVP model.

Current defaults:

- local writes default to `trusted`
- explicitly shared local writes also default to `trusted`
- replicated memories that carry explicit provenance and no downgrade signal remain `trusted`

Interpretation:

- authorship and origin metadata are present enough to treat the memory as ordinary first-class context
- no special warning or penalty is needed in retrieval

### `legacy_unknown`

Use for older synced memories that predate identity-aware provenance and had to be backfilled conservatively.

Current defaults:

- legacy synced rows with incomplete actor/workspace metadata backfill to `legacy_unknown`

Interpretation:

- the memory is still usable
- provenance is incomplete or synthesized from older replication metadata
- UI may surface this as a cautionary provenance label, but retrieval should not hide it by default

### `unreviewed`

Reserved for future use.

Interpretation:

- a memory is shareable/readable, but has not yet earned the same confidence as `trusted`
- this value exists now so future review or trust workflows have a stable enum target

MVP does not assign special retrieval or sync behavior to `unreviewed`.

## Interaction with visibility

`visibility` and `trust_state` answer different questions:

- `visibility` = who may receive the memory (`private|shared`)
- `trust_state` = how complete/confident we are about its provenance

Examples:

- a memory can be `shared` and still be `legacy_unknown`
- a memory can be `private` and `trusted`

The system should not overload `trust_state` to mean "is this allowed to sync?" That is the job of `visibility` plus existing sync filters.

## Interaction with retrieval

MVP retrieval behavior stays intentionally simple:

- rank local-actor memories first with `personal_first`
- allow actor/workspace/visibility filtering explicitly
- do not add trust-weight ranking yet

This avoids inventing invisible ranking heuristics before users can understand the underlying provenance model.

## Interaction with sync

MVP sync behavior also stays simple:

- only `visibility=shared` memories are eligible for outbound sync
- `trust_state` does not veto or widen sync on its own
- legacy inbound payloads remain compatible even when they predate explicit visibility/trust metadata

## Deferred work

Out of scope for MVP:

- trust-based retrieval penalties or boosts
- per-identity trust policies
- sync allow/deny rules based on trust
- manual review queues
- cryptographic author verification beyond existing peer trust and provenance fields

## Practical rule of thumb

If a future change needs `trust_state` to change behavior, it should answer two questions explicitly first:

1. Is this a retrieval concern, a sync concern, or both?
2. Why is `visibility` or `actor_id` insufficient for that behavior?

If those answers are fuzzy, the behavior probably does not belong in MVP trust-state semantics.
