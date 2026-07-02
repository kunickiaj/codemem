# Plugin Reference

This page covers advanced plugin behavior, environment variables, and stream reliability controls.

## Observer and settings UI

<img src="images/codemem-settings.png" alt="codemem observer settings" width="520" />

## Running OpenCode with the plugin

1. Start OpenCode inside this repo (or make the plugin global so it globs in everywhere).
2. Every tooling session creates memory artifacts in SQLite.
3. Use `codemem stats` and `codemem recent` to confirm ingestion.
4. Browse the viewer at the printed URL.

## Claude marketplace install

CodeMem's Claude integration is hook-first and distributed through a Claude plugin marketplace source in this repo (`.claude-plugin/marketplace.json`).

In Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add kunickiaj/codemem
/plugin install codemem
```

The plugin starts MCP with the TS CLI:

- `codemem mcp`

Claude hook ingestion is HTTP enqueue-first (`POST /api/claude-hooks` to the local codemem server) with a CLI direct-enqueue fallback when the server path is unavailable:

- `codemem claude-hook-ingest`

Contract note: fallback is direct local DB enqueue from the TS CLI. There is currently no file spool/lock durability path in the fallback contract.

You can update an existing marketplace install with:

```text
/plugin marketplace update codemem-marketplace
```

Ingest one Claude hook payload from stdin (this is what the installed hook script calls):

```bash
printf '%s\n' '{"hook_event_name":"SessionStart","session_id":"sess-1","cwd":"/tmp/demo"}' | codemem claude-hook-ingest
```

`inject-context-hook.sh` is also a thin wrapper and delegates prompt-time context output to
codemem's local pack-generation path, with optional HTTP `/api/pack` fallback.

By default, `SessionEnd` triggers a boundary flush after enqueue to preserve progress without waiting for sweeper timing. Set `CODEMEM_CLAUDE_HOOK_FLUSH=0` to force enqueue-only behavior, and set `CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP=1` to include `Stop` boundary flush.

The packaged template currently registers these hook events in `plugins/claude/hooks/hooks.json`:
- `SessionStart`
- `UserPromptSubmit`
- `PostToolUse`
- `PostToolUseFailure`
- `Stop`
- `SessionEnd`

`UserPromptSubmit` runs `scripts/user-prompt-hook.sh`, which:
- sends the hook payload into capture ingest (`ingest-hook.sh`) in the background, and
- returns `hookSpecificOutput.additionalContext` from local CLI/store pack generation for prompt-time memory injection.

Prompt-time Claude injection uses local pack generation first and falls back to `/api/pack` only when local generation fails and `CODEMEM_INJECT_HTTP_FALLBACK` is enabled.

For Claude hooks, project resolution precedence is:

1. `CODEMEM_PROJECT` (if set)
2. repo/cwd-derived project name (`resolve_project(cwd)`)
3. payload `project` fallback (only when cwd is unavailable)

`PreToolUse` is intentionally deferred in the default template. Current memory extraction uses `PostToolUse` / `PostToolUseFailure` (`tool_result`) as the shipped Claude tool signal.

## Codex integration (early beta)

Codex support is early beta — functional and dogfooded end-to-end, but not yet promoted to a stable support tier. The Codex plugin uses the same shared raw-event pipeline as Claude and OpenCode. It is packaged under `plugins/codex/` with `.codex-plugin/plugin.json`, bundled `.mcp.json`, and hook scripts under `plugins/codex/scripts/`.

Codex hook ingestion is HTTP enqueue-first (`POST /api/codex-hooks`) with a CLI fallback chain:

- `codemem codex-hook-ingest` — direct local DB enqueue when the viewer API is unavailable.
- When both HTTP and direct enqueue fail, the payload is written to a Codex-specific on-disk spool (`~/.codemem/codex-hook-spool`) and drained on a later invocation.

```bash
printf '%s\n' '{"hook_event_name":"SessionStart","session_id":"codex-1","cwd":"/tmp/demo"}' | codemem codex-hook-ingest
```

`UserPromptSubmit` runs `scripts/user-prompt-hook.mjs`, which:
- sends the hook payload into capture ingest (`ingest-hook.mjs`) in the background, and
- returns `hookSpecificOutput.additionalContext` from `codemem codex-hook-inject` for prompt-time memory injection.

Prompt-time Codex injection uses local pack generation first and falls back to `/api/pack` when local generation fails or returns no pack and `CODEMEM_INJECT_HTTP_FALLBACK` is enabled. The injected pack is framed as codemem reference data, not instructions, before it is returned as Codex `additionalContext`. It honors the same injection controls as Claude: `CODEMEM_INJECT_CONTEXT`, `CODEMEM_INJECT_LIMIT`, `CODEMEM_INJECT_TOKEN_BUDGET`, `CODEMEM_INJECT_MAX_CHARS`, and `CODEMEM_INJECT_HTTP_MAX_TIME_S`. Hook failures always emit `{"continue": true}` so Codex sessions are never blocked.

```bash
printf '%s\n' '{"hook_event_name":"UserPromptSubmit","session_id":"codex-1","prompt":"what did we change","cwd":"/tmp/demo"}' | codemem codex-hook-inject
```

For Codex hooks, project resolution precedence matches the Claude hook path:

1. `CODEMEM_PROJECT` (if set)
2. repo/cwd-derived project name
3. payload `project` fallback (only when cwd is unavailable)

`Stop` events map the inline `last_assistant_message` when present, and fall back to the last assistant message in `transcript_path` so final responses are captured even when the inline field is omitted.

The packaged Codex template registers `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop` in `plugins/codex/hooks/hooks.json`. Codex support is early beta; see `docs/plans/2026-05-28-codex-first-class-integration.md` for the rollout plan and validation gates.

### Install, update, and uninstall

Install through Codex's own plugin marketplace — there is no `codemem setup` step:

```bash
codex plugin marketplace add https://github.com/kunickiaj/codemem.git
codex plugin add codemem@codemem
# refresh the marketplace snapshot later:
codex plugin marketplace upgrade
# remove:
codex plugin remove codemem@codemem
```

The plugin bundles `.mcp.json` (`npx -y codemem mcp`) and `hooks/hooks.json`. Hook scripts call `codemem` from `PATH` and fall back to `npx -y codemem@<plugin version>`, so a global CLI is optional but reduces hook latency. Validated targets: Codex CLI 0.135+ and current Desktop builds.

### Plugin-free install (`codemem setup --codex-only`)

API-key / non-subscription Codex Desktop greys out plugin installation. For that case, configure Codex directly — no marketplace, no plugin:

```bash
npx -y codemem setup --codex-only   # or, with a global install: codemem setup --codex-only
```

What it does (idempotent; honors `CODEX_HOME`; backs up existing files; `--force` to refresh):

- **MCP:** appends `[mcp_servers.codemem]` (`command = "npx"`, `args = ["-y", "codemem", "mcp"]`) to `<CODEX_HOME>/config.toml` if not already present. The file is never reparsed or reformatted — only appended — so comments and unrelated servers (including secrets) are preserved.
- **Hooks:** merges `SessionStart`, `UserPromptSubmit` (ingest + inject), `PostToolUse`, and `Stop` into `<CODEX_HOME>/hooks.json`, preserving any unrelated user hooks. Hook commands resolve to a direct `codemem codex-hook-*` call when `codemem` is on `PATH`, otherwise `npx -y codemem codex-hook-*`.

Hooks loaded from the user config layer require a one-time trust approval in Codex (you'll be prompted on first run; MCP recall needs no trust). Codex setup also runs automatically in a plain `codemem setup` when a Codex home (`~/.codex` or `$CODEX_HOME`) is detected.

### Troubleshooting

- **No memories and no raw events captured.** Confirm the `codemem` the hooks resolve actually has the Codex commands: `codemem codex-hook-ingest </dev/null` should print a structured `{"error":"read_error",...}`, not `unknown command`. The Codex commands are first published in codemem 0.35.0; the `0.34.0` release on npm predates them, so an older global install (or the `npx -y codemem@<plugin version>` fallback while the plugin manifest still pins a pre-0.35 version) silently fails and spools. Inspect the backlog at `~/.codemem/codex-hook-spool/` and the plugin log at `~/.codemem/plugin.log`.
- **`database locked` in the plugin log / payloads spooling.** The direct-DB fallback lost the writer lock (the viewer or maintenance worker held it). Keep the viewer running and current — it owns the single writer and serves `POST /api/codex-hooks`, so HTTP enqueue avoids cross-process lock contention.
- **`POST /api/codex-hooks` returns 404.** The running viewer predates Codex support; restart or upgrade it to a build that serves the route.
- **Spool backlog drains automatically** on the next successful ingest; force it by piping any spooled payload back through `codemem codex-hook-ingest` while the viewer is up.
- **A model rejects injected context** (for example "the conversation must end with a user message"): disable prompt-time injection with `CODEMEM_INJECT_CONTEXT=0`. Capture/ingest keeps working and recall is still available through the MCP tools.

## Post-restart config sanity checklist

After restarting OpenCode or the viewer, run this quick check when behavior looks off:

1. Confirm plugin + viewer are talking to the same DB path.
2. Check backend stats and recent writes (`codemem stats`, `codemem recent`).
3. Verify runner mode and source (`CODEMEM_RUNNER`, `CODEMEM_RUNNER_FROM`) match your install strategy.
4. Confirm injection controls are what you expect (`CODEMEM_INJECT_CONTEXT`, `CODEMEM_INJECT_LIMIT`, `CODEMEM_INJECT_TOKEN_BUDGET`).
5. If stream mode is enabled, check backlog health (`codemem db raw-events-status`).

If needed, restart viewer + plugin flow:

```bash
codemem serve restart
```

If you override the viewer bind, keep the plugin and viewer aligned on the same target:

```bash
set -lx CODEMEM_VIEWER_HOST 127.0.0.1
set -lx CODEMEM_VIEWER_PORT 38892
```

The plugin now passes that explicit host/port through when it auto-starts, health-checks, stops, or restarts the viewer. Do not run multiple viewers against the same DB/runtime folder unless they intentionally share the same bind target; otherwise `viewer.pid` ownership becomes ambiguous.

If compatibility toasts appear after restart, follow the runner-specific guidance in Compatibility guidance behavior below.

## Plugin tools exposed to the model

- `mem-status` - show viewer URL, log path, stats, and recent entries.
- `mem-stats` - show just the stats block.
- `mem-recent` - show recent items (defaults to 5).

These are plugin tools callable by the agent/runtime. They are not user-facing
slash commands in the OpenCode chat input.

## MCP tools exposed to agents

The MCP server exposes memory retrieval and write tools such as `memory_search`,
`memory_pack`, `memory_recent`, `memory_remember`, and `memory_forget`.

`memory_distill_candidates` mines recurring lessons into reviewable context
candidates. It is read-only and does not modify documentation files. By
default an observer-model worthiness pass drops routine-activity clusters
(release/CI status, review passes with no findings, context lookups) before
the candidates are returned; pass `judge: false` to skip it. When no observer
model is configured the tool returns unjudged output with `judged: false` and
a `judge_error` in the metadata.

Example agent requests:

- "Find recurring project lessons worth adding to AGENTS.md."
- "Run distill for all projects and show top candidates."
- "Distill without judging so I can see the raw recurrence ranking."

## Observer model defaults

- OpenAI: `gpt-5.1-codex-mini`
- Anthropic: `claude-4.5-haiku` (mapped to Anthropic direct API alias `claude-haiku-4-5` when using `api_http`)

Provider/model selection can be overridden with `CODEMEM_OBSERVER_PROVIDER` and
`CODEMEM_OBSERVER_MODEL`. Custom providers are loaded from OpenCode config.

### Observer auth modes

Observer execution supports API, Claude, and Codex runtime paths.

- Runtime values: `api_http`, `claude_sidecar`, `codex_sidecar`.
- `claude_sidecar` runs observer calls via local Claude runtime auth (no `ANTHROPIC_API_KEY` required).
- `claude_sidecar` uses `claude_command` (or `CODEMEM_CLAUDE_COMMAND`) as argv prefix for launching Claude CLI. Default: `["claude"]`.
- `codex_sidecar` runs observer calls via the local `codex` CLI (`codex exec`), so Codex / ChatGPT Pro users get memory extraction with **no API key** — auth is delegated to the Codex CLI (`~/.codex`). It uses `codex_command` (or `CODEMEM_CODEX_COMMAND`) as the argv prefix. Default: `["codex"]`. The spawned process runs with `--ephemeral --ignore-user-config -s read-only` and codemem's own hooks suppressed, so it never recurses into capture.
- codemem auto-selects `codex_sidecar` only when no `observer_runtime` is set, no API key is available from any provider, the OpenCode OAuth cache has no usable credentials, the `codex` CLI is resolvable, and `~/.codex/auth.json` exists. Otherwise set `observer_runtime = "codex_sidecar"` (or `CODEMEM_OBSERVER_RUNTIME=codex_sidecar`) explicitly.
- Default models:
- `api_http`: `gpt-5.1-codex-mini` unless `observer_model` is set.
- `claude_sidecar`: `claude-4.5-haiku` unless `observer_model` is set.
- `codex_sidecar`: `gpt-5.1-codex-mini` unless `observer_model` is set; the selected model is passed to `codex exec` via `-m` (tier routing).
- Anthropic direct API calls accept Anthropic model IDs/aliases; use `claude-haiku-4-5-20251001` if you need a pinned snapshot instead of the moving alias.
- If `observer_model` is unsupported in Claude CLI, codemem retries once without `--model`. The same fallback applies to `codex_sidecar`: an unavailable tier model is retried once without `-m`.
- Supported auth sources: `auto`, `env`, `file`, `command`, `none`.
- Supported: API keys and gateway tokens codemem can read directly.
- Custom provider path does not implicitly fall back to OpenCode/IAP env tokens; use provider key, `CODEMEM_OBSERVER_API_KEY`, `file`, or `command`.
- For codemem-native custom providers, set `observer_base_url` (or `CODEMEM_OBSERVER_BASE_URL`) to avoid relying on OpenCode provider config.

For command-refreshed gateway auth, configure a command token source plus templated headers:

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
    "Authorization": "Bearer ${auth.token}"
  }
}
```

