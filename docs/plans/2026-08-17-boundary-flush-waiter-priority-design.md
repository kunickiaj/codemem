# Boundary flush waiter priority

## Context

An ordinary zero-debounce auto-flush can be marked pending while another flush holds the per-session lock. When that active flush releases the lock, it currently starts the pending ordinary flush synchronously, before an already-waiting explicit boundary flush can acquire the lock. The ordinary pass is unbounded and may process events recorded after the boundary snapshot or delay the boundary response behind continued activity.

## Design

- Track the number of explicit boundary waiters for each session while they wait to acquire the existing per-session flush lock.
- When a flush releases the lock, preserve pending ordinary auto-flush work but do not schedule it while boundary waiters remain.
- After the final waiting boundary flush completes, schedule the preserved ordinary work through the existing debounce path.
- Keep the existing boundary snapshot and `throughEventSeq` query bound unchanged.
- During shutdown, discard in-memory retry markers without discarding persisted events, prevent retries from being re-armed, and drain tracked flushes to a fixed point.
- Add a deterministic regression covering an active flush, a pending zero-debounce nudge, a waiting boundary, and an event recorded after the boundary snapshot.

## Consequences

Explicit boundaries take priority over deferred ordinary work without replacing the current lock with a general-purpose queue. Ordinary activity is not lost; it resumes after boundary waiters drain. Multiple boundary waiters remain serialized and each retains its own captured event-sequence bound.
