# Maintenance Worker Isolation Design

**Status:** Approved for 0.30 release-readiness  
**Date:** 2026-05-06

## Context

Large upgrade maintenance can run expensive synchronous SQLite statements. Because
codemem uses `better-sqlite3`, those statements block the Node event loop in the
process that runs them. When the viewer owns heavy maintenance, HTTP responses
and signal handlers can stall until SQLite returns.

Restart escalation helps recover a wedged viewer, but it does not keep the live
viewer responsive while maintenance is active.

## Decision

Run heavy maintenance in a managed child process started by `codemem serve`.
The viewer remains responsible for HTTP, sync routes, sync daemon scheduling,
and raw-event sweeping. The worker owns vector migration, scope/backfill
runners, summary/ref/session/dedup backfills, and sync retention.

The worker uses its own SQLite connection. WAL mode and the existing busy
timeout coordinate cross-process access. The viewer never shares a
`better-sqlite3` connection with the worker.

## Lifecycle

- The viewer spawns hidden plumbing command `codemem maintenance worker`.
- The worker records progress through the existing `maintenance_jobs` table.
- `codemem maintenance status` and viewer health surfaces continue to read the
  same status records.
- The worker PID is stored as `maintenance-worker.pid` beside `viewer.pid`.
- Viewer start/restart removes stale trusted workers for the same database.
- Viewer shutdown sends `SIGTERM` to the worker and escalates to `SIGKILL` if
  the worker is blocked in synchronous SQLite work.

## Consequences

This adds one child process while `codemem serve` is running. In exchange, heavy
maintenance can no longer monopolize the viewer event loop. A blocked worker may
still need forceful termination, but that no longer prevents the viewer from
serving HTTP or handling lifecycle signals.
