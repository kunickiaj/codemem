# Agent Guidelines for opencode-mem

This file is for agentic coding tools working in this repo.

If you are about to run commands, prefer `uv run ...` (no manual venv activation needed).

## Stack (what this repo uses)

- Python: >=3.11,<3.15
- Env/tooling: `uv` (creates `.venv/`)
- CLI: Typer (`opencode-mem`)
- Storage: SQLite (path configurable)
- Tests: pytest
- Lint/format: ruff
- UI/plugin ("frontend"):
  - Viewer UI is embedded in Python: `opencode_mem/viewer.py`
  - OpenCode plugin is ESM JS: `.opencode/plugin/opencode-mem.js`

## Quick Commands

### Setup (recommended)
- Install dev deps + create venv: `uv sync`
- Run commands via the venv (no activate): `uv run opencode-mem --help`
- Activate (fish): `source .venv/bin/activate.fish`
- Activate (bash/zsh): `source .venv/bin/activate`

### Build / Install
- Editable install (if you want `opencode-mem` on PATH): `uv pip install -e .`
- No-install run from this repo: `uv run opencode-mem stats`
- One-off run via uvx: `uvx --from . opencode-mem stats`

### Common Dev Commands

- CLI help: `uv run opencode-mem --help`
- Viewer help: `uv run opencode-mem serve --help`
- Serve viewer: `uv run opencode-mem serve`
- Serve viewer (background): `uv run opencode-mem serve --background`
- Serve viewer (restart): `uv run opencode-mem serve --restart`
- MCP server: `uv run opencode-mem mcp`
- Ingest (stdin JSON): `uv run opencode-mem ingest`
- Stats: `uv run opencode-mem stats`

### Tests (pytest)
- Run all tests: `uv run pytest`
- Run a single file: `uv run pytest tests/test_store.py`
- Run a single test: `uv run pytest tests/test_store.py::test_store_roundtrip`
- Run by substring match: `uv run pytest -k "roundtrip and store"`

Single-test example:
- `uv run pytest tests/test_store.py::test_deactivate_low_signal_observations`

Notes:
- Pytest default opts are in `pyproject.toml` (`addopts = "-q"`).

### Lint / Format (ruff)
- Lint: `uv run ruff check opencode_mem tests`
- Format (check only): `uv run ruff format --check opencode_mem tests`
- Auto-fix lint + format: `uv run ruff check --fix opencode_mem tests` then `uv run ruff format opencode_mem tests`

Ruff config (from `pyproject.toml`):
- line length: 100
- target: py311
- lint selects: E, W, F, I, UP, B, SIM
- ignores: E501 (formatter), B008 (Typer default args)

### Coverage (optional)
- `uv run pytest --cov=opencode_mem --cov-report=term`

## Frontend Development (viewer + plugin)

This repo does not have a separate JS build step (no Vite/Next/etc). The UI is embedded.

### Viewer UI

- Source: `opencode_mem/viewer.py`
- Dev loop: edit `opencode_mem/viewer.py` then restart `opencode-mem serve`

### OpenCode plugin

- Source: `.opencode/plugin/opencode-mem.js`
- Rules:
  - ESM only (`import`/`export`)
  - must never crash OpenCode (no uncaught exceptions)
  - avoid blocking hooks; defer heavy work to background CLI calls

## Repo Map (where things live)
- `opencode_mem/`: Python package (CLI, ingest pipeline, MCP server, viewer, store)
- `opencode_mem/store/_store.py`: SQLite store entrypoint (most store methods hang off `MemoryStore`)
- `opencode_mem/plugin_ingest.py`: ingestion + filtering of tool events / transcripts
- `opencode_mem/mcp_server.py`: MCP tools (search/timeline/pack/etc.)
- `opencode_mem/viewer.py`: embedded viewer HTML + server glue
- `.opencode/plugin/opencode-mem.js`: OpenCode plugin entrypoint
- `tests/`: pytest tests (prefer fast, isolated unit tests)

## Runtime Commands
- CLI entrypoint: `opencode-mem` (Typer)
- MCP server: `opencode-mem mcp` (or `opencode-mem-mcp`)
- Plugin ingest (stdin JSON): `opencode-mem ingest`
- Viewer: `opencode-mem serve` (add `--background` / `--restart` as needed)
- Export/Import: `opencode-mem export-memories`, `opencode-mem import-memories`
- Store maintenance: `opencode-mem db prune-memories` (use `--dry-run` first)

## Environment Variables (most used)