`observer_auth_command` is direct argv execution (no shell interpolation).

- Config key type: JSON string array (`["cmd", "arg1", "arg2"]`).
- Env var `CODEMEM_OBSERVER_AUTH_COMMAND` must also be a JSON string array (for example `'["iap-auth","--audience","example"]'`), not a space-separated command string.

Header template variables:

- `${auth.token}`
- `${auth.type}`
- `${auth.source}`

Command/file token cache behavior:

- Successful token resolutions are cached for `observer_auth_cache_ttl_s`.
- Failed token resolutions are not cached.

## Stream-only mode (advanced)

Stream contract:
- Preflight availability: `GET /api/raw-events/status`
- Event streaming: `POST /api/raw-events`
- Non-2xx and network failures are treated as stream failures.
- Raw events are delivered through the viewer ingest API.
- Raw-event batches accepted by the viewer are retried by the sweeper flush workers.

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
codemem db raw-events-status
```

If `raw-events-status` shows `batches=error:N` (legacy label) or `queue=... failed:N` for a stream, retry:

```bash
codemem db raw-events-retry <session_stream_id>
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
- Accepted raw-event batches are retried by viewer/store queue workers (`codemem db raw-events-retry`).

## Project label normalization

When ingesting plugin payloads, CodeMem stores a normalized project label instead of a full path.

