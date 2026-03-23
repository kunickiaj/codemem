# codemem

[![CI](https://github.com/kunickiaj/codemem/actions/workflows/ci.yml/badge.svg)](https://github.com/kunickiaj/codemem/actions/workflows/ci.yml) [![codecov](https://codecov.io/gh/kunickiaj/codemem/branch/main/graph/badge.svg)](https://codecov.io/gh/kunickiaj/codemem) [![Release](https://img.shields.io/github/v/release/kunickiaj/codemem)](https://github.com/kunickiaj/codemem/releases)

Persistent memory for [OpenCode](https://opencode.ai) and [Claude Code](https://claude.ai/code). codemem captures what you work on across sessions, retrieves relevant context using hybrid search, and injects relevant context automatically in OpenCode.

- **Local-first** — everything lives in SQLite on your machine
- **Hybrid retrieval** — FTS5 BM25 lexical search + sqlite-vec semantic search, merged and re-ranked
- **Automatic injection** — the OpenCode plugin injects context into every prompt, no manual steps
- **Claude Code plugin support** — install from the codemem marketplace source
- **Built-in viewer** — browse memories, sessions, and observer output in a local web UI
- **Peer-to-peer sync** — replicate memories across machines without a central service

| Light | Dark |
|-------|------|
| ![codemem viewer – light theme](docs/images/codemem-light.png) | ![codemem viewer – dark theme](docs/images/codemem-dark.png) |

## Quick start

**Prerequisites:** Python 3.11+ and [uv](https://docs.astral.sh/uv/)

If `uv` is not installed yet:

```bash
# Homebrew
brew install uv

# mise
mise use -g uv@latest
```

1. Add the plugin to your OpenCode config (`~/.config/opencode/opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@kunickiaj/codemem"]
}
```

2. Restart OpenCode.

By default, the OpenCode plugin resolves backend CLI calls from a `uvx` source pinned to the plugin version, so plugin and backend stay aligned unless you override `CODEMEM_RUNNER` / `CODEMEM_RUNNER_FROM`. That means the backend is fetched on first use; no separate `codemem` install is required for the basic OpenCode path.

3. Verify:

```bash
uvx codemem stats
uvx codemem raw-events-status
```

That's it. The plugin captures activity, builds memories, and injects context from here on.

If you want `codemem` available directly on your `PATH` for repeated manual commands, install the CLI separately:

```bash
uv tool install --upgrade codemem
```

First startup may be slower because `uvx` can fetch/install the backend on demand.

### Claude Code (marketplace install)

In [Claude Code](https://claude.ai/code), add the codemem marketplace source and install the plugin:

```text
/plugin marketplace add kunickiaj/codemem
/plugin install codemem
```

The Claude plugin starts MCP with:

- `uvx codemem==<plugin-version> mcp`

We still recommend installing/upgrading the CLI for local hook ingestion and manual `codemem` commands:

```bash
uv tool install --upgrade codemem
```

Claude MCP launch uses `uvx`; first startup may be slower because `uvx` can fetch/install tooling on demand.

Claude hook ingestion is HTTP enqueue-first (`POST /api/claude-hooks`) and falls back to direct local DB enqueue via `codemem claude-hook-ingest` (or pinned `uvx codemem==<plugin-version> claude-hook-ingest`) when the local server path is unavailable.

Claude hook events share the same raw-event queue pipeline used by OpenCode. `UserPromptSubmit` runs
capture ingest in the background and injects memory context via Claude `additionalContext` using
local CLI/store pack generation by default, with optional HTTP `/api/pack` fallback.

The packaged Claude hook shell scripts are thin wrappers over TS CLI commands:
`codemem claude-hook-ingest` and `codemem claude-hook-inject`.
`claude-hook-inject` does not use `uvx` fallback by default to keep prompt-submit latency low.

> Migrating from `opencode-mem`? See [docs/rename-migration.md](docs/rename-migration.md).

## How it works

Adapters hook into runtime event systems (OpenCode plugin and Claude hooks). They capture tool calls and conversation messages, flush them through an observer pipeline that produces typed memories, and surface retrieval context for future prompts.

```mermaid
sequenceDiagram
participant OC as OpenCode
participant PL as codemem plugin
participant ST as MemoryStore
participant DB as SQLite

OC->>PL: tool.execute.after events
OC->>PL: experimental.chat.system.transform
PL->>ST: build_memory_pack with shaped query
ST->>DB: FTS5 BM25 lexical search
ST->>DB: sqlite vec semantic search
ST->>ST: merge rerank and section assembly
ST-->>PL: pack text
PL->>OC: inject codemem context
```

**Retrieval** combines two strategies: keyword search via SQLite FTS5 with BM25 scoring and semantic similarity via sqlite-vec embeddings. In the pack-building path, results from both are merged, deduplicated, and re-ranked using recency and memory-kind boosts.

**Injection** happens automatically. The plugin builds a query from the current session context (first prompt, latest prompt, project, recently modified files), calls `build_memory_pack`, and appends the result to the system prompt via `experimental.chat.system.transform`.

**Memories** are typed — `bugfix`, `feature`, `refactor`, `change`, `discovery`, `decision`, `exploration` — with structured fields like `facts`, `concepts`, `files_read`, and `files_modified` that improve retrieval relevance. Low-signal events are filtered at multiple layers before persistence.

For architecture details, see [docs/architecture.md](docs/architecture.md).

## CLI

| Command | Description |
|---------|-------------|
| `codemem stats` | Database statistics |
| `codemem recent` | Recent memories |
| `codemem search <query>` | Search memories |
| `codemem embed` | Backfill semantic embeddings |
| `codemem serve` | Launch the web viewer |
| `codemem db backfill-tags` | Populate missing `tags_text` values |
| `codemem db prune-observations` | Deactivate low-signal observations |
| `codemem db prune-memories` | Deactivate low-signal memories (`--dry-run` to preview) |
| `codemem export-memories` | Export memories by project |
| `codemem import-memories` | Import memories (idempotent) |
| `codemem sync` | Peer-to-peer sync commands |

Run `codemem --help` for the full list.

Note: in the TypeScript CLI, `codemem memory inject <context>` prints raw `pack_text`
for manual prompt injection. `codemem memory compact` remains deferred.

## MCP tools

To give the LLM direct access to memory tools (search, timeline, pack, remember, forget):

```bash
codemem install-mcp
```

This updates your OpenCode config to register the MCP server. Restart OpenCode to activate.

## Configuration

Config file: `~/.config/codemem/config.json` (override with `CODEMEM_CONFIG`). Environment variables take precedence over file settings.

Common overrides:

| Variable | Purpose |
|----------|---------|
| `CODEMEM_DB` | SQLite database path |
| `CODEMEM_INJECT_CONTEXT` | `0` to disable automatic context injection |
| `CODEMEM_VIEWER_AUTO` | `0` to disable auto-starting the viewer |

The viewer includes a grouped Settings modal (`Connection`, `Processing`, `Device Sync`) with shell-agnostic labels and an advanced-controls toggle for technical fields.
- Settings show effective values (configured or default) and only persist changed fields on save.

Observer runtime/auth in `0.16`:

- Runtime options: `api_http` and `claude_sidecar`.
- `api_http` defaults to `gpt-5.1-codex-mini` (OpenAI path) unless you set `observer_model`.
- Anthropic direct API calls accept Anthropic model IDs/aliases. codemem maps the common Claude shorthand `claude-4.5-haiku` to Anthropic's direct API alias `claude-haiku-4-5`; you can also set a pinned snapshot like `claude-haiku-4-5-20251001` explicitly.
- `claude_sidecar` defaults to `claude-4.5-haiku`; if the selected `observer_model` is unsupported by Claude CLI, codemem retries once with Claude's CLI default model.
- `claude_sidecar` command is configurable with `claude_command` (`CODEMEM_CLAUDE_COMMAND`) as a JSON argv array.
  - Config file example: `"claude_command": ["wrapper", "claude", "--"]`
  - Env var example: `CODEMEM_CLAUDE_COMMAND='["wrapper","claude","--"]'`
- Auth sources: `auto`, `env`, `file`, `command`, `none`.
- `observer_auth_command` must be a JSON string array (argv), not a space-separated string.
  - Config file example: `"observer_auth_command": ["iap-auth", "--audience", "example"]`
  - Env var example: `CODEMEM_OBSERVER_AUTH_COMMAND='["iap-auth","--audience","example"]'`
- Header templates support `${auth.token}`, `${auth.type}`, and `${auth.source}` (for example `Authorization: Bearer ${auth.token}`).
- Queue cadence is configurable with `raw_events_sweeper_interval_s` (seconds) in Settings/config.

## Export and import

Share project knowledge with teammates or back up memories across machines.

```bash
# Export current project
codemem export-memories project.json

# Import on another machine (idempotent, safe to re-run)
codemem import-memories project.json --remap-project ~/workspace/myproject

# Import from claude-mem
codemem import-from-claude-mem ~/.claude-mem/claude-mem.db
```

See `codemem export-memories --help` and `codemem import-memories --help` for full options.

## Peer-to-peer sync

Replicate memories across devices without a central server.

```bash
codemem sync enable        # generate device keys
codemem sync pair          # generate pairing payload
codemem sync daemon        # start sync daemon
codemem sync install       # autostart on macOS + Linux
```

The viewer now includes actor management for mapping multiple peers to one logical person, plus owned-memory visibility controls so project-filtered memories share by default while `Only me` stays a per-memory local override.

Project filters, peer-to-actor assignment, visibility controls, and config keys are documented in [docs/user-guide.md](docs/user-guide.md).

For cross-network setups where peer addresses change frequently or mDNS does not cross VPN/network boundaries, codemem also supports optional coordinator-backed discovery with a self-hosted coordinator. The preferred deployment path is the built-in `codemem sync coordinator` service; see [docs/coordinator-discovery.md](docs/coordinator-discovery.md).

## Semantic recall

Embeddings are stored in sqlite-vec and written automatically when memories are created. Use `codemem embed` to backfill existing memories. If sqlite-vec cannot load, keyword search still works.

> **aarch64 Linux note:** The PyPI wheels currently ship a 32-bit `vec0.so` on aarch64. See [docs/user-guide.md](docs/user-guide.md) for the workaround.

## Alternative install methods

<details>
<summary>Local development, uvx, git install</summary>

### Local development

```bash
uv sync
source .venv/bin/activate  # bash/zsh
source .venv/bin/activate.fish  # fish
codemem --help
```

### Via uvx (no install)

```bash
uvx --from git+ssh://git@github.com/kunickiaj/codemem.git codemem stats
```

### Install from GitHub

```bash
uv pip install git+ssh://git@github.com/kunickiaj/codemem.git
```

### Plugin from git (advanced)

```bash
uvx --from git+ssh://git@github.com/kunickiaj/codemem.git codemem install-plugin
```

### Plugin for development

Start OpenCode inside the codemem repo directory — the plugin auto-loads from `.opencode/plugin/`.

</details>

## Documentation

- [Architecture](docs/architecture.md) — data flow, retrieval, observer pipeline, design tradeoffs
- [Coordinator-backed discovery](docs/coordinator-discovery.md) — self-hosted cross-network peer discovery
- [User guide](docs/user-guide.md) — viewer usage, sync setup, troubleshooting
- [Plugin reference](docs/plugin-reference.md) — plugin behavior, env vars, stream reliability
- [Migration guide](docs/rename-migration.md) — migrating from `opencode-mem`
- [Contributing](CONTRIBUTING.md) — development setup, tests, linting, releases
