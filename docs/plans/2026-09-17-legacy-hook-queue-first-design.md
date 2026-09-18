# Legacy Hook Queue-First Design

## Outcome

Claude and Codex ingest hooks should return quickly after a durable queue write instead of retrying HTTP and opening SQLite in every hook process. Claude injection remains synchronous because it must return context to the host, while Pi behavior remains unchanged.

## Design

The existing `/api/claude-hooks` and `/api/codex-hooks` routes continue to validate the configured target and map trusted host payloads into normalized raw-event envelopes. When the viewer inbox is available, each route writes the envelope durably and returns the same `202 { accepted, queued }` contract as `/api/raw-events`. Embedded configurations without an inbox retain synchronous ingestion.

New CLI versions accept both the queued response and the legacy `{ inserted, skipped }` response. This keeps new clients compatible with older viewers. Older clients may retry or use their existing fallback against a newer viewer, but event identity keeps that transition idempotent.

For ordinary events, a failed HTTP attempt writes the existing Claude or Codex hook spool immediately. It does not make a second HTTP attempt or open SQLite directly. A later healthy hook invocation drains retained payloads through the HTTP queue in order and stops at the first transport failure.

Claude boundary events send the boundary-flush marker to the viewer inbox. If HTTP delivery fails, the existing direct ingest and synchronous boundary flush remain as the last durability safeguard. This confines expensive direct SQLite work to terminal boundaries instead of every event during an outage.

## Diagnostics and Errors

HTTP delivery records a bounded failure class: timeout, connection, HTTP status, malformed response, or target mismatch. Logs include elapsed time and delivery outcome but never payloads, database paths, hostnames, or transcript content. Spool, lock, boundary-write, boundary-flush, and local injection-pack operations record elapsed time using the same privacy boundary.

The server acknowledges success only after the inbox entry and containing directory are synced. Queue-full and queue-write failures remain explicit non-2xx responses so the CLI retains the payload locally. Duplicate HTTP or spool delivery remains safe through stable raw-event identity.

## Validation

Tests cover queued and legacy responses, ordinary failure without direct SQLite access, ordered spool recovery, duplicate delivery, target mismatch, malformed responses, lock contention, queue-full behavior, and Claude boundary fallback. Focused CLI and viewer tests run before the full TypeScript, lint, test, and build gates.

A short dogfood sample records Claude ingest and injection latency plus fallback frequency. `codemem-59vw.1` closes only after the sample confirms ordinary events stay off direct SQLite and retained events recover after the viewer returns.
