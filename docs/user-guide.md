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
- Shows effective values (configured or default) to avoid blank/ambiguous fields.
- Persists only changed settings on save (unchanged effective defaults are not rewritten to config).
- Uses task-oriented sections: `Connection`, `Processing`, and `Device Sync`.
- Includes a `Show advanced controls` toggle for technical tuning fields (JSON headers, cache/timeout, network overrides, and pack limits).
- Connection/auth settings map to `claude_command`, `observer_runtime`, `observer_provider`, `observer_model`, `observer_base_url`, `observer_auth_source`, `observer_auth_file`, `observer_auth_command`, `observer_auth_timeout_ms`, `observer_auth_cache_ttl_s`, and `observer_headers`.
- Sync settings can also be updated here (`sync_enabled`, `sync_host`, `sync_port`, `sync_interval_s`, `sync_mdns`).
- Environment variables still override file values.
- Config file supports JSON and JSONC (`~/.config/codemem/config.json` or `~/.config/codemem/config.jsonc`).

## Observer auth configuration

- Runtime choices are `api_http` and `claude_sidecar`.
- `claude_sidecar` runs observer calls through the local Claude runtime (subscription/session auth) and does not require `ANTHROPIC_API_KEY`.
- `claude_command` controls how `claude_sidecar` invokes Claude CLI (default `["claude"]`).
  - Wrapper example: `"claude_command": ["wrapper", "claude", "--"]`
- Default model selection:
  - `api_http`: `gpt-5.1-codex-mini` unless `observer_model` is set.
  - `claude_sidecar`: `claude-4.5-haiku` unless `observer_model` is set.
- If a configured `observer_model` is unsupported by Claude CLI, codemem retries once with Claude's default model.
- Supported auth sources: `auto`, `env`, `file`, `command`, `none`.
- `observer_auth_command` is argv and must be a JSON string array, not a space-separated string.
  - Config file form: `"observer_auth_command": ["iap-auth", "--audience", "example"]`
  - Env var form (`CODEMEM_OBSERVER_AUTH_COMMAND`): `'["iap-auth","--audience","example"]'`
- Header templates can use `${auth.token}`, `${auth.type}`, and `${auth.source}`.
- Settings are grouped into `Connection`, `Processing`, and `Device Sync` sections with shell-agnostic labels.
- Queue settings include `raw_events_sweeper_interval_s` (seconds), which controls background pending-event drain cadence.

Example command-token gateway config:

```json
{
  "observer_provider": "your-gateway-provider",
  "observer_base_url": "https://gateway.example/v1",
  "observer_runtime": "api_http",
  "observer_auth_source": "command",
  "observer_auth_command": ["iap-auth", "--audience", "example"],
  "observer_auth_timeout_ms": 1500,
  "observer_auth_cache_ttl_s": 300,
  "observer_headers": {
    "Authorization": "Bearer ${auth.token}",
    "X-Auth-Source": "${auth.source}"
  }
}
```

Header template variables:

- `${auth.token}`
- `${auth.type}`
- `${auth.source}`

Command/file token caching notes:

- Successful `file`/`command` token resolutions are cached for `observer_auth_cache_ttl_s`.
- Failed `file`/`command` resolutions are not cached (codemem clears stale cache and retries on the next call).

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

## Hybrid retrieval evaluation

- Evaluate baseline vs hybrid retrieval with judged queries:
  - `codemem hybrid-eval /path/to/judged.jsonl --limit 8`
- Use threshold gates for rollout decisions:
  - `codemem hybrid-eval /path/to/judged.jsonl --min-delta-precision 0.01 --min-delta-recall 0.01`
- Save machine-readable output:
  - `codemem hybrid-eval /path/to/judged.jsonl --json-out .tmp/hybrid-eval.json`

Judged query JSONL format:

```json
{"query":"sync diagnostics","relevant_ids":[123,456],"filters":{"project":"codemem"}}
{"query":"viewer autostart","relevant_ids":[789]}
```

- `relevant_ids` are memory item IDs expected in top-k.
- `filters` is optional and uses the same retrieval filter shape as normal search commands.
- Supported retrieval filters include `project`, `kind`, `include_actor_ids`, `exclude_actor_ids`, `include_workspace_ids`, `exclude_workspace_ids`, `include_workspace_kinds`, `exclude_workspace_kinds`, and `personal_first`.

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

## Retrieval scope
- New memories default to private visibility and stay local unless written as shared.
- The feed supports `All visible`, `Mine`, and `Shared` scopes without splitting memories into separate databases.
- Shared memories are the only ones eligible for peer-to-peer sync; project and per-peer sync filters still narrow where shared memories flow.
