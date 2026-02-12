# codemem

[![CI](https://github.com/kunickiaj/codemem/actions/workflows/ci.yml/badge.svg)](https://github.com/kunickiaj/codemem/actions/workflows/ci.yml) [![codecov](https://codecov.io/gh/kunickiaj/codemem/branch/main/graph/badge.svg)](https://codecov.io/gh/kunickiaj/codemem) [![Release](https://img.shields.io/github/v/release/kunickiaj/codemem)](https://github.com/kunickiaj/codemem/releases)

A lightweight persistent-memory companion for OpenCode. Captures terminal sessions (and tool calls) as memories, serves a viewer, and exposes an OpenCode plugin that records tool usage automatically.

## Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (recommended) or pip
- SSH access to this GitHub repository (for installation)

## Quick setup

### For Development (Recommended)

```bash
# Create virtual environment and install with dependencies
uv sync

# Run commands via the venv
.venv/bin/codemem --help

# Or activate the venv first
source .venv/bin/activate  # bash/zsh
source .venv/bin/activate.fish  # fish
codemem --help
```

### Via uvx (No Installation)

Run directly without installing — requires SSH access to the repo:

```bash
# Run latest
uvx --from git+ssh://git@github.com/kunickiaj/codemem.git codemem stats

# Run specific version
uvx --from git+ssh://git@github.com/kunickiaj/codemem.git@v0.9.17 codemem stats

# Run from local clone
uvx --from . codemem stats
```

### Install from GitHub

```bash
# Install latest
uv pip install git+ssh://git@github.com/kunickiaj/codemem.git

# Install specific version
uv pip install git+ssh://git@github.com/kunickiaj/codemem.git@v0.9.17
```

### Configuration

Optionally point the SQLite store somewhere else:

```bash
export CODEMEM_DB=~/.codemem/mem.sqlite
```

## CLI commands

- `codemem init-db` – initialize the database.
- `codemem stats` / `codemem recent` / `codemem search` – inspect stored memories.
- `codemem embed` – backfill semantic embeddings for existing memories.
- `codemem db prune-memories` – deactivate low-signal memories (use `--dry-run` to preview).
- `codemem serve` – launch the web viewer (the plugin also auto-starts it).
- `codemem export-memories` / `codemem import-memories` – export and import memories by project for sharing or backup.
- `codemem sync` – enable peer sync, pair devices, and run the sync daemon.

### Sync project filters

By default, sync replicates all projects. You can restrict which projects a device will apply by
project basename (folder name).

Config keys (in `~/.config/codemem/config.json`):

```json
{
  "sync_projects_include": ["codemem"],
  "sync_projects_exclude": ["work-repo"]
}
```

Notes:
- If `sync_projects_include` is non-empty, only those projects sync.
- `sync_projects_exclude` always wins.
- Filtering is reversible: excluded projects are skipped without advancing cursors, so toggling
  filters later will allow previously filtered ops to sync.

#### Per-peer overrides (recommended for coworker sync)

Global filters apply to all peers by default. When accepting a pairing payload, you can set a
per-peer override so one peer only syncs shared work projects while your other devices still sync
everything.

Example:

```bash
# Accept a peer and only sync specific projects with them
codemem sync pair --accept '<payload>' --include shared-repo-1,shared-repo-2

# Accept a peer and exclude a project
codemem sync pair --accept '<payload>' --exclude private-repo

# Clear per-peer override (inherit global defaults)
codemem sync pair --accept '<payload>' --default

# Force per-peer override to sync all projects with this peer
codemem sync pair --accept '<payload>' --all
```

## Semantic recall

Semantic recall stores vector embeddings for memory items using sqlite-vec and fastembed. Embeddings are written when memories are created; use `codemem embed` to backfill existing memories.

Notes:
- Requires a Python SQLite build that supports extension loading (sqlite-vec).
- If sqlite-vec cannot load, semantic recall is skipped and keyword search still works.

### sqlite-vec on aarch64 (Linux)

The PyPI wheels for sqlite-vec currently ship a 32-bit `vec0.so` on aarch64, which fails to load in 64-bit Python with `ELFCLASS32`. Use the aarch64 release build instead:

```bash
# Download the aarch64 loadable extension (0.1.7a2)
curl -L -o /tmp/sqlite-vec-0.1.7a2-linux-aarch64.tar.gz \
  https://github.com/asg017/sqlite-vec/releases/download/v0.1.7-alpha.2/sqlite-vec-0.1.7-alpha.2-loadable-linux-aarch64.tar.gz

# Extract and replace the bundled vec0.so inside the venv
tar -xzf /tmp/sqlite-vec-0.1.7a2-linux-aarch64.tar.gz -C /tmp
cp /tmp/vec0.so .venv/lib/python*/site-packages/sqlite_vec/vec0.so
```

This keeps sqlite-vec installed but swaps in a 64-bit aarch64 loadable, unblocking vector search and imports on Debian 13 arm64.

## Exporting and importing memories

Share your project knowledge with teammates or back up memories to transfer between machines.

### Export memories

```bash
# Export all memories for current project
codemem export-memories myproject.json

# Export a specific project
codemem export-memories myproject.json --project /path/to/myproject

# Export all projects
codemem export-memories all.json --all-projects

# Export including deactivated memories
codemem export-memories myproject.json --project myproject --include-inactive

# Export to stdout and compress
codemem export-memories - --project myproject | gzip > myproject.json.gz

# Export memories from a specific date
codemem export-memories recent.json --project myproject --since 2025-01-01
```

### Import memories

Imports are idempotent. You can safely re-run the same import file to pick up
new entries without duplicating existing data.

```bash
# Preview what will be imported (dry run)
codemem import-memories myproject.json --dry-run

# Import memories
codemem import-memories myproject.json

# Import with project remapping (teammate has different paths)
codemem import-memories myproject.json --remap-project /Users/teammate/workspace/myproject

# Import from compressed file
gunzip -c myproject.json.gz | codemem import-memories -
```

### Import from claude-mem

Use the claude-mem SQLite database directly (not the JSON export).
Imports are idempotent, so re-running is safe.

```bash
codemem import-from-claude-mem ~/.claude-mem/claude-mem.db
```

### Use case: sharing knowledge with teammates

When a teammate joins your project:

```bash
# You: export your project memories
codemem export-memories project-knowledge.json --project myproject

# Share the file (Slack, email, git, etc.)

# Teammate: import into their codemem
codemem import-memories project-knowledge.json --remap-project ~/workspace/myproject
```

Now their LLM has access to all your discoveries, patterns, and decisions about the codebase.

## Development

### Running Tests

```bash
# Run all tests
uv run pytest

# Run with coverage
uv run pytest --cov=codemem --cov-report=term

# Run specific test
uv run pytest tests/test_store.py::test_store_roundtrip
```

### Code Quality

```bash
# Lint check
uv run ruff check codemem tests

# Format check
uv run ruff format --check codemem tests

# Auto-fix and format
uv run ruff check --fix codemem tests
uv run ruff format codemem tests
```

### CI/CD

The project uses GitHub Actions for continuous integration and deployment:

- **CI Pipeline** (`.github/workflows/ci.yml`): Runs on every push/PR to `main`
  - Tests across Python 3.11-3.13
  - Linting with `ruff`
  - Code coverage reporting (via Codecov)

- **Release Pipeline** (`.github/workflows/release.yml`): Triggered by version tags (`v*`)
  - Builds distribution packages (wheel + sdist)
  - Creates GitHub Release with auto-generated changelog
  - Attaches packages to release for distribution
  - Optional PyPI publishing (commented out, enable when going public)

To create a release:
```bash
git tag v0.1.1
git push origin v0.1.1
```

## Configuration

Configuration is stored in `~/.config/codemem/config.json` (override with `CODEMEM_CONFIG`). Environment variables always take precedence.

### Sync quickstart (Phase 2)

```bash
# Enable sync (generates device keys)
codemem sync enable

# Start daemon (foreground)
codemem sync daemon
```

Pair on device A (CLI or viewer UI QR):

```bash
codemem sync pair
```

Copy the payload to device B:

```bash
codemem sync pair --accept '<payload>'
```

Status and one-off sync:

```bash
codemem sync status
codemem sync once
```

Autostart (macOS + Linux):

```bash
codemem sync install
```

Relevant config keys (override with env vars):

- `sync_enabled` / `CODEMEM_SYNC_ENABLED`
- `sync_host` / `CODEMEM_SYNC_HOST`
- `sync_port` / `CODEMEM_SYNC_PORT`
- `sync_interval_s` / `CODEMEM_SYNC_INTERVAL_S`
- `sync_mdns` / `CODEMEM_SYNC_MDNS`
- `sync_key_store` / `CODEMEM_SYNC_KEY_STORE` ("file" or "keychain")

Note: macOS keychain storage uses the `security` CLI and may expose the key via process arguments. Keep `sync_key_store=file` if that’s a concern.

The viewer includes a Settings modal for the observer provider, model, and max chars. Changes write to the config file; environment variables still override those values.

## Docs

- `docs/architecture.md` covers the data flow and components.
- `docs/user-guide.md` covers viewer usage and troubleshooting.

## OpenCode MCP setup

To let the LLM call memory tools (search/timeline/pack), run:

```bash
codemem install-mcp
```

This writes/updates your global OpenCode config at `~/.config/opencode/opencode.json`. The MCP entry looks like:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codemem": {
      "type": "local",
      "command": ["uvx", "codemem", "mcp"],
      "enabled": true
    }
  }
}
```

Restart OpenCode and the MCP tools will be available to the model.

## Plugin mode

### Installation

**Recommended (npm package):**

Add `@kunickiaj/codemem` to your OpenCode plugin config, then restart OpenCode.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@kunickiaj/codemem"]
}
```

