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
2. Plugin streams raw events to `/api/raw-events` on the viewer.
3. Python-side flush workers drain queued raw events and run ingest/observer.
4. Observer creates observations + summary from transcript and tool events.
5. Store writes artifacts (transcript, pre/post context), observations, and session summary.
6. Viewer and MCP server read from SQLite.

## Plugin Flush Strategy
The plugin uses an adaptive flush strategy optimized for OpenCode's multi-session environment:

### Idle-based Flush (scheduled on `session.idle`)
- **Light work:** 2 minute delay
- **Heavy work** (10+ tools OR 5+ prompts): 60 second delay
- **Very heavy work** (30+ tools OR 10+ prompts): 30 second delay

### Threshold-based Force Flush (immediate)
- 50+ tool executions OR 15+ prompts
- 10+ minutes continuous work

### Event-based Flush (immediate)
- `session.error` event

**Note:** In OpenCode's multi-session world, `/new` command and `session.created` events don't trigger flushes. The adaptive strategy compensates by using work-based heuristics.

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
- Restart required to pick up HTML changes.

## Context injection
- The plugin injects a memory pack into the system prompt using OpenCode hook APIs.
- Injection is per session and bounded by a configurable token budget.
- Reuse savings compare observer discovery tokens to pack read size.

## Semantic recall
- Embeddings are stored in the `memory_vectors` sqlite-vec table.
- Vectors are written when memories are created, or via `codemem embed` for backfill.
- Pack/inject can merge keyword and semantic results when embeddings are available.
