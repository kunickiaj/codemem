# Architecture

## Overview
- **CLI (`opencode-mem`)** runs ingestion, MCP server, and the viewer.
- **Plugin** captures OpenCode events and posts them to `opencode-mem ingest`.
- **Ingest pipeline** builds session context, calls the observer, and writes memories.
- **Observer** returns typed observations and a session summary.
- **Store** persists sessions, memories, and artifacts in SQLite.
- **Viewer** serves a static HTML dashboard backed by JSON APIs.
- **MCP server** exposes memory tools to OpenCode.

## Data flow
1. Plugin collects events during an OpenCode session.
2. `opencode-mem ingest` starts a session in SQLite.
3. Observer creates observations + summary from the tool transcript.
4. Store writes artifacts, observations, and session summary memory.
5. Viewer and MCP server read from SQLite.

## Sessions and memory persistence
- A **session** is created per ingest payload (one plugin flush).
- Memory items persist when the observer returns meaningful content.
- Low‑signal observations are filtered before writing to SQLite.

## Configuration
- File config lives at `~/.config/opencode-mem/config.json`.
- Environment variables override file settings.
- Viewer settings modal edits only observer provider/model/max chars.

## Viewer
- Implemented in `opencode_mem/viewer.py` as an embedded HTML page.
- Serves JSON APIs for stats, sessions, memory items, and config.
- Restart required to pick up HTML changes.

## Context injection
- The plugin injects a memory pack into the system prompt using OpenCode hook APIs.
- Injection is per session and bounded by a configurable token budget.
- Reuse savings compare observer discovery tokens to pack read size.
