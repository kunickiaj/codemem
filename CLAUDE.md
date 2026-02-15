# CLAUDE.md — AI Assistant Guide for codemem

This file provides context for Claude and other AI assistants working in this repository.

## What is codemem?

A lightweight persistent-memory companion for OpenCode. It captures terminal sessions and tool calls as memories, stores them in SQLite, serves a web viewer, and exposes MCP tools for semantic recall. It also supports peer-to-peer sync across machines.

**Key capabilities:**
- Persistent cross-session memory for coding agents (SQLite-backed)
- Web viewer for memory feed, session history, and observer tuning
- Peer-to-peer sync without a central service
- OpenCode-native plugin + MCP (Model Context Protocol) tools
- Semantic recall via sqlite-vec + fastembed embeddings
- Export/import for team knowledge sharing

## Repository Layout

```
codemem/                     # Main Python package
├── cli.py / cli_app.py      # CLI entrypoint (Typer)
├── config.py                # Config loading & defaults
├── db.py                    # SQLite initialization
├── mcp_server.py            # MCP tools (search, timeline, pack)
├── observer.py              # LLM observer for memory summarization
├── observer_prompts.py      # Observer prompt templates
├── plugin_ingest.py         # Tool event & transcript ingestion
├── viewer.py                # Embedded HTML viewer + HTTP server
├── store/                   # SQLite persistence layer
│   ├── _store.py            # Core MemoryStore class
│   ├── search.py            # Keyword & semantic search
│   ├── vectors.py           # sqlite-vec embedding management
│   ├── replication.py       # P2P sync replication
│   ├── raw_events.py        # Raw event ingestion & queuing
│   ├── packs.py             # Memory pack filtering & compression
│   ├── maintenance.py       # DB pruning, defrag
│   └── usage.py             # Usage analytics
├── commands/                # CLI command implementations
├── sync/                    # Peer-to-peer sync (daemon, discovery)
├── ingest/                  # Event ingestion pipeline
└── viewer_routes/           # HTTP API handlers
tests/                       # pytest suite (51 test files)
viewer_ui/                   # TypeScript/Vite viewer UI source
.opencode/
├── plugin/codemem.js        # OpenCode plugin entrypoint (ESM)
└── lib/compat.js            # Version compatibility helpers
docs/                        # Architecture, guides, plans
.github/workflows/           # CI (ci.yml) and release (release.yml)
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | Python >=3.11,<3.15 |
| Package manager | uv (lockfile: `uv.lock`) |
| CLI framework | Typer |
| Storage | SQLite |
| Embeddings | sqlite-vec + fastembed |
| Tests | pytest |
| Lint/format | ruff |
| Build backend | Hatchling |
| Plugin runtime | ESM JavaScript (Bun for dev/tests) |
| Viewer UI | TypeScript + Vite (bundled to `codemem/viewer_static/app.js`) |

## Quick Commands

### Setup
```bash
uv sync                          # Install deps + create .venv
uv run codemem --help             # Run without manual venv activation
```

### Tests
```bash
uv run pytest                                      # All tests
uv run pytest tests/test_store.py                   # Single file
uv run pytest tests/test_store.py::test_store_roundtrip  # Single test
uv run pytest -k "roundtrip and store"              # Substring match
uv run pytest --cov=codemem --cov-report=term       # With coverage
```

### Lint and Format
```bash
uv run ruff check codemem tests                     # Lint
uv run ruff format --check codemem tests             # Format check
uv run ruff check --fix codemem tests && uv run ruff format codemem tests  # Auto-fix
```

### Build
```bash
uv build                          # Build wheel + sdist
cd viewer_ui && bun install && bun run build  # Rebuild viewer UI bundle
```

### Runtime
```bash
uv run codemem serve              # Launch web viewer
uv run codemem mcp                # Start MCP server
uv run codemem stats              # Show store statistics
uv run codemem ingest             # Ingest events from stdin
```

## Code Style and Conventions

### Python
- **Always** use `from __future__ import annotations` (project convention)
- Line length: 100 (ruff config)
- Target: Python 3.11
- Ruff lint rules: E, W, F, I, UP, B, SIM (ignores: E501, B008)
- Naming: `snake_case` functions/vars, `PascalCase` classes, `UPPER_SNAKE_CASE` constants
- Private helpers start with `_`
- Prefer built-in generics (`list[str]`, `dict[str, Any]`) and `collections.abc`
- Use `Path` for filesystem paths; accept `Path | str` at public boundaries
- Prefer relative imports within `codemem`
- Validate at boundaries (env vars, config, CLI inputs, network payloads)
- Avoid bare `except:`; log exceptions with context
- No partial DB writes without intent

### JavaScript (OpenCode plugin)
- ESM only (`import`/`export`)
- Must never crash OpenCode (no uncaught exceptions)
- Avoid blocking hooks; defer heavy work to background CLI calls

## Version Management

Version must stay aligned across three files:
1. `pyproject.toml` — `[project].version`
2. `codemem/__init__.py` — `__version__`
3. `package.json` — `version`

CI validates this alignment. Releases are tag-driven (`vX.Y.Z`).

## Testing Guidance

- Prefer fast, isolated unit tests in `tests/`
- Avoid network calls; mock external dependencies
- Use `tmp_path` fixtures for DB/filesystem tests
- Add/adjust tests when changing ingestion filters, low-signal heuristics, or schemas
- Pytest default opts: `-q` (set in `pyproject.toml`)

## CI Pipeline

**Jobs (`.github/workflows/ci.yml`):**
1. **Test** — Python 3.11, 3.12, 3.13, 3.14 matrix; coverage on 3.14
2. **Lint** — Version alignment check, TypeScript type-check, viewer UI bundle freshness, ruff lint + format
3. **Plugin Smoke** — npm pack + install, plugin initialization in OpenCode-like runtime
4. **Provider Loop** — Observer tests with OpenAI and Anthropic providers

## Key Architecture Concepts

### Data Flow
1. Plugin captures events during OpenCode sessions (prompts, messages, tool calls)
2. Raw events stream to viewer HTTP API (`POST /api/raw-events`)
3. Idle/sweeper workers flush queued batches into the ingest pipeline
4. Ingest builds transcripts from user_prompt/assistant_message events
5. Observer creates typed observations + session summary
6. Store writes artifacts, observations, and session summary to SQLite
7. Viewer and MCP server read from SQLite

### Memory Quality Rules
- Don't store raw tool logs as memories
- Filter low-signal tool events (`read`, `edit`, `glob`, `grep`)
- Prefer typed memory kinds: `discovery`, `change`, `feature`, `bugfix`, `refactor`, `decision`, `exploration`
- Use `exploration` for attempts/experiments tried but not shipped
- Session summaries/observations are OFF by default

### Plugin Flush Strategy
- Event-driven triggers: `session.idle`, `session.created`, `/new` boundary, `session.error`
- Force-flush thresholds: >=50 tools, >=15 prompts, or >=10m duration

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CODEMEM_DB` | SQLite path (e.g., `~/.codemem/mem.sqlite`) |
| `CODEMEM_CONFIG` | Config file path override |
| `CODEMEM_PLUGIN_LOG` | Set to `1` for plugin logging |
| `CODEMEM_VIEWER_AUTO` | Set to `0` to disable auto-start viewer |
| `CODEMEM_INJECT_CONTEXT` | Set to `0` to disable memory pack injection |
| `CODEMEM_RUNNER` | CLI runner override (e.g., `uv`) |
| `CODEMEM_RUNNER_FROM` | Runner source path override |