Notes:
- The key is `plugin` (singular). `plugins` is rejected as an unknown key.
- To pin a specific plugin release, use `"@kunickiaj/codemem@0.9.20"`.

**Git fallback one-liner** (advanced):

```bash
uvx --from git+ssh://git@github.com/kunickiaj/codemem.git codemem install-plugin
```

That's it! Restart OpenCode and the plugin is active.

**For development** (working on codemem):

Just start OpenCode inside the repo directory — the plugin auto-loads from `.opencode/plugin/`.

### How it works

When OpenCode starts, the plugin loads and:

1. **Auto-detects mode**:
   - If in the `codemem` repo → uses `uv run` (dev mode, picks up changes)
   - Otherwise → uses `uvx --from git+ssh://...` (installed mode)

2. Tracks every tool invocation (`tool.execute.after`)
3. Flushes captured events when the session idles, errors, or compacts
4. Auto-starts the viewer by default (set `CODEMEM_VIEWER_AUTO=0` to disable)
5. Injects a memory pack into the system prompt (disable with `CODEMEM_INJECT_CONTEXT=0`)

### Environment hints for the plugin

| Env var | Description |
| --- | --- |
| `CODEMEM_RUNNER` | Override auto-detected runner: `uv` (dev mode), `uvx` (installed mode), or direct binary path. |
| `CODEMEM_RUNNER_FROM` | Override source location: directory path for `uv run --directory`, or git URL/path for `uvx --from`. |
| `CODEMEM_VIEWER` | Set to `0`, `false`, or `off` to disable the viewer entirely. |
| `CODEMEM_VIEWER_HOST`, `CODEMEM_VIEWER_PORT` | Customize the viewer host/port printed on startup. |
| `CODEMEM_VIEWER_AUTO` | Set to `0`/`false`/`off` to disable auto-start (default on). |
| `CODEMEM_VIEWER_AUTO_STOP` | Set to `0`/`false`/`off` to keep the viewer running after OpenCode exits (default on). |
| `CODEMEM_PLUGIN_LOG` | Path for the plugin log file (set `1`/`true`/`yes` to enable; defaults to off). |
| `CODEMEM_PLUGIN_CMD_TIMEOUT` | Milliseconds before a plugin CLI call is aborted (default `20000`). |
| `CODEMEM_CODEX_ENDPOINT` | Override Codex OAuth endpoint (default `https://chatgpt.com/backend-api/codex/responses`). |
| `CODEMEM_PLUGIN_DEBUG` | Set to `1`, `true`, or `yes` to log plugin lifecycle events via `client.app.log`. |
| `CODEMEM_PLUGIN_IGNORE` | Skip all plugin behavior for this process (used to avoid observer feedback loops). |
| `CODEMEM_INJECT_CONTEXT` | Set to `0` to disable memory pack injection (default on). |
| `CODEMEM_INJECT_LIMIT` | Max memory items in injected pack (default `8`). |
| `CODEMEM_INJECT_TOKEN_BUDGET` | Approx token budget for injected pack (default `800`). |
| `CODEMEM_USE_OPENCODE_RUN` | Use `opencode run` for observer generation (default off). |
| `CODEMEM_OPENCODE_MODEL` | Model for `opencode run` (default `gpt-5.1-codex-mini`). |
| `CODEMEM_OPENCODE_AGENT` | Agent for `opencode run` (optional). |
| `CODEMEM_OBSERVER_PROVIDER` | Force `openai`, `anthropic`, or a custom provider key (optional). |
| `CODEMEM_OBSERVER_MODEL` | Override observer model (default `gpt-5.1-codex-mini` or `claude-4.5-haiku`). |
| `CODEMEM_OBSERVER_API_KEY` | API key for observer model (optional). |
| `CODEMEM_OBSERVER_MAX_CHARS` | Max observer prompt characters (default `12000`). |
| `CODEMEM_RAW_EVENTS_AUTO_FLUSH` | Set to `1` to enable viewer-side debounced flushing of streamed raw events (default off). |
| `CODEMEM_RAW_EVENTS_DEBOUNCE_MS` | Debounce delay before auto-flush per session (default `60000`). |
| `CODEMEM_RAW_EVENTS_SWEEPER` | Set to `1` to enable periodic sweeper flush for idle sessions (default off). |
| `CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS` | Sweeper tick interval (default `30000`). |
| `CODEMEM_RAW_EVENTS_SWEEPER_IDLE_MS` | Consider session idle if no events since this many ms (default `120000`). |
| `CODEMEM_RAW_EVENTS_SWEEPER_LIMIT` | Max idle sessions to flush per sweeper tick (default `25`). |
| `CODEMEM_RAW_EVENTS_STUCK_BATCH_MS` | Mark flush batches older than this many ms as error (default `300000`). |
| `CODEMEM_RAW_EVENTS_RETENTION_MS` | If >0, delete raw events older than this many ms (default `0`, keep forever). |

