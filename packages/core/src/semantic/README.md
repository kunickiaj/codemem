# Semantic ranking runtime

The file-backed `MemoryStore` uses this runtime by default when embeddings are
enabled. One worker owns native SQLite vector ranking; the parent owns embedding,
pack assembly, usage, and retrieval-ledger writes. The same runtime serves core
packs, Viewer HTTP, MCP HTTP, and CLI requests.

## Request flow

1. The parent checks the store identity and prepares the query embedding.
2. The worker opens a read-only SQLite connection, loads sqlite-vec, and runs the
   exact native nearest-neighbor query for authorized, compatible vectors.
3. The parent checks the returned vector and content versions, reloads the current
   authorized memory payloads, then builds the pack.

Ranking is exact native KNN, not approximate nearest-neighbor search. The worker
uses its own read snapshot and recomputes visibility, continuity, and compatible
models. It does not construct a store, accept SQL or executable code, read a
private key, or inherit the parent environment.

Only validated vectors supply semantic evidence. Building generations use keyword
retrieval until validation completes. A completed audit can serve valid rows while
other derived rows await repair; invalid rows are excluded before native KNN or
scalar distance evaluation.

Maintenance removes derived rows with invalid numeric values or unusable metadata so normal
backfill can recreate them. It retains rows rejected for their model until an
explicit model transition. Source memories are not rewritten.

## Database layout upgrade

When a file-backed store opens with embeddings enabled, the parent upgrades an
older vector layout before serving requests. It copies existing vectors into the
new physical table in one immediate transaction, preserving vector row IDs and
bytes. A compatibility view lets older retirement deletes keep metadata and
version counts consistent, but blocks older inserts and updates with an
upgrade-required error.

The upgrade needs all writers to be updated before semantic use. It has no
automatic downgrade. If another writer holds the database busy, the upgrade fails
quickly and leaves the legacy layout intact; close the other writers and reopen.
The copy and its write-ahead log can need temporary disk space roughly comparable
to the vector tables. With `CODEMEM_EMBEDDING_DISABLED=1`, the store skips both
the upgrade and semantic runtime and continues with keyword retrieval.

## Admission, cancellation, and fallback

The runtime accepts one active semantic operation and four queued operations.
Requests have a 15-second queue deadline and a 5-second readiness deadline.
An aborted queued request is removed. Aborting an active request stops waiting and
prevents delivery, but cannot interrupt native SQLite work or embedding inference;
its slot remains occupied until that work finishes or the worker exits.

Worker failure, overload, or an unavailable semantic runtime uses the existing
non-semantic path. The runtime never retries ranking as inline SQLite work.

A worker crash or readiness timeout disables semantic retrieval for that store.
The process emits one warning containing the typed failure code; later requests
use non-semantic retrieval until the owning process restarts. Restart that process
to restore semantic ranking.

Overload and individual request deadlines do not restart the worker or replay
ranking.
Identity, database-file, and key changes reject the request rather than returning
results from a different store.

## Shutdown and API ownership

`MemoryStore.closeAsync()` is idempotent. It stops new semantic work and waits for
the worker, preparation, pending vector writes, and vector audit before SQLite
closes. After five seconds it requests worker termination, but still joins native
work and parent preparation; embedding inference has no fixed completion time.

`close()` cancels unfinished best-effort derived writes for synchronous callers.
It throws
`semantic_store_close_async_required` when the store owns asynchronous semantic
work. Production owners must await `closeAsync()`:

```ts
try {
  // Use the store.
} finally {
  await store.closeAsync();
}
```

`semanticSearchAsync(input, options)` accepts an optional `AbortSignal` in its
last options argument. HTTP and MCP callers forward request cancellation. This
cancels waiting and delivery, not native SQL or an in-progress embedding request.

## Pack compatibility

All asynchronous pack builders use the same executor. `memory_search` and
`memory_pack` retain their existing keyword and presentation contracts;
`memory_pack` now uses the hybrid executor by default. In-memory databases and
database-based inline semantic search remain compatibility paths and do not give
worker isolation.
