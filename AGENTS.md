# Agent Guidelines for opencode-mem

## Project Overview
- `opencode_mem/` is the Python package (CLI, ingest pipeline, MCP server, viewer, store).
- `.opencode/plugin/opencode-mem.js` is the OpenCode plugin entrypoint.
- `tests/` contains pytest tests (fast, isolated).
- `pyproject.toml` defines dependencies and pytest options.
- `README.md` documents installation and runtime configuration.

## Build / Install
- Install (editable): `uv pip install -e .`
- Install dev deps: `uv sync` (dev group is included by default)
- Alternate: `pip install -e .`

## Runtime Commands
- CLI entrypoint: `opencode-mem` (Typer CLI)
- MCP server: `opencode-mem mcp`
- Plugin ingest: `opencode-mem ingest` (stdin JSON)
- Viewer: `opencode-mem serve --background`
- Export/Import: `opencode-mem export-memories`, `opencode-mem import-memories`

## Test Commands
- Run all tests: `pytest`
- Run a single file: `pytest tests/test_store.py`
- Run a single test: `pytest tests/test_store.py::test_store_roundtrip`
- Pytest config: `pyproject.toml` sets `-q` (quiet) by default.

## Lint / Format
- Linter: `ruff check opencode_mem tests`
- Formatter: `ruff format opencode_mem tests`
- Auto-fix: `ruff check --fix opencode_mem tests`
- CI enforces linting and formatting on all PRs.

## Code Style
### Python
- Follow PEP 8 with 4‑space indentation.
- Prefer explicit, descriptive names over abbreviations.
- Use `snake_case` for functions/variables, `PascalCase` for classes, `UPPER_CASE` for constants.
- Favor small pure helper functions for logic reuse.
- Avoid inline comments unless the user requests them; rely on clear naming.
- Use type hints (including `Optional`, `Iterable`, `list[...]`) consistently.
- Keep string literals consistent with surrounding files.

### JavaScript (OpenCode plugin)
- Uses ES modules (`import`/`export`).
- Keep plugin logic non‑blocking; avoid long awaits in hooks.
- Use small helpers for logging and runner execution.
- Avoid heavy work in `event` hooks; defer to background CLI calls.

## Error Handling
- Avoid swallowing exceptions silently; log or record errors where useful.
- For CLI commands, prefer user‑friendly output and exit codes.
- In background plugin operations, log to `~/.opencode-mem/plugin.log`.
- Keep failure paths safe: no uncaught exceptions in plugin hooks.

## Configuration
- Default config file: `~/.config/opencode-mem/config.json`.
- Environment variables override config values when present.
- Do not hardcode user paths; use config or env.

## Memory Quality Rules (Important)
- Do not store raw tool logs as memories.
- Filter low‑signal tool events (`read`, `edit`, `glob`, `grep`, etc.).
- Prefer typed memories: `discovery`, `change`, `feature`, `bugfix`, `refactor`, `decision`, `exploration`.
- **Use `exploration` for attempts/experiments that were tried but NOT shipped** - these preserve "why we didn't do X" context.
- Session summaries/observations are OFF by default; only enable via config.
- Apply low‑signal filters before persisting any memory.

## MCP Tools
- MCP server exposes memory tools for recall/search.
- Global MCP config example is in `README.md`.
- When updating memory kinds, also update `memory_schema` in `opencode_mem/mcp_server.py`.

## Plugin Rules
- Plugin file must export default (`export default OpencodeMemPlugin`).
- Avoid startup banners or blocking CLI calls on load.
- Flush strategy is adaptive with multiple triggers:
  - **Idle-based:** 2min base delay, reduces to 60s/30s with heavy work
  - **Threshold-based:** Force flush at 50+ tools OR 15+ prompts OR 10+ min duration
  - **Error-based:** Immediate flush on `session.error`
  - Note: `/new` command and `session.created` don't trigger flushes in OpenCode's multi-session environment
- If changes are made to plugin behavior, update the README.

## Testing Guidance
- Prefer fast unit tests in `tests/`.
- Use `tmp_path` fixtures for DB or filesystem tests.
- Add tests for new filters or memory‑quality logic.

## Files to Know
- `opencode_mem/plugin_ingest.py`: filters tool events, builds transcript from user_prompt and assistant_message events, persists memories.
- `opencode_mem/classifier.py`: typed memory classification (API or `opencode run`).
- `opencode_mem/summarizer.py`: heuristic summarization and low‑signal detection.
- `opencode_mem/store.py`: SQLite operations and purge logic.
- `opencode_mem/cli.py`: Typer-based CLI commands including export/import.
- `.opencode/plugin/opencode-mem.js`: Plugin entrypoint with adaptive flush strategy.

## Design Principles
- Favor pragmatic, minimal changes.
- Keep behavior deterministic and debuggable.
- Avoid over‑engineering or new dependencies unless necessary.
- Maintain compatibility with `uvx` execution and OpenCode OAuth flow.

## Cursor / Copilot Rules
- No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` found.
- If added later, mirror them here.

## Quick Debug Checklist
- Is plugin loaded? Check `~/.opencode-mem/plugin.log`.
- Are events flushed? Look for `flush.start` / `flush.ok`.
- Are memories clean? Run `opencode-mem recent`.
- Need cleanup? `opencode-mem purge`.

## Do / Don’t
- Do prefer typed memories and concise narratives.
- Do keep ingestion filters conservative.
- Don’t store raw file dumps or line‑number output as memories.
- Don’t assume API keys exist; support OpenCode OAuth flow via `opencode run`.

## Single‑Test Example
- `pytest tests/test_store.py::test_deactivate_low_signal_observations`

## Notes for Future Agents
- If you change memory categories, update:
  - `opencode_mem/observer_prompts.py` (OBSERVATION_TYPES and OBSERVATION_SCHEMA)
  - `opencode_mem/mcp_server.py` (`memory_schema`)
  - `opencode_mem/viewer.py` (pill/border styling, /api/observations kinds list)
  - `tests/test_e2e_pipeline.py` (test_observer_types_are_documented)
  - `README.md`
- If you change CLI behavior, update `README.md` and tests.
- If you change plugin flush behavior, update this file and `docs/architecture.md`.

## Recent Improvements (Jan 2026)
- **v0.3.0:** Export/import memories by project for team knowledge sharing
- **v0.3.1:** Fixed transcript capture bug (was passing empty string, now builds from events)
- **v0.3.3:** Web UI improvements (markdown, icons, current session stats, dark mode colors)
- **v0.3.4:** Added `exploration` memory kind for tracking attempted approaches that weren't shipped
- **Latest:** Adaptive flush strategy (2min base, 60s/30s with heavy work, force flush at thresholds)
