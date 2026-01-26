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
- Writes `observer_provider`, `observer_model`, `observer_max_chars`, `pack_observation_limit`, and `pack_session_limit`.
- Sync settings can also be updated here (`sync_enabled`, `sync_host`, `sync_port`, `sync_interval_s`, `sync_mdns`).
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

## Sync (Phase 2)

### Enable + run

- `opencode-mem sync enable` generates keys and writes config.
- `opencode-mem sync daemon` starts the sync daemon (foreground).
- `opencode-mem sync status` shows device info and peer health.

### Pair devices

1. In the viewer, open the Sync panel and scan/copy the QR payload (recommended).
2. Or run `opencode-mem sync pair` and copy the payload.
3. On the other device, run `opencode-mem sync pair --accept '<payload>'`.

### One-off sync

- `opencode-mem sync once` syncs all peers once.
- `opencode-mem sync once --peer <name-or-device-id>` syncs one peer.

### Autostart

- macOS: `opencode-mem sync install` then `launchctl load -w ~/Library/LaunchAgents/com.opencode-mem.sync.plist`.
- Linux (user service): `opencode-mem sync install --user` then `systemctl --user enable --now opencode-mem-sync.service`.
- Linux (system service): `opencode-mem sync install --system` then `systemctl enable --now opencode-mem-sync.service`.

### Service helpers

- `opencode-mem sync status` and `opencode-mem sync start|stop|restart` for daemon control.

### Keychain (optional)

- `sync_key_store=keychain` (or `OPENCODE_MEM_SYNC_KEY_STORE=keychain`) stores the private key in Secret Service (Linux) or Keychain (macOS).
- Falls back to file-based storage if the platform tooling is unavailable.
- On macOS, the Keychain storage uses the `security` CLI and may expose the key in process arguments; use `sync_key_store=file` if that is a concern.

## Troubleshooting
- If sessions are missing, confirm the viewer and plugin share the same DB path.
- Check `~/.opencode-mem/plugin.log` for plugin errors.
- Sync errors: `opencode-mem sync status` shows the last error per peer.