## Configuration

- Default config file: `~/.config/codemem/config.json`
- Environment variables always override file config values
- Avoid hardcoding user paths; use config/env and normalize with `Path(...).expanduser()`

## Cross-Cutting Concerns

### When Changing Memory Kinds
Update all of these together:
- `codemem/observer_prompts.py` (types/schema)
- `codemem/mcp_server.py` (`memory_schema`)
- `codemem/viewer.py` (UI kind lists)
- `tests/test_e2e_pipeline.py` (coverage for documented types)

### When Changing Plugin Behavior
- Update `README.md` and relevant docs under `docs/`

### When Changing Viewer UI
- Source is in `viewer_ui/` (TypeScript + Vite)
- Build output goes to `codemem/viewer_static/app.js`
- Restart the viewer after changes (`codemem serve --restart`)
- CI validates the bundle is up to date

## Debugging Checklist

- Plugin logging: `CODEMEM_PLUGIN_LOG=1`, check `~/.codemem/plugin.log`
- Missing sessions: confirm plugin + viewer use same DB path (`CODEMEM_DB`)
- Flush/backlog issues: check `codemem raw-events-status` output
- Viewer logs: check viewer server output

## Repository Safety

- This is a public repository — never add secrets, API keys, or internal references
- Keep local artifacts out of git (`.venv/`, `.tmp/`, `*.sqlite`, logs, caches)
- Use obvious placeholders for any example credentials
