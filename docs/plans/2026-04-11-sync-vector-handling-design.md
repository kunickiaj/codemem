# Sync Vector Handling Design

**Status:** Draft
**Date:** 2026-04-11
**Related docs:**
- `docs/architecture.md`
- `docs/plans/2026-03-15-embedding-packaging.md`
- `docs/plans/2026-03-15-db-coexistence-contract.md`
- `docs/plans/2026-04-01-fast-peer-bootstrap-design.md`
**Primary bead:** TBD

## Purpose

Define how codemem should maintain semantic-search coverage for memories received
through sync.

Today, sync replicates `memory_items` payloads but not `memory_vectors`, and the
receiver-side replication apply path does not automatically generate vectors for
inbound memories. That leaves a gap where synced memories exist locally but are
not available to semantic search unless vectors are generated some other way.

This document proposes the product and implementation direction for closing that
gap.

## Problem

The current sync story is asymmetrical:

- **durable memory data** is transferred via replication ops and bootstrap snapshots
- **vector index data** is local and derived

That is not inherently wrong. The issue is that the receiver currently does not
reliably rebuild the derived index on arrival.

As a result:

- synced memories may be searchable by keyword/FTS but not by semantic search
- bootstrap can leave a large peer with little or no vector coverage locally
- users would have to rely on manual backfill (`codemem embed`) to repair coverage

That is not an acceptable default product story.

## Current State

### What sync transfers

Replication ops and snapshot/bootstrap carry full `memory_items` payloads and
related synced entity data.

Evidence:

- `packages/core/src/sync-replication.test.ts` verifies that upsert ops carry the
  full memory payload and round-trip all replicated columns
- `packages/core/src/sync-replication.ts` applies inbound memory upserts by
  inserting or updating `memory_items`

### What sync does not transfer

Sync does not currently replicate `memory_vectors` rows as part of memory-item
 replication payloads.

### What the receiver currently does not do

`applyReplicationOps()` does not call `storeVectors()`, queue vector writes, or
schedule a targeted vector backfill for newly inserted or updated inbound
memories.

### Existing vector posture

The existing architecture already treats vectors as derived/local index data:

- `docs/architecture.md` describes `memory_vectors` as a local sqlite-vec table
  written on create or backfill
- `docs/plans/2026-03-15-db-coexistence-contract.md` explicitly says vec/embedding
  sync is application-level and that vectors can be regenerated
- `docs/plans/2026-03-15-embedding-packaging.md` notes that different runtimes may
  produce slightly different vectors, but each runtime remains internally consistent

This means the missing piece is not conceptual permission to regenerate. The
missing piece is doing it automatically on receive.

## Product Requirement

Users should not need to run periodic manual embedding backfills just to make
synced memories semantically searchable.

Operationally, we need one of two guarantees:

1. sync transfers vectors along with memory data, or
2. the receiver automatically generates vectors for inbound synced memories

## Options

### Option A — Transfer vectors through sync

Replicate `memory_vectors` rows as part of snapshot/bootstrap and incremental op
application.

#### Pros

- receiver gets semantic-search coverage immediately
- no re-embedding cost on arrival
- useful for large bootstrap where embedding generation would take time

#### Cons

- vectors are derived data, so replication payloads get heavier
- transfers embed model/version assumptions into sync payload semantics
- mixed-runtime/model compatibility becomes more complex
- stale vector cleanup and migration semantics now need to propagate over sync
- vectors may need to be re-generated locally anyway if model policy changes

#### Assessment

Possible, but it makes the sync protocol carry more derived-index concerns than
it does today.

### Option B — Generate vectors automatically on receive

Keep sync replication focused on durable memory rows, but trigger receiver-side
vector generation whenever inbound memories are inserted or materially updated.

#### Pros

- keeps replication payloads smaller and simpler
- preserves the current conceptual model that vectors are local derived index data
- avoids cross-peer transport of model-specific vector blobs
- works even if sender and receiver embedding runtimes differ slightly
- stale vectors remain a local maintenance concern, which already fits current design

#### Cons

- semantic coverage is not instantaneous if model download or embedding work is slow
- bootstrap may need a background reindex pass for large imports
- receivers without embedding capability will still degrade to keyword-only search

#### Assessment

This matches the current architecture better and is the recommended default.

## Recommendation

**Choose Option B: generate vectors automatically on receive.**

Rationale:

1. vectors are already treated as derived/local index data
2. replication today is designed around durable memory payloads, not search indexes
3. model differences across runtimes already exist and are acceptable when each
   node embeds consistently with itself
4. local regeneration is simpler than teaching sync how to replicate and manage
   vector-table lifecycle

In short:

> sync should transfer durable memory state; each receiver should build the local
> semantic index automatically.

This does mean that **fresh-peer bootstrap semantic readiness may lag behind data
readiness**. That tradeoff is acceptable if the system makes the lag automatic,
resumable, and visible rather than requiring operator intervention.

## Design

### Rule 1 — Inbound memory upserts should queue vector work

When `applyReplicationOps()` inserts or updates a `memory_item`, the receiver
should determine whether vector work is needed for that memory.

At minimum:

- new memory inserted by sync → queue vector generation
- existing memory updated with changed title/body → queue vector regeneration
- delete/tombstone or inactive memory → remove or invalidate existing vector rows

### Rule 2 — Vector generation should not block sync correctness

Inbound replication should continue to treat vector generation as non-fatal.

If embeddings are unavailable because:

- sqlite-vec cannot load
- the embedding model is not downloaded yet
- the embedding runtime throws

then sync should still apply the memory row successfully and record that vector
coverage is pending or skipped.

### Rule 3 — Large bootstrap should batch receiver-side reindexing

