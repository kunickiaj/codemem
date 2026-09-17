# Queue-first raw-event ingestion

## Decision

Raw-event HTTP acceptance will no longer wait for SQLite. The Viewer will durably append validated requests to a filesystem inbox, return `202 Accepted`, and drain that inbox into SQLite outside the request path.

## Why

An isolated concurrency sweep showed that the healthy Viewer handled 16 concurrent raw-event requests with 16 ms p95 latency. When the Viewer was unavailable, per-event CLI fallback raised p95 latency to 1.77 seconds and spawned 16 concurrent processes; a SQLite write lock doubled CLI attempts and raised p95 latency to 13.9 seconds.

The current HTTP route and fallback both couple event acceptance to synchronous SQLite writes. A lock can therefore block HTTP, trigger many CLI writers, and make contention worse.

## Design

The Viewer owns a filesystem-backed inbox and a single-flight drainer. The HTTP route validates target metadata and event shape, appends the untargeted request atomically, schedules the drainer, and returns `202` after the append succeeds. The drainer uses bounded work slices, removes an inbox entry only after successful ingestion, and backs off after SQLite failures.

The OpenCode plugin continues to try HTTP first. If HTTP cannot accept the event, the plugin writes its existing retry spool and returns without launching `enqueue-raw-event`. Existing spool drains retry over HTTP so an older Viewer can still ingest retained events after it recovers; the manual CLI command remains available for repair and compatibility.

The readiness probe will avoid SQLite work. Successful durable queueing may produce a deduplicated degradation log, but it will not show a user-facing warning. Spool write failure, capacity exhaustion, corruption, or a sustained backlog remains an error because durability or eventual delivery is at risk.

## Safety and compatibility

The inbox stores only raw-event request bodies, never target paths or identity metadata. File names use content hashes, files remain private to the user, and duplicate delivery remains safe through existing event identity constraints. The Viewer drains retained entries after restart. Legacy synchronous hook endpoints remain unchanged in this slice.