- `OPENCODE_MEM_DB`: sqlite path (example: `~/opencode-mem.sqlite`)
- `OPENCODE_MEM_PLUGIN_LOG`: set to `1` to enable plugin logging

## Code Style

### Python
- Version: Python >=3.11,<3.15 (see `pyproject.toml`)
- Always use `from __future__ import annotations` (project convention; most files already do)
- Formatting: let `ruff format` do the wrapping; don't fight it
- Imports:
  - Let ruff/isort order imports
  - Prefer relative imports within `opencode_mem` (as existing code does)
- Types:
  - Prefer built-in generics (`list[str]`, `dict[str, Any]`) and `collections.abc` (`Iterable`, `Sequence`)
  - Use `Path` for filesystem paths; accept `Path | str` at public boundaries and normalize early
  - Use `TypedDict` for "event-like" dict payloads when shape matters
- Naming:
  - `snake_case` for functions/vars, `PascalCase` for classes, `UPPER_SNAKE_CASE` for constants
  - Private helpers start with `_`; keep module surfaces small and explicit
- Error handling:
  - Validate at boundaries (env vars, config, CLI inputs, network payloads)
  - Avoid bare `except:`; log exceptions with context (`logger.warning(..., exc_info=exc)` or `logger.exception(...)`)
  - CLI: prefer user-friendly messages + non-zero exits (Typer patterns)
  - Keep failure paths safe/deterministic (no partial DB writes without intent)

### JavaScript (OpenCode plugin)
- ESM modules (`import`/`export`)
- The plugin must never crash OpenCode:
  - Guard risky code paths; swallow/record errors where needed
  - Avoid blocking work in hooks; defer heavy work to background CLI calls
  - Keep helper functions small and testable; prefer pure transformations

## Memory Quality Rules (important)
- Don't store raw tool logs as memories
- Filter low-signal tool events (`read`, `edit`, `glob`, `grep`, etc.)
- Prefer typed memory kinds: `discovery`, `change`, `feature`, `bugfix`, `refactor`, `decision`, `exploration`
- Use `exploration` for attempts/experiments that were tried but not shipped (preserves "why not")
- Session summaries/observations are OFF by default; only enable via config

## Configuration
- Default config file: `~/.config/opencode-mem/config.json`
- Env vars override config values when present
- Default DB path is configurable; `OPENCODE_MEM_DB=~/opencode-mem.sqlite` is a common override
- Avoid hardcoding user paths in code; use config/env and normalize with `Path(...).expanduser()`

## Testing Guidance
- Prefer fast unit tests in `tests/` (avoid network; mock external calls)
- Use `tmp_path` fixtures for DB/filesystem tests
- Add/adjust tests when changing ingestion filters, low-signal heuristics, or schemas

## Plugin / Viewer Notes
- Plugin must be defensive: no uncaught exceptions in hooks; avoid blocking work
- Viewer HTML is embedded in Python (`opencode_mem/viewer.py`); restart the viewer to see UI changes
- Docs:
  - `docs/architecture.md` (data flow, flush strategy)
  - `docs/user-guide.md` (viewer usage, troubleshooting)

## Quick Debug Checklist
- Plugin logging: `OPENCODE_MEM_PLUGIN_LOG=1` then check `~/.opencode-mem/plugin.log`
- Missing sessions: confirm plugin + viewer use the same DB path (`OPENCODE_MEM_DB`)
- Flush/backlog issues: look for viewer logs and `opencode-mem raw-events-status` output

## When Changing Behavior
- If you change plugin behavior, update `README.md` (and relevant docs under `docs/`)
- If you change memory kinds, also update:
  - `opencode_mem/observer_prompts.py` (types/schema)
  - `opencode_mem/mcp_server.py` (`memory_schema`)
  - `opencode_mem/viewer.py` (UI kind lists)
  - `tests/test_e2e_pipeline.py` coverage around documented types

## Releases
- Bump versions:
  - `pyproject.toml` (semver)
  - `opencode_mem/__init__.py` (`__version__`)
- Validate: `uv run pytest` and `uv run ruff check opencode_mem tests`
- Tag + push: `git tag vX.Y.Z` then `git push origin main --tags`

## Cursor / Copilot Rules
- No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` found.
- If added later, summarize and mirror them here.

## Do / Don't
- Do keep changes small and deterministic; prefer adding tests when behavior changes
- Do validate inputs at boundaries; keep DB writes intentional
- Don't add new heavy dependencies without a clear need
- Don't let the plugin throw uncaught exceptions or block OpenCode hooks