For large bootstrap/snapshot applies, vector generation should not happen as a
fully synchronous per-memory cost inside the hottest apply loop.

Instead:

- collect affected memory IDs during apply
- run a batched receiver-side vector pass after the transaction commits
- allow this work to continue in the background if necessary

Bootstrap should therefore be understood as two-stage readiness:

1. **data-ready** — memory rows are present and sync state is correct
2. **semantic-ready** — local vector coverage has caught up

The design goal is not to hide this distinction. The design goal is to make the
second stage automatic and reliable.

### Rule 4 — Re-embedding should be content-aware

Only regenerate vectors when the embeddable content changed.

Likely triggers:

- `title` changed
- `body_text` changed
- current vector model missing for the memory

Non-triggers:

- provenance-only metadata updates
- visibility/trust changes without content changes

### Rule 5 — Receiver should tolerate zero-vector mode

If a node cannot embed at all, synced memories should still work through FTS and
other retrieval paths. The system should degrade gracefully rather than treating
missing vectors as sync failure.

## Proposed Implementation Shape

### A. Collect vector work during apply

Extend `applyReplicationOps()` to track a small side list such as:

```ts
interface ReplicationVectorWork {
  upsertIds: number[];
  deleteIds: number[];
}
```

That list should be built while processing inbound memory-item ops.

### B. Return vector work from apply path

Instead of hiding all side effects inside `ApplyResult`, return or expose enough
information for the caller to enqueue follow-up vector maintenance.

Example direction:

```ts
interface ApplyResult {
  applied: number;
  skipped: number;
  conflicts: number;
  errors: string[];
  vector_work?: {
    upsert_memory_ids: number[];
    delete_memory_ids: number[];
  };
}
```

### C. Add a receiver-side vector maintenance helper

Introduce a small helper that:

- deletes stale vector rows for deleted/inactive memories
- runs `backfillVectors()` or targeted `storeVectors()` for changed inbound rows
- handles missing embeddings non-fatally

This should likely live near `vectors.ts` or `sync-replication.ts`, but remain a
separate focused function rather than bloating `applyReplicationOps()`.

### D. Use two execution modes

#### Incremental sync

For normal inbound op batches:

- collect changed memory IDs
- after transaction commit, run a small targeted vector-maintenance pass

#### Bootstrap / snapshot apply

For large bootstrap applies:

- collect changed memory IDs across the snapshot
- perform batched vector backfill after apply
- report progress through existing maintenance job or sync diagnostics surfaces if needed

### E. Persist pending vector work across restarts

Receiver-side vector generation for synced memories should not live only in
process memory.

We should maintain a durable pending-work mechanism so that:

- a large bootstrap can resume after restart
- temporary embedding/runtime failures do not lose the backlog
- diagnostics can report actual semantic-index lag

This can take the form of:

- a dedicated queue table, or
- a maintenance job state plus resumable memory-id cursor ranges

Exact shape is an implementation detail, but durable recovery is part of the
reliability requirement.

## Why not do vector writes inline in the transaction?

Because that couples sync correctness to the slowest and least reliable part of
the embedding pipeline.

Inline writes would create bad failure modes:

- model download delays block sync apply
- embedding failures cause partial or slow replication behavior
- large bootstrap becomes much more expensive in the critical path

The better separation is:

- **transactional sync apply** for durable memory state
- **post-commit best-effort vector maintenance** for local semantic index state

## Deletion and stale-vector policy

Receiver-side vector maintenance must handle deletions as well as inserts.

When an inbound delete/tombstone wins:

- keep the tombstone semantics for `memory_items`
- remove vector rows for that memory locally if present

When an inbound upsert replaces content:

- old model/content-hash rows should not remain the active effective index for
  that memory under the current target model

This should align with the existing vector migration and stale-row cleanup logic.

## User Experience

### Desired behavior

- a newly synced memory becomes keyword-searchable immediately
- semantic search coverage appears automatically shortly after receipt
- large peer bootstrap may take time to finish embedding, but does not require
  manual operator intervention
- if embeddings are unavailable, codemem still works and makes the degraded state visible

For bootstrap specifically, the user experience should be:

- sync completes without requiring embeddings to succeed inline
- the node is usable immediately for exact/FTS retrieval
- semantic indexing continues automatically until coverage catches up
- restart does not discard indexing progress or pending work

### Diagnostics

We should consider surfacing:

- inbound memories pending embedding after sync
- receiver-side vector maintenance failures
- whether the local node is running without embeddings

This can likely piggyback on existing maintenance job or sync diagnostics UI.

## Validation Requirements

At minimum, implementation should add tests for:

1. inbound sync upsert inserts memory row and schedules or performs vector work
2. inbound sync update with changed content regenerates vectors
3. inbound metadata-only update does not re-embed unnecessarily
4. inbound delete removes or invalidates vector rows
5. embedding failure during receive does not fail `applyReplicationOps()`
6. bootstrap path eventually yields local vector coverage for received memories

## Open Questions

1. should receiver-side vector work be tracked as a dedicated maintenance job, or
   remain an internal best-effort queue?
2. for very large bootstrap, should we chunk vector backfill by snapshot page,
   by fixed memory count, or by time budget?
3. should sync diagnostics report semantic-index lag explicitly?
4. do we want a small persisted queue of pending vector work so restarts do not
   lose the backlog?
5. should sender-side vector transfer ever be added as an optimization later,
   even if receiver-side generation is the default contract?

## Recommendation Summary

The immediate contract should be:

- sync transfers durable memory rows
- receivers automatically build local vectors for inbound memories
- vector generation is post-commit and non-fatal
- bootstrap batches vector work instead of requiring manual backfill
- pending vector work survives restart and reports progress/lag

That gives codemem a usable semantic-search story for sync without bloating the
replication protocol around derived index data.
