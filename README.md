# opencode-mem

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
.venv/bin/opencode-mem --help

# Or activate the venv first
source .venv/bin/activate  # bash/zsh
source .venv/bin/activate.fish  # fish
opencode-mem --help
```

### Via uvx (No Installation)

Run directly without installing — requires SSH access to the repo:

```bash
# Run latest
uvx --from git+ssh://git@github.com/kunickiaj/opencode-mem.git opencode-mem stats

# Run specific version
uvx --from git+ssh://git@github.com/kunickiaj/opencode-mem.git@v0.1.0 opencode-mem stats

# Run from local clone
uvx --from . opencode-mem stats
```

### Install from GitHub

```bash
# Install latest
uv pip install git+ssh://git@github.com/kunickiaj/opencode-mem.git

# Install specific version
uv pip install git+ssh://git@github.com/kunickiaj/opencode-mem.git@v0.1.0
```

### Configuration

Optionally point the SQLite store somewhere else:

```bash
export OPENCODE_MEM_DB=~/opencode-mem.sqlite
```

## CLI commands

- `opencode-mem init-db` – initialize the database.
- `opencode-mem run -- <cmd>` – run any command while automatically capturing transcripts and artifacts.
- `opencode-mem stats` / `opencode-mem recent` / `opencode-mem search` – inspect stored memories.
- `opencode-mem purge` – deactivate low-signal observations (use `--dry-run` to preview).
- `opencode-mem serve` – launch the web viewer (the plugin also auto-starts it).
- `opencode-mem export-memories` / `opencode-mem import-memories` – export and import memories by project for sharing or backup.

## Exporting and importing memories

Share your project knowledge with teammates or back up memories to transfer between machines.

### Export memories

```bash
# Export all memories for current project
opencode-mem export-memories myproject.json

# Export a specific project
opencode-mem export-memories myproject.json --project /path/to/myproject

# Export all projects
opencode-mem export-memories all.json --all-projects

# Export including deactivated memories
opencode-mem export-memories myproject.json --project myproject --include-inactive

# Export to stdout and compress
opencode-mem export-memories - --project myproject | gzip > myproject.json.gz

# Export memories from a specific date
opencode-mem export-memories recent.json --project myproject --since 2025-01-01
```

### Import memories

```bash
# Preview what will be imported (dry run)
opencode-mem import-memories myproject.json --dry-run

# Import memories
opencode-mem import-memories myproject.json

# Import with project remapping (teammate has different paths)
opencode-mem import-memories myproject.json --remap-project /Users/teammate/workspace/myproject

# Import from compressed file
gunzip -c myproject.json.gz | opencode-mem import-memories -
```

### Use case: sharing knowledge with teammates

When a teammate joins your project:

```bash
# You: export your project memories
opencode-mem export-memories project-knowledge.json --project myproject

# Share the file (Slack, email, git, etc.)

# Teammate: import into their opencode-mem
opencode-mem import-memories project-knowledge.json --remap-project ~/workspace/myproject
```

Now their LLM has access to all your discoveries, patterns, and decisions about the codebase.

## Development

### Running Tests

```bash
# Run all tests
uv run pytest

# Run with coverage
uv run pytest --cov=opencode_mem --cov-report=term

# Run specific test
uv run pytest tests/test_store.py::test_store_roundtrip
```

### Code Quality

```bash
# Lint check
uv run ruff check opencode_mem tests

# Format check
uv run ruff format --check opencode_mem tests

# Auto-fix and format
uv run ruff check --fix opencode_mem tests
uv run ruff format opencode_mem tests
```

### CI/CD

The project uses GitHub Actions for continuous integration and deployment:

- **CI Pipeline** (`.github/workflows/ci.yml`): Runs on every push/PR to `main`
  - Tests across Python 3.11-3.14
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

Configuration is stored in `~/.config/opencode-mem/config.json` (override with `OPENCODE_MEM_CONFIG`). Environment variables always take precedence.

The viewer includes a Settings modal for the observer provider, model, and max chars. Changes write to the config file; environment variables still override those values.

## Docs

- `docs/architecture.md` covers the data flow and components.
- `docs/user-guide.md` covers viewer usage and troubleshooting.

## OpenCode MCP setup

To let the LLM call memory tools (search/timeline/pack), add this to your global OpenCode config at `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "opencode_mem": {
      "type": "local",
      "command": ["uvx", "opencode-mem", "mcp"],
      "enabled": true
    }
  }
}
```

Restart OpenCode and the MCP tools will be available to the model.

## Plugin mode

### Installation

**One-liner install** (requires SSH access to the repo):

```bash
uvx --from git+ssh://git@github.com/kunickiaj/opencode-mem.git opencode-mem install-plugin
```

That's it! Restart OpenCode and the plugin is active.

**For development** (working on opencode-mem):

Just start OpenCode inside the repo directory — the plugin auto-loads from `.opencode/plugin/`.

### How it works

When OpenCode starts, the plugin loads and:

1. **Auto-detects mode**:
   - If in the `opencode-mem` repo → uses `uv run` (dev mode, picks up changes)
   - Otherwise → uses `uvx --from git+ssh://...` (installed mode)