### Plugin slash commands

- `/mem-status` – show viewer URL, log path, stats, and recent entries.
- `/mem-stats` – show just the stats block.
- `/mem-recent` – show recent items (defaults to 5).

## Observer model

The ingest pipeline uses an observer agent to emit XML observations and summaries. Summaries are generated on session end by default; use `<skip_summary/>` in observer output to skip. The defaults are:

- **OpenAI**: `gpt-5.1-codex-mini` (uses `CODEMEM_OBSERVER_API_KEY`, or `OPENCODE_API_KEY` / `OPENAI_API_KEY`; falls back to OpenCode OAuth cache at `~/.local/share/opencode/auth.json` and calls `https://chatgpt.com/backend-api/codex/responses` when API keys are absent).
- **Anthropic**: `claude-4.5-haiku` (set `CODEMEM_OBSERVER_PROVIDER=anthropic` and provide `CODEMEM_OBSERVER_API_KEY` or `ANTHROPIC_API_KEY`; falls back to OpenCode OAuth cache when API keys are absent).

Observer provider is selected from `CODEMEM_OBSERVER_PROVIDER` when set, otherwise inferred from the model (`claude*` → Anthropic, otherwise OpenAI). Override the model with `CODEMEM_OBSERVER_MODEL`, or use `CODEMEM_USE_OPENCODE_RUN=1` with `CODEMEM_OPENCODE_MODEL` as a fallback for OAuth-backed runs.