- Path-like labels are reduced to the basename (for example, `/Users/adam/workspace/codemem` -> `codemem`).
- Windows-style paths are normalized with Windows path rules on every OS runtime.
  - `C:\Users\adam\workspace\codemem` -> `codemem`
  - `D:/dev/client-demo` -> `client-demo`
  - `\\server\share\team\project-x` -> `project-x`
- `CODEMEM_PROJECT` still has highest precedence and is normalized the same way.

### Multi-adapter project unification

If you run multiple adapters for the same project (for example OpenCode + Claude), set a shared `CODEMEM_PROJECT` value in both runtimes to guarantee unified project grouping in memory retrieval.

## Environment hints

| Env var | Description |
| --- | --- |
| `CODEMEM_RUNNER` | Override auto-detected runner: `codemem` (global), `npx`, `node` (repo/dev), or custom binary name. |
| `CODEMEM_RUNNER_FROM` | Runner source override: npm package spec for `npx` (for example `codemem@0.20.0-alpha.7`), or repo/CLI entry path for `node`. |
| `CODEMEM_VIEWER` | Set to `0`, `false`, or `off` to disable the viewer entirely. |
| `CODEMEM_VIEWER_HOST`, `CODEMEM_VIEWER_PORT` | Explicit host/port the plugin-managed viewer should start, probe, stop, and restart. |
| `CODEMEM_VIEWER_AUTO` | Set to `0`/`false`/`off` to disable auto-start (default on). |
| `CODEMEM_VIEWER_AUTO_STOP` | Set to `0`/`false`/`off` to keep the viewer running after OpenCode exits (default on). |
| `CODEMEM_PLUGIN_LOG` | Path for the plugin log file (set `1`/`true`/`yes` for `~/.codemem/plugin.log`; Claude hook failures are logged to this path by default). |
| `CODEMEM_PLUGIN_LOG_PATH` | Explicit log file path for Claude hook script logging (overrides `CODEMEM_PLUGIN_LOG` for that script). |
| `CODEMEM_CLAUDE_HOOK_HTTP_CONNECT_TIMEOUT_S` | Claude hook HTTP enqueue connect timeout in seconds (default `1`). |
| `CODEMEM_CLAUDE_HOOK_HTTP_MAX_TIME_S` | Claude hook HTTP enqueue total timeout in seconds (default `2`). |
| `CODEMEM_CODEX_HOOK_HTTP_TIMEOUT_MS` | Codex hook HTTP enqueue timeout in milliseconds (default `1000`). |
| `CODEMEM_CODEX_HOOK_LOCK_DIR` | Codex hook fallback lock path (default `~/.codemem/codex-hook-ingest.lock`). |
| `CODEMEM_CODEX_HOOK_LOCK_TTL_S` | Seconds before a Codex hook fallback lock is treated as stale (default `120`). |
| `CODEMEM_CODEX_HOOK_SPOOL_DIR` | Codex hook fallback spool directory (default `~/.codemem/codex-hook-spool`). |
| `CODEMEM_INJECT_HTTP_CONNECT_TIMEOUT_S` | `UserPromptSubmit` pack injection connect timeout in seconds (default `1`). |
| `CODEMEM_INJECT_HTTP_MAX_TIME_S` | `UserPromptSubmit` pack injection total timeout in seconds (default `2`). |
| `CODEMEM_INJECT_HTTP_FALLBACK` | Set to `0` to disable HTTP `/api/pack` fallback for Claude/Codex prompt-time injection (default `1`). |
| `CODEMEM_INJECT_MAX_CHARS` | Max chars returned as Claude/Codex `additionalContext` (default `16000`). |
| `CODEMEM_PLUGIN_CMD_TIMEOUT` | Milliseconds before a plugin CLI call is aborted (default `20000`). |
| `CODEMEM_MIN_VERSION` | Minimum required CLI version for plugin compatibility warnings (default `0.9.20`). |
| `CODEMEM_BACKEND_UPDATE_POLICY` | Backend update behavior on compatibility mismatch: `notify` (default), `auto`, or `off`. |
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
| `CODEMEM_CLAUDE_COMMAND` | JSON argv array for Claude CLI invocation used by `claude_sidecar` (default `["claude"]`). |
| `CODEMEM_OBSERVER_RUNTIME` | Observer runtime mode (`api_http` or `claude_sidecar`). |
| `CODEMEM_OBSERVER_AUTH_SOURCE` | Observer auth source (`auto`, `env`, `file`, `command`, `none`). |
| `CODEMEM_OBSERVER_AUTH_FILE` | Path to token file used when auth source is `file`. |
| `CODEMEM_OBSERVER_AUTH_COMMAND` | Command argv as a JSON string array used when auth source is `command`. |
| `CODEMEM_OBSERVER_AUTH_TIMEOUT_MS` | Command auth timeout in milliseconds (default `1500`). |
| `CODEMEM_OBSERVER_AUTH_CACHE_TTL_S` | Cache TTL for command/file auth resolution in seconds (default `300`). |
| `CODEMEM_OBSERVER_HEADERS` | JSON object of templated observer headers, e.g. `{"Authorization":"Bearer ${auth.token}"}`. |
| `CODEMEM_OBSERVER_MAX_CHARS` | Max observer prompt characters (default `12000`). |
| `CODEMEM_RAW_EVENTS_BACKOFF_MS` | Backoff window after stream failure before retrying stream POSTs (default `10000`). |
| `CODEMEM_RAW_EVENTS_STATUS_CHECK_MS` | Minimum interval between stream availability preflight checks (default `30000`). |
| `CODEMEM_RAW_EVENTS_HARD_MAX` | Hard upper bound for in-memory plugin queue under sustained failure pressure (default `2000`). |
| `CODEMEM_RAW_EVENTS_AUTO_FLUSH` | Set to `1` to enable viewer-side debounced flush of streamed raw events (default off). |
| `CODEMEM_RAW_EVENTS_DEBOUNCE_MS` | Debounce delay before auto-flush per session (default `60000`). |
| `CODEMEM_RAW_EVENTS_SWEEPER` | Set to `1` to enable periodic sweeper flush for idle sessions (default on). |
| `CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS` | Sweeper tick interval (default `30000`). |
| `CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_S` | Config/env interval in seconds used by Settings UI (default `30`; overridden by `CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS` when set). |
| `CODEMEM_RAW_EVENTS_SWEEPER_IDLE_MS` | Consider session idle if no events since this many ms (default `120000`). |
| `CODEMEM_RAW_EVENTS_SWEEPER_LIMIT` | Max idle sessions to flush per sweeper tick (default `25`). |
| `CODEMEM_RAW_EVENTS_STUCK_BATCH_MS` | Mark flush batches older than this many ms as error (default `300000`). |
| `CODEMEM_RAW_EVENTS_RETENTION_MS` | If >0, delete raw events older than this many ms (default `0`, keep forever). |
| `CODEMEM_CLAUDE_HOOK_FLUSH` | Set to `0` to disable immediate `SessionEnd` boundary flush (default on for `SessionEnd`; `Stop` still requires `CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP=1`). |
| `CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP` | Set to `1` to flush on Claude `Stop` hooks in addition to `SessionEnd` (default off). |

## Compatibility guidance behavior

When the plugin detects CLI/runtime version mismatch, it shows guidance based on runner mode:

- `CODEMEM_RUNNER=codemem`: run `npm install -g codemem`, then restart OpenCode
- `CODEMEM_RUNNER=npx`: update `CODEMEM_RUNNER_FROM` to a newer package/version (or reinstall plugin), then restart OpenCode
- `CODEMEM_RUNNER=node`: pull latest repo changes and run `pnpm build`, then restart OpenCode
- custom/unknown runner: update the underlying `codemem` binary or package source, then restart OpenCode

Update policy:

- `CODEMEM_BACKEND_UPDATE_POLICY=notify` (default): show warning toast with suggested action
- `CODEMEM_BACKEND_UPDATE_POLICY=auto`: try a best-effort auto-update for eligible runners, then warn if still outdated
  - skipped for `node` dev-mode runners
  - skipped when `CODEMEM_RUNNER_FROM` is pinned to a fixed package/version
- `CODEMEM_BACKEND_UPDATE_POLICY=off`: no compatibility toast (logging still records mismatch)

Compatibility checks do not block plugin startup.
