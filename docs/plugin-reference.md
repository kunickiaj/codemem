# Plugin Reference

This page covers advanced plugin behavior, environment variables, and stream reliability controls.

## Observer and settings UI

<img src="images/codemem-settings.png" alt="codemem observer settings" width="520" />

## Running OpenCode with the plugin

1. Start OpenCode inside this repo (or make the plugin global so it globs in everywhere).
2. Every tooling session creates memory artifacts in SQLite.
3. Prompt-time memory injection appends volatile recall output to the latest user message by default, preserving the stable system/history prefix for provider prompt caches.
4. Use `codemem stats` and `codemem recent` to confirm ingestion.
5. Browse the viewer at the printed URL.

OpenCode prompt-time pack construction and prompt-pack ledger transitions use the
long-lived local viewer first. Retryable connection, timeout, endpoint-version,
server, or malformed-response failures fall back to the compatible CLI path.
Validated request errors are terminal only after a compatible profile handshake;
before compatibility is established, a structured request error may indicate a
foreign or older process and uses the CLI fallback. Policy and authorization errors
remain terminal. A `viewer_contract_unsupported` response is likewise terminal after
a compatible profile handshake and may fall back before one. The HTTP timeout uses
`CODEMEM_INJECT_HTTP_MAX_TIME_S` (default: 2 seconds).
Pack and ledger requests include their resolved default or explicit database,
identity/config, compression, and embedding targets. The viewer also rejects a cached store
identity that no longer matches current database/config resolution. A mismatch
uses the local CLI fallback exactly once instead of reading or retrying another
local profile. A payload-free profile handshake runs before each POST and returns
`protocol_version` plus `min_supported_protocol_version`; clients accept
overlapping ranges and interpret an older profile without the minimum as a
single-version range. Fetch redirects are disabled so prompt-derived request
bodies are not replayed to another endpoint.

### OpenCode prompt-path benchmark

A 30-run synthetic-fixture benchmark measured the **OpenCode plugin path only**; it does not measure
Claude or Codex latency. The privacy-safe report contains no prompt, memory content, IDs, or paths.

| Mode | Median / p95 | Prompt children |
| --- | --- | --- |
| Direct CLI | 857.459 / 1001.124 ms | — |
| Healthy Viewer | 9.478 / 10.772 ms | `pack=0`, `ledger=0`, `other=0`, `failed=0` |
| Classified Viewer-unavailable fallback | 832.101 / 881.455 ms | `pack=30`, `ledger=30`, `other=0`, `failed=0` |

## Claude marketplace install

CodeMem's Claude integration is hook-first and distributed through a Claude plugin marketplace source in this repo (`.claude-plugin/marketplace.json`).

In Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add kunickiaj/codemem
/plugin install codemem
```

The plugin starts MCP with the TS CLI:

- `codemem mcp`

Claude's Node/ESM wrapper normalizes each native hook once, then sends the exact normalized envelope to the local server's canonical `POST /api/raw-events` endpoint. Healthy HTTP ingestion starts no `codemem` or `npx` child. On a retryable failure, the wrapper sends the same serialized envelope to:

- `codemem enqueue-raw-event`
- `npx -y codemem@<plugin version> enqueue-raw-event`

The wrapper never remaps the native payload during fallback, so event identity is identical across HTTP and direct enqueue. Named `POST /api/claude-hooks` remains a compatibility alias/caller for older packaged and plugin-free CLI paths.

Transcript fallback scans backward through at most the final 16 MiB using a bounded reusable chunk buffer and stops at the latest qualifying assistant record. When that tail starts immediately after a newline, the first complete record is retained; when it starts in the middle of a record, the partial first record is discarded. JSONL records may use LF or CRLF, and UTF-8 characters remain valid across chunk boundaries.

Claude preserves its existing best-effort failure posture: if Viewer HTTP and both command fallbacks fail, the wrapper logs the failure and exits non-zero. It does not maintain a file spool; Codex's separately documented normalized-envelope spool is intentionally adapter-specific.

You can update an existing marketplace install with:

```text
/plugin marketplace update codemem-marketplace
```

Ingest one Claude hook payload through the installed wrapper:

```bash
printf '%s\n' '{"hook_event_name":"SessionStart","session_id":"sess-1"}' | node plugins/claude/scripts/ingest-hook.mjs
```

Prompt-time retrieval runs through the packaged dependency-free Node hook. It validates the
Viewer protocol, database, and runtime identity before sending identity-gated `POST /api/pack`.
Claude prompt retrieval and event ingestion accept only explicit loopback Viewer hosts
(`localhost`, `127.0.0.0/8`, or IPv6 loopback); non-loopback hosts are never fetched.

By default, `SessionEnd` requests a best-effort boundary flush after enqueue rather than waiting for sweeper timing. Set `CODEMEM_CLAUDE_HOOK_FLUSH=0` to force enqueue-only behavior, and set `CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP=1` to include `Stop` boundary flush. Direct Viewer transport keeps the boundary request, durable HTTP retry, and command fallbacks inside one Claude Code host budget (1.5 seconds by default, configurable with `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`), preserves command-fallback time after preprocessing and across both HTTP attempts, and reserves a 50 ms exit margin. The fallback reserve is normally 10% of the host budget, clamped between 500 ms and 5 seconds, but never exceeds half of the post-margin budget. `Stop` uses one 125-second internal budget under a 130-second packaged hook timeout, leaving startup and shutdown headroom. Override the boundary budget with `CODEMEM_CLAUDE_HOOK_BOUNDARY_TIMEOUT_MS`; `SessionEnd` still clamps its request to the live remaining host budget.

The packaged template currently registers these hook events in `plugins/claude/hooks/hooks.json`:
- `SessionStart`
- `UserPromptSubmit`
- `PostToolUse`
- `PostToolUseFailure`
- `Stop`
- `SessionEnd`

`UserPromptSubmit` runs `scripts/user-prompt-hook.mjs`, which:
- sends the hook payload into capture ingest (`ingest-hook.mjs`) in the background, and
- performs a payload-free compatible-profile check, retrieves an identity-gated Viewer pack, returns host-compatible `hookSpecificOutput.additionalContext`, then records delivery best-effort with a 500 ms cap.

Healthy prompt-time Claude injection starts no `codemem` or `npx` prompt child. Retryable
transport, version/profile, and local database/runtime identity mismatches start one compatibility chain:
`codemem claude-hook-inject`, then the plugin-version-pinned `npx` equivalent if needed. Valid
request failures after a compatible handshake, policy, authorization, and compatible-profile contract
failures do not fall back. Pre-handshake structured request failures use the compatibility chain. Non-loopback
Viewer hosts and redirects are rejected. Ledger failure never retries inline or changes already-written
hook output.

For Claude hooks, project resolution precedence is:

1. `CODEMEM_PROJECT` (if set)
2. repo/cwd-derived project name (`resolve_project(cwd)`)
3. payload `project` fallback (only when cwd is unavailable)

`PreToolUse` is intentionally deferred in the default template. Current memory extraction uses `PostToolUse` / `PostToolUseFailure` (`tool_result`) as the shipped Claude tool signal.

## Codex integration (early beta)

Codex support is early beta — functional and dogfooded end-to-end, but not yet promoted to a stable support tier. The Codex plugin uses the same shared raw-event pipeline as Claude and OpenCode. It is packaged under `plugins/codex/` with `.codex-plugin/plugin.json`, bundled `.mcp.json`, and hook scripts under `plugins/codex/scripts/`.

Codex's Node/ESM wrapper adds a timestamp and nonce when the host omitted a timestamp, normalizes exactly once, and sends the exact envelope to `POST /api/raw-events`. Healthy HTTP ingestion starts no `codemem` or `npx` child. After a retryable HTTP failure, it durably spools the normalized envelope before starting this fallback chain:

- `codemem enqueue-raw-event`, then the pinned `npx` equivalent.
- A successful fallback removes the envelope from `~/.codemem/codex-raw-event-spool`; if both fail, it remains there for a later HTTP drain. This is separate from the legacy native-hook spool.

The same serialized envelope—and therefore the same event ID—is used by every transport. Named `POST /api/codex-hooks` remains a compatibility alias/caller for older packaged and plugin-free CLI paths.

```bash
printf '%s\n' '{"hook_event_name":"SessionStart","session_id":"codex-1"}' | node plugins/codex/scripts/ingest-hook.mjs
```

`UserPromptSubmit` runs `scripts/user-prompt-hook.mjs`, which:
- sends the hook payload into capture ingest (`ingest-hook.mjs`) in the background, and
- performs a payload-free compatible-profile check, retrieves an identity-gated Viewer pack, and returns
  framed `hookSpecificOutput.additionalContext`; delivery recording is best-effort and capped at 500 ms.

The packaged Codex hook is a dependency-free direct Viewer client. Healthy prompt retrieval starts no
`codemem` or `npx` child. Retryable Viewer transport, version/profile, and local database/runtime
identity mismatches and pre-handshake structured request failures use one local compatibility chain;
validated request failures after compatibility is established, policy, authorization, and
compatible-profile contract failures fail closed. Prompt and event HTTP reject non-loopback Viewer hosts.
The injected pack is framed as codemem reference data, not instructions. The hook has a total 4.5-second
prompt-output budget within Codex's 5-second host timeout, and always emits `{"continue": true}` so a
hook failure does not block a session.

```bash
printf '%s\n' '{"hook_event_name":"UserPromptSubmit","session_id":"codex-1","prompt":"what did we change","cwd":"/tmp/demo"}' | codemem codex-hook-inject
```

`codemem codex-hook-inject` is retained for compatibility and plugin-free setup; it is not the packaged
hook's healthy prompt path.

For Codex hooks, project resolution precedence matches the Claude hook path:

1. `CODEMEM_PROJECT` (if set)
2. repo/cwd-derived project name
3. payload `project` fallback (only when cwd is unavailable)

`Stop` events map the inline `last_assistant_message` when present, and fall back to the last assistant message in `transcript_path` so final responses are captured even when the inline field is omitted. This fallback uses the same backward, bounded 16 MiB JSONL scan and record-boundary rules as Claude.

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

The plugin bundles `.mcp.json` (`npx -y codemem mcp`), `hooks/hooks.json`, and a dependency-free generated normalizer. Ingest wrappers use Viewer HTTP without child processes when healthy; `codemem` and pinned `npx` are fallback-only. Generated files come from the TypeScript normalizers in `packages/core/src/` via `node scripts/build-adapter-normalizers.mjs` and are protected by a byte-drift test. Validated targets: Codex CLI 0.135+ and current Desktop builds.

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

- **No memories and no raw events captured.** Confirm the `codemem` the hooks resolve actually has the Codex commands: `codemem codex-hook-ingest </dev/null` should print a structured `{"error":"read_error",...}`, not `unknown command`. The Codex commands are first published in codemem 0.35.0; the `0.34.0` release on npm predates them, so an older global install (or the `npx -y codemem@<plugin version>` fallback while the plugin manifest still pins a pre-0.35 version) silently fails and spools. Inspect normalized wrapper envelopes at `~/.codemem/codex-raw-event-spool/`, legacy native-hook payloads at `~/.codemem/codex-hook-spool/`, and the plugin log at `~/.codemem/plugin.log`.
- **`database locked` in the plugin log / payloads spooling.** The direct-queue fallback lost the writer lock (the viewer or maintenance worker held it). Keep the viewer running and current so canonical `POST /api/raw-events` avoids cross-process lock contention.
- **`POST /api/raw-events` returns 404.** The running viewer predates normalized edge ingress; restart or upgrade it. Older plugin packages may continue using the named compatibility route.
- **Normalized spool backlog drains automatically** at one envelope per successful ingest. The wrapper never reads or removes files from the legacy native-hook spool.
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

The plugin now passes that explicit host/port through when it auto-starts, health-checks, stops, or restarts the viewer. Its liveness monitor requires a successful `GET /api/health` JSON response identifying `service: "codemem-viewer"`; `ready: false` still means the viewer process is live. For compatibility, only a `404` from the health route triggers one bounded probe of the legacy raw-event status endpoint. Raw-event ingest availability keeps its separate preflight behavior, now bounded by a 5-second timeout so a hung viewer socket cannot stall event delivery. Do not run multiple viewers against the same DB/runtime folder unless they intentionally share the same bind target; otherwise `viewer.pid` ownership becomes ambiguous.

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
- If the direct CLI fallback reports an explicit SQLite busy/locked result or command timeout, the plugin retries it once with the same event ID. Other failures are reported and dropped rather than requeued or spooled, and logs retain only a bounded failure category rather than raw command output.

`GET /api/raw-events/status` also includes `transcript_diagnostics`, a per-Viewer-process, per-router-instance counter block scoped explicitly to `legacy_compatibility_routes`. It counts Claude and Codex compatibility-route transcript reads by the fixed outcomes `ok`, `not_provided`, `path_rejected`, `unreadable`, `no_complete_record`, and `no_assistant_record`. These counters are not persisted, do not include paths or transcript content, and do not describe the normal generated-adapter path through `POST /api/raw-events`. A skipped legacy `Stop` response keeps `skip_reason: "transcript_unavailable"` and may include one of the non-`ok` outcomes as `skip_detail`; other mapping skips remain `skip_reason: "unsupported_hook"`.

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
| `CODEMEM_CODEX_HOOK_SPOOL_DIR` | Legacy native Codex hook fallback spool directory (default `~/.codemem/codex-hook-spool`); the normalized wrapper does not read or drain it. |
| `CODEMEM_CODEX_RAW_EVENT_SPOOL_DIR` | Normalized Codex raw-event envelope spool directory (default `~/.codemem/codex-raw-event-spool`). |
| `CODEMEM_INJECT_HTTP_MAX_TIME_S` | Viewer request timeout for OpenCode and Claude prompt retrieval, and the per-request cap for Codex (default `2` seconds). Claude and Codex ledger completion has a separate fixed 500 ms cap; packaged Codex also enforces a total 4.5-second output budget. |
| `CODEMEM_INJECT_MAX_CHARS` | Max chars returned as Claude/Codex `additionalContext` (default `16000`). |
| `CODEMEM_PLUGIN_CMD_TIMEOUT` | Milliseconds before a plugin CLI call is aborted (default `20000`). |
| `CODEMEM_MIN_VERSION` | Minimum required CLI version for plugin compatibility warnings (default `0.9.20`). |
| `CODEMEM_BACKEND_UPDATE_POLICY` | Compatibility and release-notification policy: `notify` (default), `auto`, or `off`. |
| `CODEMEM_INSTALL_KIND` | Internal/advanced release-guidance detection override (`npm-global`, `npx`, `docker`, `repo-dev`, `pinned`, or `unknown`). This does not enable installation. |
| `CODEMEM_CODEX_ENDPOINT` | Override Codex OAuth endpoint. |
| `CODEMEM_PLUGIN_DEBUG` | Set to `1`, `true`, or `yes` to log plugin lifecycle events. |
| `CODEMEM_PLUGIN_IGNORE` | Skip all plugin behavior for this process. |
| `CODEMEM_INJECT_CONTEXT` | Set to `0` to disable memory pack injection (default on). |
| `CODEMEM_INJECT_SURFACE` | OpenCode injection surface: `message` by default; set `system` for the legacy system-prompt transform. |
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
| `CODEMEM_CLAUDE_HOOK_BOUNDARY_TIMEOUT_MS` | Override the direct Viewer request wait for `SessionEnd`, clamped inside `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`. For opt-in `Stop` flushing, this sets the whole boundary budget; the first request reserves fallback time within it (default total: `125000` ms). |

## Compatibility guidance behavior

When the plugin detects CLI/runtime version mismatch, it shows guidance based on runner mode:

- `CODEMEM_RUNNER=codemem`: run `npm install -g codemem`, then restart OpenCode
- `CODEMEM_RUNNER=npx`: update `CODEMEM_RUNNER_FROM` to a newer package/version (or reinstall plugin), then restart OpenCode
- `CODEMEM_RUNNER=node`: pull latest repo changes and run `pnpm build`, then restart OpenCode
- custom/unknown runner: update the underlying `codemem` binary or package source, then restart OpenCode

Update policy:

- `CODEMEM_BACKEND_UPDATE_POLICY=notify` (default): show warning toast with suggested action
- `CODEMEM_BACKEND_UPDATE_POLICY=auto`: try a best-effort auto-update for eligible compatibility-floor mismatches and fresh stable releases observed for at least 24 hours, then warn if still outdated
	- skipped for `node` dev-mode runners
	- skipped when `CODEMEM_RUNNER_FROM` is pinned to a fixed package/version
	- skipped for Docker, unknown, stale, prerelease, or downgrade states
- `CODEMEM_BACKEND_UPDATE_POLICY=off`: no compatibility toast (logging still records mismatch)

After its startup delay, the plugin also runs `codemem update check --json` through the same
argv-based CLI runner. `notify` and `auto` show a best-effort toast at most once per latest stable
release in the current OpenCode process; `off` skips this release check. Under explicit `auto`, an
eligible result invokes the fail-closed `codemem update install` command and verifies the active CLI
version before a plugin-owned Viewer is restarted. Current, unavailable, malformed, ineligible, and
timed-out results are ignored or shown as guidance without delaying plugin startup.
The installer uses a process-owned lock under `~/.codemem` so simultaneous OpenCode sessions cannot
run competing global npm installations. A live lock causes later attempts to fail closed; a lock whose
recorded process no longer exists is reclaimed.

Docker images set `CODEMEM_INSTALL_KIND=docker` so release guidance cannot mistake the bundled
global npm package for a host npm installation. Docker deployments never self-update; rebuild and
restart the image with the desired `CODEMEM_VERSION` instead.

Compatibility checks do not block plugin startup.
