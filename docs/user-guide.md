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

## Troubleshooting
- If sessions are missing, confirm the viewer and plugin share the same DB path.
- Check `~/.opencode-mem/plugin.log` for plugin errors.
