# @codemem/pi-extension

Pi coding-agent extension for [codemem](https://github.com/kunickiaj/codemem): session ingest and turn-local memory injection.

## Install

```bash
npm i -g codemem
codemem setup
```

`codemem setup` auto-detects pi and appends `npm:@codemem/pi-extension@<version>` to `~/.pi/agent/settings.json` `packages`. Useful flags:

| Flag | Purpose |
| --- | --- |
| `--pi-only` | Only configure pi |
| `--pi-mcp` | Opt into MCP via third-party `pi-mcp-adapter` (writes `mcp.json` only when detected) |
| `--pi-extension-path <path>` | Dev: write a local-path `packages` entry instead of the npm pin |

Dev / local-path install (equivalent to `--pi-extension-path`):

```json
{
  "packages": ["/absolute/path/to/codemem/packages/pi-extension"]
}
```

Build first so `dist/index.js` exists (`pnpm --filter @codemem/pi-extension build`).

**Uninstall:** remove the `@codemem/pi-extension` packages entry and restart pi. The shared memory store is left intact.

## What it does

- **Ingest** — captures pi session events (`session_start`/`session_shutdown`, user/assistant messages, tool calls/results) into codemem with `source: "pi"` via `POST /api/pi-hooks` (compat alias over the canonical ingest envelope), falling back to `codemem pi-hook-ingest` (spool when offline).
- **Injection** — on pi's `context` event, appends a `## codemem memories` block to the latest user message of the **request copy** (never the system prompt, never the saved session). Older user messages replay the exact bytes already injected for them, and a new pack is fetched only for the latest undecided message, so the provider's prefix cache stays stable. Already-shown items are cut from new packs when the pack response carries renderer spans. A contract-valid HTTP or `pack --json` response, including a zero-item pack, ends that fetch; `{}` and error-shaped bodies fall through. Those span-bearing successes log `inject.pack.ok source=pi` to the plugin log, the same line `pi-hook-inject` writes when it is the fallback. Decisions live in memory: a restart fetches again.
- **Tools** — registers the 14 `memory_*` tools natively (HTTP preferred, CLI fallback). Every HTTP operation first proves the viewer is target-aware (`GET /api/prompt-pack-profile` must report this process's `db_path` + `identity_target`) and re-sends the target on the query, so a foreign or stale older viewer on the port is never trusted (409 or unproven → targeted CLI path). Non-idempotent `memory_remember` does NOT CLI-replay on ambiguous HTTP failures (timeout/5xx/reset after send). No `pi-mcp-adapter` needed. Skipped when `pi.tools_mode` is `mcp-adapter`.
- **Compaction** — `session_before_compact` still only flushes extraction and never returns a custom summary. The next context skips a new pack fetch only after `session_compact` with `willRetry`, which is Pi's automatic overflow resume. Manual, threshold, cancelled, and failed compactions do not skip that fetch, and a later user message clears a skip that was not the immediate resume.
- **Fork/resume** — re-keys stream identity on every `session_start`; durable cursors via `pi.appendEntry`.
- **Cross-agent** — one shared, project-scoped store. Memories from OpenCode/Claude/Codex inject into pi and the reverse.
- **Dashboard** — pi rows appear in the source-agnostic feed/sessions/projects tabs with no extra setup.

## Observer derivation (v1)

Setup can fill unset `observer_*` keys from pi's API-key providers (cheap-model-first). Credentials stay in memory only and are never written to codemem config. OAuth-only installs get an explicit `unconfigured (oauth-only)` status — never a silent failure. Set `observer_provider` / `observer_model` explicitly when needed. Explicit `observer_*` config/env always wins.

## Configuration

Read from `~/.config/codemem/config.json` under the `pi` object, with `CODEMEM_PI_*` env overrides.

| Key / env | Default | Meaning |
| --- | --- | --- |
| `pi.tools_mode` / `CODEMEM_PI_TOOLS_MODE` | `native` | `native` registers tools here; `mcp-adapter` skips native registration (use pi-mcp-adapter + `codemem mcp`) |
| `pi.inject_prompts` / `CODEMEM_PI_INJECT_PROMPTS` | `true` | Attach the memory pack to the latest user message on each model request |
| `pi.file_context` / `CODEMEM_PI_FILE_CONTEXT` | `true` | Attach file-related memories when pi `read`s a tracked file |

Shared viewer / inject knobs (same as other clients):

| Env | Default | Meaning |
| --- | --- | --- |
| `CODEMEM_VIEWER_HOST` | `127.0.0.1` | Viewer host |
| `CODEMEM_VIEWER_PORT` | `38888` | Viewer port |
| `CODEMEM_VIEWER` | `1` | Enable viewer use |
| `CODEMEM_VIEWER_AUTO` | `1` | Auto-start `codemem serve start` when needed |
| `CODEMEM_RAW_EVENTS_BACKOFF_MS` | `10000` | Backoff after HTTP stream failure before retrying |
| `CODEMEM_INJECT_LIMIT` | `8` | Pack item limit |
| `CODEMEM_INJECT_TOKEN_BUDGET` | `800` | Pack token budget |
| `CODEMEM_INJECT_MAX_CHARS` | `16000` | Max injection block chars |
| `CODEMEM_INJECT_RETAINED_TOKEN_BUDGET` | uncapped | Optional approximate token ceiling for blocks already injected in the session (estimated as `ceil(chars / 4)`). Unset, zero, negative, and invalid values mean no cap; when enabled, a full ceiling attaches nothing new, fetches nothing, and never removes or truncates blocks already attached |

Example config:

```json
{
  "pi": {
    "tools_mode": "native",
    "inject_prompts": true,
    "file_context": true
  }
}
```

## Lifecycle

Per pi extension rules: the factory only wires handlers. Viewer auto-start and other session resources begin on `session_start` and clean up idempotently on `session_shutdown`. Session state is re-keyed from `ctx.sessionManager.getSessionId()` on every `session_start`; durable ingest cursors persist via `pi.appendEntry`.

## Peer dependencies

- `@earendil-works/pi-coding-agent` (extension host)
- `typebox` (tool parameter schemas)

No `@codemem/core` or native modules load inside the pi process.
