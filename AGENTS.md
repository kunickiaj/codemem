# Agent Guidelines for codemem

This file is for agentic coding tools working in this repo.

## Public repository safety

Assume this repository is public and everything you write (code, docs, tests, and commit messages)
will be published.

- Never add proprietary/internal references (private domains/hostnames, internal project codenames,
  employee emails, vendor/customer confidential identifiers, etc.).
- Never add secrets (API keys, tokens, passwords, private keys), even as examples. Use obvious
  placeholders instead.
- Keep local artifacts out of git (`.venv/`, `.tmp/`, `*.sqlite`, logs, caches).
- If you discover sensitive content already tracked or in git history: stop and propose a
  remediation plan (remove from tree + consider history rewrite).

If you are about to run commands, prefer `uv run ...` (no manual venv activation needed).

## Releases (reproducible process)

This repo uses PR-only `main` with required CI checks.

Release checklist:

1. Create a release branch + PR (no direct pushes to `main`)
2. Update version:
   - `pyproject.toml`
   - `codemem/__init__.py`
3. Regenerate lockfiles/artifacts and commit the results:
   - Python: run `uv sync` and commit `uv.lock` (the lockfile includes the local package version)
   - Viewer UI bundle: in `viewer_ui/`, run:
     - `bun install`
     - `bun run build`
     - commit updated `codemem/viewer_static/app.js`
4. Ensure JS installs use the public npm registry (avoid private registries/mirrors)
   - Keep `.opencode/.npmrc` with `registry=https://registry.npmjs.org/`
5. Wait for CI to pass, then squash-merge the PR
6. Tag the merge commit as `vX.Y.Z` and push the tag
   - The `Release` workflow triggers on `v*` tags and publishes the GitHub Release artifacts.

## Stack (what this repo uses)

- Python: >=3.11,<3.15
- Env/tooling: `uv` (creates `.venv/`)
- CLI: Typer (`codemem`)
- Storage: SQLite (path configurable)
- Tests: pytest
- Lint/format: ruff
- UI/plugin ("frontend"):
  - Viewer UI is embedded in Python: `codemem/viewer.py`
  - OpenCode plugin is ESM JS: `.opencode/plugin/codemem.js`

## Quick Commands

### Setup (recommended)
- Install dev deps + create venv: `uv sync`
- Run commands via the venv (no activate): `uv run codemem --help`
- Activate (fish): `source .venv/bin/activate.fish`
- Activate (bash/zsh): `source .venv/bin/activate`

### Build / Install
- Editable install (if you want `codemem` on PATH): `uv pip install -e .`
- No-install run from this repo: `uv run codemem stats`
- One-off run via uvx: `uvx --from . codemem stats`

### Common Dev Commands

- CLI help: `uv run codemem --help`
- Viewer help: `uv run codemem serve --help`
- Serve viewer: `uv run codemem serve`
- Serve viewer (background): `uv run codemem serve --background`
- Serve viewer (restart): `uv run codemem serve --restart`
- MCP server: `uv run codemem mcp`
- Ingest (stdin JSON): `uv run codemem ingest`
- Stats: `uv run codemem stats`

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
- Lint: `uv run ruff check codemem tests`
- Format (check only): `uv run ruff format --check codemem tests`
- Auto-fix lint + format: `uv run ruff check --fix codemem tests` then `uv run ruff format codemem tests`

Ruff config (from `pyproject.toml`):
- line length: 100
- target: py311
- lint selects: E, W, F, I, UP, B, SIM
- ignores: E501 (formatter), B008 (Typer default args)

### Coverage (optional)
- `uv run pytest --cov=codemem --cov-report=term`

## Frontend Development (viewer + plugin)

This repo does not have a separate JS build step (no Vite/Next/etc). The UI is embedded.

### Viewer UI

- Source: `codemem/viewer.py`
- Dev loop: edit `codemem/viewer.py` then restart `codemem serve`

### OpenCode plugin

- Source: `.opencode/plugin/codemem.js`
- Rules:
  - ESM only (`import`/`export`)
  - must never crash OpenCode (no uncaught exceptions)
  - avoid blocking hooks; defer heavy work to background CLI calls

