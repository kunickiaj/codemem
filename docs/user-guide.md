# User Guide

## Start or restart the viewer
- `codemem serve` runs the viewer in the foreground.
- `codemem serve --background` runs it in the background.
- `codemem serve --restart` restarts the background viewer.

## Seeing UI changes
- The viewer is a static HTML string in `codemem/viewer.py`.
- Restart the viewer after updates.
- If changes don’t show up, ensure the installed package matches this repo:
  - `uv pip install -e .` then rerun `codemem serve --restart`.

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
  - `CODEMEM_INJECT_CONTEXT=0` disables injection.
  - `CODEMEM_INJECT_LIMIT` caps memory items (default 8).
  - `CODEMEM_INJECT_TOKEN_BUDGET` caps pack size (default 800).
- Reuse savings estimate discovery work versus pack read size.

## Semantic recall
- Embeddings are stored via sqlite-vec + fastembed.
- Embeddings are written automatically for new memories.
- Backfill existing memories with: `codemem embed --dry-run` then `codemem embed`.
- If sqlite-vec fails to load, semantic recall is skipped and keyword search remains.

## Sync (Phase 2)

### Enable + run

- `codemem sync enable` generates keys and writes config.
- `codemem sync daemon` starts the sync daemon (foreground).
- `codemem sync status` shows device info and peer health.

### Pair devices

1. In the viewer, open the Sync panel and scan/copy the QR payload (recommended).
2. Or run `codemem sync pair` and copy the payload.
3. On the other device, run `codemem sync pair --accept '<payload>'`.

Optional (recommended for coworker sync): set a per-peer project filter at accept time:

- `codemem sync pair --accept '<payload>' --include shared-repo-1,shared-repo-2`
- `codemem sync pair --accept '<payload>' --exclude private-repo`

### One-off sync

- `codemem sync once` syncs all peers once.
- `codemem sync once --peer <name-or-device-id>` syncs one peer.

### Autostart

- macOS: `codemem sync install` then `launchctl load -w ~/Library/LaunchAgents/com.codemem.sync.plist`.
- Linux (user service): `codemem sync install --user` then `systemctl --user enable --now codemem-sync.service`.
- Linux (system service): `codemem sync install --system` then `systemctl enable --now codemem-sync.service`.

### Service helpers

- `codemem sync status` and `codemem sync start|stop|restart` for daemon control.

### Keychain (optional)

- `sync_key_store=keychain` (or `CODEMEM_SYNC_KEY_STORE=keychain`) stores the private key in Secret Service (Linux) or Keychain (macOS).
- Falls back to file-based storage if the platform tooling is unavailable.
- On macOS, the Keychain storage uses the `security` CLI and may expose the key in process arguments; use `sync_key_store=file` if that is a concern.

## Troubleshooting
- If sessions are missing, confirm the viewer and plugin share the same DB path.
- Check `~/.codemem/plugin.log` for plugin errors.
- Sync errors: `codemem sync status` shows the last error per peer.