2. Tracks every tool invocation (`tool.execute.after`)
3. Flushes captured events when the session idles, errors, or compacts
4. Auto-starts the viewer by default (set `OPENCODE_MEM_VIEWER_AUTO=0` to disable)
5. Injects a memory pack into the system prompt (disable with `OPENCODE_MEM_INJECT_CONTEXT=0`)

### Environment hints for the plugin

| Env var | Description |
| --- | --- |
| `OPENCODE_MEM_RUNNER` | Override auto-detected runner: `uv` (dev mode), `uvx` (installed mode), or direct binary path. |
| `OPENCODE_MEM_RUNNER_FROM` | Override source location: directory path for `uv run --directory`, or git URL/path for `uvx --from`. |
| `OPENCODE_MEM_VIEWER` | Set to `0`, `false`, or `off` to disable the viewer entirely. |
| `OPENCODE_MEM_VIEWER_HOST`, `OPENCODE_MEM_VIEWER_PORT` | Customize the viewer host/port printed on startup. |
| `OPENCODE_MEM_VIEWER_AUTO` | Set to `0`/`false`/`off` to disable auto-start (default on). |
| `OPENCODE_MEM_VIEWER_AUTO_STOP` | Set to `0`/`false`/`off` to keep the viewer running after OpenCode exits (default on). |
| `OPENCODE_MEM_PLUGIN_LOG` | Path for the plugin log file (defaults to `~/.opencode-mem/plugin.log`, set `0` to disable). |
| `OPENCODE_MEM_PLUGIN_CMD_TIMEOUT` | Milliseconds before a plugin CLI call is aborted (default `20000`). |
| `OPENCODE_MEM_PLUGIN_DEBUG` | Set to `1`, `true`, or `yes` to log plugin lifecycle events via `client.app.log`. |
| `OPENCODE_MEM_PLUGIN_IGNORE` | Skip all plugin behavior for this process (used to avoid observer feedback loops). |
| `OPENCODE_MEM_INJECT_CONTEXT` | Set to `0` to disable memory pack injection (default on). |
| `OPENCODE_MEM_INJECT_LIMIT` | Max memory items in injected pack (default `8`). |
| `OPENCODE_MEM_INJECT_TOKEN_BUDGET` | Approx token budget for injected pack (default `800`). |
| `OPENCODE_MEM_USE_OPENCODE_RUN` | Use `opencode run` for observer generation (default off). |
| `OPENCODE_MEM_OPENCODE_MODEL` | Model for `opencode run` (default `gpt-5.1-codex-mini`). |
| `OPENCODE_MEM_OPENCODE_AGENT` | Agent for `opencode run` (optional). |
| `OPENCODE_MEM_OBSERVER_PROVIDER` | Force `openai` or `anthropic` (optional). |
| `OPENCODE_MEM_OBSERVER_MODEL` | Override observer model (default `gpt-5.1-codex-mini` or `claude-4.5-haiku`). |
| `OPENCODE_MEM_OBSERVER_API_KEY` | API key for observer model (optional). |
| `OPENCODE_MEM_OBSERVER_MAX_CHARS` | Max observer prompt characters (default `12000`). |

### Plugin slash commands

- `/mem-status` – show viewer URL, log path, stats, and recent entries.
- `/mem-stats` – show just the stats block.
- `/mem-recent` – show recent items (defaults to 5).

## Observer model

The ingest pipeline uses an observer agent to emit XML observations and summaries. Summaries are generated on session end by default; use `<skip_summary/>` in observer output to skip. The defaults are:

- **OpenAI**: `gpt-5.1-codex-mini` (uses `OPENCODE_MEM_OBSERVER_API_KEY`, or `OPENCODE_API_KEY` / `OPENAI_API_KEY`; falls back to OpenCode OAuth cache at `~/.local/share/opencode/auth.json` and calls `https://chatgpt.com/backend-api/codex/responses` when API keys are absent).
- **Anthropic**: `claude-4.5-haiku` (set `OPENCODE_MEM_OBSERVER_PROVIDER=anthropic` and provide `OPENCODE_MEM_OBSERVER_API_KEY` or `ANTHROPIC_API_KEY`; falls back to OpenCode OAuth cache when API keys are absent).

Observer provider is selected from `OPENCODE_MEM_OBSERVER_PROVIDER` when set, otherwise inferred from the model (`claude*` → Anthropic, otherwise OpenAI). Override the model with `OPENCODE_MEM_OBSERVER_MODEL`, or use `OPENCODE_MEM_USE_OPENCODE_RUN=1` with `OPENCODE_MEM_OPENCODE_MODEL` as a fallback for OAuth-backed runs.

## Running OpenCode with the plugin

1. Start OpenCode inside this repo (or make the plugin global so it globs in everywhere).
2. Every tooling session now creates a memory entry and pushes typed artifacts into SQLite.
3. Use `opencode-mem stats` / `recent` to see sessions and confirm the plugin ingested them.
4. Browse the viewer at the printed URL.