## Repo Map (where things live)
- `codemem/`: Python package (CLI, ingest pipeline, MCP server, viewer, store)
- `codemem/store/_store.py`: SQLite store entrypoint (most store methods hang off `MemoryStore`)
- `codemem/plugin_ingest.py`: ingestion + filtering of tool events / transcripts
- `codemem/mcp_server.py`: MCP tools (search/timeline/pack/etc.)
- `codemem/viewer.py`: embedded viewer HTML + server glue
- `.opencode/plugin/codemem.js`: OpenCode plugin entrypoint
- `tests/`: pytest tests (prefer fast, isolated unit tests)

## Runtime Commands
- CLI entrypoint: `codemem` (Typer)
- MCP server: `codemem mcp` (or `codemem-mcp`)
- Plugin ingest (stdin JSON): `codemem ingest`
- Viewer: `codemem serve` (add `--background` / `--restart` as needed)
- Export/Import: `codemem export-memories`, `codemem import-memories`
- Store maintenance: `codemem db prune-memories` (use `--dry-run` first)

## Environment Variables (most used)

- `CODEMEM_DB`: sqlite path (example: `~/.codemem/mem.sqlite`)
- `CODEMEM_PLUGIN_LOG`: set to `1` to enable plugin logging

## Code Style

### Python
- Version: Python >=3.11,<3.15 (see `pyproject.toml`)
- Always use `from __future__ import annotations` (project convention; most files already do)
- Formatting: let `ruff format` do the wrapping; don't fight it
- Imports:
  - Let ruff/isort order imports
  - Prefer relative imports within `codemem` (as existing code does)
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
- Default config file: `~/.config/codemem/config.json`
- Env vars override config values when present
- Default DB path is configurable; `CODEMEM_DB=~/.codemem/mem.sqlite` is a common override
- Avoid hardcoding user paths in code; use config/env and normalize with `Path(...).expanduser()`

## Testing Guidance
- Prefer fast unit tests in `tests/` (avoid network; mock external calls)
- Use `tmp_path` fixtures for DB/filesystem tests
- Add/adjust tests when changing ingestion filters, low-signal heuristics, or schemas

## Plugin / Viewer Notes
- Plugin must be defensive: no uncaught exceptions in hooks; avoid blocking work
- Viewer HTML is embedded in Python (`codemem/viewer.py`); restart the viewer to see UI changes
- Docs:
  - `docs/architecture.md` (data flow, flush strategy)
  - `docs/user-guide.md` (viewer usage, troubleshooting)

## Quick Debug Checklist
- Plugin logging: `CODEMEM_PLUGIN_LOG=1` then check `~/.codemem/plugin.log`
- Missing sessions: confirm plugin + viewer use the same DB path (`CODEMEM_DB`)
- Flush/backlog issues: look for viewer logs and `codemem raw-events-status` output

## When Changing Behavior
- If you change plugin behavior, update `README.md` (and relevant docs under `docs/`)
- If you change memory kinds, also update:
  - `codemem/observer_prompts.py` (types/schema)
  - `codemem/mcp_server.py` (`memory_schema`)
  - `codemem/viewer.py` (UI kind lists)
  - `tests/test_e2e_pipeline.py` coverage around documented types

## PR Hygiene (Required)

- Always use `.github/PULL_REQUEST_TEMPLATE.md` for every PR.
- Replace all template placeholder text before requesting review.
- Complete all checklist sections accurately:
  - Type of Change
  - Testing
  - Checklist
- Apply this to every PR in a stack (base PR and each follow-up PR).
- Keep PR titles/bodies and commit messages free of private inspiration references or other non-public context.

## Releases
- Bump versions:
  - `pyproject.toml` (semver)
  - `codemem/__init__.py` (`__version__`)
- Validate: `uv run pytest` and `uv run ruff check codemem tests`
- Tag + push: `git tag vX.Y.Z` then `git push origin main --tags`

## Cursor / Copilot Rules
- No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` found.
- If added later, summarize and mirror them here.

## Do / Don't
- Do keep changes small and deterministic; prefer adding tests when behavior changes
- Do validate inputs at boundaries; keep DB writes intentional
- Don't add new heavy dependencies without a clear need
- Don't let the plugin throw uncaught exceptions or block OpenCode hooks

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Dolt-powered version control with native sync
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Auto-Sync

bd automatically syncs via Dolt:

- Each write auto-commits to Dolt history
- Use `bd dolt push`/`bd dolt pull` for remote sync
- No manual export/import needed!

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

<!-- END BEADS INTEGRATION -->
