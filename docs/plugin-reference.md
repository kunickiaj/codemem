# Plugin Reference

This page covers advanced plugin behavior, environment variables, and stream reliability controls.

## Observer and settings UI

<img src="images/codemem-settings.png" alt="codemem observer settings" width="520" />

## Running OpenCode with the plugin

1. Start OpenCode inside this repo (or make the plugin global so it globs in everywhere).
2. Every tooling session creates memory artifacts in SQLite.
3. Use `codemem stats` and `codemem recent` to confirm ingestion.
4. Browse the viewer at the printed URL.

## Plugin tools exposed to the model

- `mem-status` - show viewer URL, log path, stats, and recent entries.
- `mem-stats` - show just the stats block.
- `mem-recent` - show recent items (defaults to 5).

These are plugin tools callable by the agent/runtime. They are not user-facing
slash commands in the OpenCode chat input.

## Observer model defaults

- OpenAI: `gpt-5.1-codex-mini`
- Anthropic: `claude-4.5-haiku`

Provider/model selection can be overridden with `CODEMEM_OBSERVER_PROVIDER` and
`CODEMEM_OBSERVER_MODEL`. Custom providers are loaded from OpenCode config.

## Stream-only mode (advanced)

Stream contract:
- Preflight availability: `GET /api/raw-events/status`
- Event streaming: `POST /api/raw-events`
- Non-2xx and network failures are treated as stream failures.
- There is no plugin-side CLI fallback path.
- Raw-event batches accepted by the viewer are retried by Python flush workers.

Suggested settings:

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

If `raw-events-status` shows `batches=error:N` (legacy label) or `queue=... failed:N` for a session, retry:

```bash
codemem raw-events-retry <opencode_session_id>
```

## Hook lifecycle and flush boundaries

The plugin uses OpenCode event hooks and flushes on explicit lifecycle boundaries:

- `tool.execute.after`: queue tool event; contributes to force-flush thresholds.
- `session.idle`: immediate flush attempt.
- `session.created`: flush previous session buffer before switching context.
- `/new` prompt boundary: flush before session reset.
- `session.error`: immediate flush attempt.

Force-flush thresholds (immediate flush):
- `>=50` tool events, or
- `>=15` prompts, or
- `>=10` minutes session duration.

Failure semantics:
- Stream POST failures are backoff-gated in plugin runtime (`CODEMEM_RAW_EVENTS_BACKOFF_MS`).
- Availability checks are rate-limited (`CODEMEM_RAW_EVENTS_STATUS_CHECK_MS`).
- Accepted raw-event batches are retried by viewer/store queue workers (`codemem raw-events-retry`).

## Environment hints

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
| `CODEMEM_MIN_VERSION` | Minimum required CLI version for plugin compatibility warnings (default `0.9.20`). |
| `CODEMEM_CODEX_ENDPOINT` | Override Codex OAuth endpoint. |
| `CODEMEM_PLUGIN_DEBUG` | Set to `1`, `true`, or `yes` to log plugin lifecycle events. |
| `CODEMEM_PLUGIN_IGNORE` | Skip all plugin behavior for this process. |
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
| `CODEMEM_RAW_EVENTS_BACKOFF_MS` | Backoff window after stream failure before retrying stream POSTs (default `10000`). |
| `CODEMEM_RAW_EVENTS_STATUS_CHECK_MS` | Minimum interval between stream availability preflight checks (default `30000`). |
| `CODEMEM_RAW_EVENTS_AUTO_FLUSH` | Set to `1` to enable viewer-side debounced flush of streamed raw events (default off). |
| `CODEMEM_RAW_EVENTS_DEBOUNCE_MS` | Debounce delay before auto-flush per session (default `60000`). |
| `CODEMEM_RAW_EVENTS_SWEEPER` | Set to `1` to enable periodic sweeper flush for idle sessions (default off). |
| `CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS` | Sweeper tick interval (default `30000`). |
| `CODEMEM_RAW_EVENTS_SWEEPER_IDLE_MS` | Consider session idle if no events since this many ms (default `120000`). |
| `CODEMEM_RAW_EVENTS_SWEEPER_LIMIT` | Max idle sessions to flush per sweeper tick (default `25`). |
| `CODEMEM_RAW_EVENTS_STUCK_BATCH_MS` | Mark flush batches older than this many ms as error (default `300000`). |
| `CODEMEM_RAW_EVENTS_RETENTION_MS` | If >0, delete raw events older than this many ms (default `0`, keep forever). |

## Compatibility guidance behavior

When the plugin detects CLI/runtime version mismatch, it shows guidance based on runner mode:

- `CODEMEM_RUNNER=uv`: pull latest in your repo, run `uv sync`, restart OpenCode
- `CODEMEM_RUNNER=uvx` with git source: update `CODEMEM_RUNNER_FROM` to newer ref/source, restart OpenCode
- `CODEMEM_RUNNER=uvx` with custom source: update `CODEMEM_RUNNER_FROM`, restart OpenCode
- other/unknown runner: run `uv tool install --upgrade codemem`, restart OpenCode

Compatibility checks are warning-only and do not block plugin startup.
