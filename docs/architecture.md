# Architecture

## Overview
- **CLI (`codemem`)** runs ingestion, MCP server, viewer, and export/import.
- **Plugin** captures OpenCode events and streams raw events to the viewer HTTP API.
- **Ingest pipeline** flushes queued raw events, builds transcript, calls the observer, and writes memories.
- **Observer** returns typed observations and a session summary.
- **Store** persists sessions, memories, and artifacts in SQLite.
- **Viewer** serves a static HTML dashboard backed by JSON APIs.
- **MCP server** exposes memory tools to OpenCode.

## Data flow
1. Plugin collects events during an OpenCode session (user prompts, assistant messages, tool calls).
2. Plugin preflights raw-event ingest availability (`GET /api/raw-events/status`) and streams events (`POST /api/raw-events`).
3. Viewer/store persist raw events and queue durable flush batches.
4. Idle/sweeper workers claim and flush queued batches into ingest.
5. Ingest builds transcript from user_prompt/assistant_message events.
6. Observer creates observations + summary from transcript and tool events.
7. Store writes artifacts (transcript, pre/post context), observations, and session summary.
8. Viewer and MCP server read from SQLite.

## Plugin Flush Strategy
The plugin uses an adaptive flush strategy optimized for OpenCode's multi-session environment:

### Event-based flush triggers
- `session.idle`: flushes current buffered events
- `session.created`: flushes current buffered events before switching session
- `/new` boundary (detected from captured user prompt text): flushes current buffered events before switching context
- `session.error`: immediate flush attempt

### Threshold-based Force Flush (immediate)
- 50+ tool executions OR 15+ prompts
- 10+ minutes continuous work

### Stream reliability and failure semantics
- Plugin stream health preflight: `GET /api/raw-events/status`
- Event ingest path: `POST /api/raw-events`
- Stream failures are handled in-plugin with a backoff window (`CODEMEM_RAW_EVENTS_BACKOFF_MS`) and periodic preflight checks (`CODEMEM_RAW_EVENTS_STATUS_CHECK_MS`).
- Once batches are accepted by the viewer/store queue, flush workers own retries (`codemem raw-events-retry`, sweeper/idle flush).

## Sessions and memory persistence
- A **session** is created per ingest payload (one plugin flush).
- Memory items persist when the observer returns meaningful content.
- Low‑signal observations are filtered before writing to SQLite.
- Transcripts are built from captured user_prompt and assistant_message events.

## Export/Import
- **Export:** Serialize sessions, memory_items, session_summaries, user_prompts to versioned JSON
- **Import:** Restore memories with optional project path remapping for team sharing
- Use cases: knowledge transfer, backup/restore, team onboarding

## Configuration
- File config lives at `~/.config/codemem/config.json`.
- Environment variables override file settings.
- Viewer settings modal edits only observer provider/model/max chars.

## Viewer
- Implemented in `codemem/viewer.py` as an embedded HTML page.
- Serves JSON APIs for stats, sessions, memory items, and config.
- Viewer stats cards are sourced from `/api/stats`, `/api/usage`, and `/api/raw-events`.
- Restart required to pick up HTML changes.

## Context injection
- The plugin injects a memory pack into the system prompt using OpenCode hook APIs.
- Injection is per session and bounded by a configurable token budget.
- Reuse savings compare observer discovery tokens to pack read size.

## Semantic recall
- Embeddings are stored in the `memory_vectors` sqlite-vec table.
- Vectors are written when memories are created, or via `codemem embed` for backfill.
- Pack/inject can merge keyword and semantic results when embeddings are available.