### Custom providers (OpenCode config)

Custom providers are loaded from `~/.config/opencode/opencode.json` (or JSONC). codemem reads the same config for provider names, base URLs, headers, and model mappings. The viewer settings modal populates provider options from this config.

To set a default model for a custom provider, add `defaultModel` under that provider. If omitted, codemem falls back to the first model listed under `models`.

When `CODEMEM_OBSERVER_PROVIDER` is set to a custom provider, `CODEMEM_OBSERVER_MODEL` can be the short model key (e.g. `claude-haiku`) or `provider/model`. If provider is left as auto, use the `provider/model` form so the custom provider can be inferred.

## Running OpenCode with the plugin

1. Start OpenCode inside this repo (or make the plugin global so it globs in everywhere).
2. Every tooling session now creates a memory entry and pushes typed artifacts into SQLite.
3. Use `codemem stats` / `recent` to see sessions and confirm the plugin ingested them.
4. Browse the viewer at the printed URL.

### Stream-only mode (advanced)

If you want maximum reliability ("stream now, flush later"), run stream-only and let Python decide when to flush.

Important: stream-only requires the viewer to be running and reachable. If the plugin cannot POST to the viewer, it will log an error and events may be dropped.

```bash
export CODEMEM_RAW_EVENTS_AUTO_FLUSH=1
export CODEMEM_RAW_EVENTS_DEBOUNCE_MS=60000
export CODEMEM_RAW_EVENTS_SWEEPER=1
export CODEMEM_RAW_EVENTS_SWEEPER_IDLE_MS=120000
export CODEMEM_RAW_EVENTS_SWEEPER_LIMIT=25
export CODEMEM_RAW_EVENTS_STUCK_BATCH_MS=300000
# optional retention
# export CODEMEM_RAW_EVENTS_RETENTION_MS=$((7*24*60*60*1000))
```

To monitor backlog:

```bash
codemem raw-events-status
```

### Troubleshooting

If `raw-events-status` shows `batches=error:N` for a session, retry those batches:

```bash
codemem raw-events-retry <opencode_session_id>
```
