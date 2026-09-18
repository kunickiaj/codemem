# Pi Hook Queue-First Design

## Decision

Pi hook ingestion will use the Viewer raw-event inbox as its primary durability boundary. Ordinary transport failures will spool locally without retrying HTTP or opening SQLite. `session_before_compact` and `session_shutdown` retain serialized direct ingest and synchronous flush as the terminal safeguard, matching Claude's boundary policy.

## Viewer ingestion

`POST /api/pi-hooks` continues to validate paired database and identity targets and normalize trusted Pi payloads. When the Viewer inbox is available, the route durably enqueues the normalized request and returns `202 { accepted, queued }`. Embedded configurations without an inbox keep the legacy synchronous `{ inserted, skipped }` response.

The raw-event inbox gains an optional boundary directive containing a source and stream ID. This additive metadata lets a flush-only Pi compaction signal occupy the same ordered queue as raw events without creating a synthetic transcript event. During drain, the Viewer ingests the request, nudges affected sessions, then performs the requested boundary flush. Existing inbox entries and Claude's boolean boundary marker remain readable.

## CLI ingestion

The Pi CLI accepts both queued and legacy Viewer responses. If no backlog exists, it posts the live payload once. An ordinary failure atomically spools the payload and returns without direct SQLite access.

When backlog exists, the CLI atomically spools the live payload under a guaranteed-last filename before acquiring the shared Pi ingest lock. It replays entries oldest-first over HTTP and stops at the first transport failure. This makes the live payload durable before synchronous recovery and preserves event order.

For a terminal boundary, direct ingest and synchronous flush may run only while the invocation owns the Pi spool lock. The live receipt is removed only after the boundary flush reports success. If another invocation owns the lock, the waiter leaves its receipt queued and performs no unlocked direct ingest. This prevents duplicate timestamp-less events while preserving the final boundary safeguard.

## Failure behavior

- Target mismatch, timeout, connection failure, HTTP failure, and malformed response retain the payload in the Pi spool.
- Ordinary events never use direct SQLite fallback.
- Backlog replay stops at the first failed entry and leaves that entry plus later entries queued.
- Boundary direct-ingest failure or flush failure leaves the live receipt queued for retry.
- Queue write failure remains a surfaced error because neither Viewer nor local spool accepted the event.
- Diagnostics remain bounded and exclude payload content, database paths, and identity material.

## Compatibility

The named Pi route remains available for the merged CLI and forthcoming Pi extension layers. New clients accept both response shapes, and older clients continue to work against the synchronous no-inbox route. The change does not alter Pi injection, native tools, setup, or the remaining contributor stack.

## Validation

Tests cover durable `202` acceptance, no-inbox compatibility, event and flush-only boundary ordering, ordinary outages with zero SQLite calls, live-payload durability during stalled recovery, oldest-first replay with first-failure stop, target mismatch, malformed responses, boundary fallback, flush-failure retention, and lock-busy duplicate prevention. Focused CLI and Viewer tests run before TypeScript, lint, the full workspace suite, and build.
