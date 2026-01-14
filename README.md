# opencode-mem

A lightweight persistent-memory companion for OpenCode. Captures terminal sessions (and tool calls) as memories, serves a viewer, and exposes an OpenCode plugin that records tool usage automatically.

## Quick setup

```bash
uv pip install -e .
# or
pip install -e .
```

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

## Configuration

Configuration is stored in `~/.config/opencode-mem/config.json` (override with `OPENCODE_MEM_CONFIG`). Environment variables always take precedence.

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

When OpenCode starts inside this repo (or when the plugin is copied into `~/.config/opencode/plugin/`), `.opencode/plugin/opencode-mem.js` loads automatically. It:

1. Tracks every tool invocation (`tool.execute.after`).
2. Flushes captured events when the session idles, errors, or compacts (`session.compacting`, `session.compacted`, and `experimental.session.compacting`).
3. Auto-starts the viewer by default (set `OPENCODE_MEM_VIEWER_AUTO=0` to disable).
4. Posts payloads into `uvx opencode-mem ingest` by default.

### Environment hints for the plugin

| Env var | Description |
| --- | --- |
| `OPENCODE_MEM_RUNNER` | Override the runner used by the plugin (defaults to `uvx`). |
| `OPENCODE_MEM_RUNNER_FROM` | Path used with `uvx --from` (defaults to repo root). |
| `OPENCODE_MEM_VIEWER` | Set to `0`, `false`, or `off` to disable the viewer entirely. |
| `OPENCODE_MEM_VIEWER_HOST`, `OPENCODE_MEM_VIEWER_PORT` | Customize the viewer host/port printed on startup. |
| `OPENCODE_MEM_VIEWER_AUTO` | Set to `0`/`false`/`off` to disable auto-start (default on). |
| `OPENCODE_MEM_VIEWER_AUTO_STOP` | Set to `0`/`false`/`off` to keep the viewer running after OpenCode exits (default on). |
| `OPENCODE_MEM_PLUGIN_LOG` | Path for the plugin log file (defaults to `~/.opencode-mem/plugin.log`, set `0` to disable). |
| `OPENCODE_MEM_PLUGIN_CMD_TIMEOUT` | Milliseconds before a plugin CLI call is aborted (default `1500`). |
| `OPENCODE_MEM_PLUGIN_DEBUG` | Set to `1`, `true`, or `yes` to log plugin lifecycle events via `client.app.log`. |
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

- **OpenAI**: `gpt-5.1-codex-mini` (uses `OPENCODE_MEM_OBSERVER_API_KEY`, or `OPENCODE_API_KEY` / `OPENAI_API_KEY`).
- **Anthropic**: `claude-4.5-haiku` (set `OPENCODE_MEM_OBSERVER_PROVIDER=anthropic` and provide `OPENCODE_MEM_OBSERVER_API_KEY` or `ANTHROPIC_API_KEY`).

Override the model with `OPENCODE_MEM_OBSERVER_MODEL` or use `OPENCODE_MEM_USE_OPENCODE_RUN=1` with `OPENCODE_MEM_OPENCODE_MODEL` for OAuth-backed runs.

## Running OpenCode with the plugin

1. Start OpenCode inside this repo (or make the plugin global so it globs in everywhere).
2. Every tooling session now creates a memory entry and pushes typed artifacts into SQLite.
3. Use `opencode-mem stats` / `recent` to see sessions and confirm the plugin ingested them.
4. Browse the viewer at the printed URL.
