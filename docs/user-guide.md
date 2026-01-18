# User Guide

## Start or restart the viewer
- `opencode-mem serve` runs the viewer in the foreground.
- `opencode-mem serve --background` runs it in the background.
- `opencode-mem serve --restart` restarts the background viewer.

## Seeing UI changes
- The viewer is a static HTML string in `opencode_mem/viewer.py`.
- Restart the viewer after updates.
- If changes don’t show up, ensure the installed package matches this repo:
  - `uv pip install -e .` then rerun `opencode-mem serve --restart`.

## Settings modal
- Open via the Settings button in the header.
- Writes `observer_provider`, `observer_model`, and `observer_max_chars`.
- Environment variables still override file values.

## Memory persistence
- A session is created per ingest payload.
- Observations and summaries persist when the observer emits meaningful content.
- Low-signal observations are filtered before writing.

## Automatic context injection
- The plugin can inject a memory pack into the system prompt.
- Controls:
  - `OPENCODE_MEM_INJECT_CONTEXT=0` disables injection.
  - `OPENCODE_MEM_INJECT_LIMIT` caps memory items (default 8).
  - `OPENCODE_MEM_INJECT_TOKEN_BUDGET` caps pack size (default 800).
- Reuse savings estimate discovery work versus pack read size.

## Semantic recall
- Embeddings are stored via sqlite-vec + fastembed.
- Embeddings are written automatically for new memories.
- Backfill existing memories with: `opencode-mem embed --dry-run` then `opencode-mem embed`.
- If sqlite-vec fails to load, semantic recall is skipped and keyword search remains.

## Troubleshooting
- If sessions are missing, confirm the viewer and plugin share the same DB path.
- Check `~/.opencode-mem/plugin.log` for plugin errors.
