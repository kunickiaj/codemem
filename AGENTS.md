# codemem

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

If you are about to run commands, default to the TypeScript toolchain (`pnpm ...`).
Use `uv run ...` only when you are explicitly working on the legacy Python backend
(`codemem/`, `tests/`, pytest/ruff, or Python release metadata).

## Execution Contract

- Treat work as incomplete until the requested change is implemented, the smallest relevant validation has run, and any remaining gaps are called out explicitly as blocked or deferred.
- Do not stop at analysis, a partial fix, or "here's what I would do" unless the user explicitly asked for plan-only work.
- Before acting, check prerequisites first: read the file you will change, inspect nearby tests/docs when behavior or public usage changes, and resolve dependency outputs from earlier steps before continuing.
- If a lookup/search result is empty or suspiciously narrow, try at least one fallback query or adjacent source before concluding that nothing relevant exists.
- Before finalizing, verify: requirements are met, claims are grounded in repo/tool output, requested format is satisfied, and the smallest relevant test/lint/build/doc check has passed.
- For substantial work, send short progress updates at phase changes only: what changed or was learned, and the next step. Do not narrate routine tool calls.
- For commits, pushes, issue updates, server restarts, or maintenance commands, briefly state the intended action first, then confirm the outcome and validation afterward.

## Releases

Release checklist:

1. Create a release branch + PR (no direct pushes to `main`)
2. Update version:
   - `packages/core/package.json`
   - `packages/cli/package.json`
   - `packages/opencode-plugin/package.json`
   - `packages/mcp-server/package.json`
   - `packages/viewer-server/package.json`
   - `packages/core/src/index.ts`
   - `packages/core/src/index.test.ts`
   - `packages/opencode-plugin/.opencode/plugins/codemem.js`
   - `.claude-plugin/marketplace.json` (metadata version only; MCP args are unpinned)
   - `plugins/claude/.claude-plugin/plugin.json` (metadata version only; MCP args are unpinned)
3. Regenerate lockfiles/artifacts and commit the results:
   - JS: run `pnpm install` and commit lockfile/artifact changes when applicable
   - Viewer UI bundle/assets: built via `pnpm build`
4. Ensure JS installs use the public npm registry (avoid private registries/mirrors)
   - Keep `.opencode/.npmrc` with `registry=https://registry.npmjs.org/`
5. Wait for CI to pass, then squash-merge the PR
6. After the release PR merges, switch to updated `main` and verify `HEAD` is the merged release commit
   - Run `git checkout main`
   - Run `git pull --rebase`
   - Run `git status --short --branch` and confirm the worktree is clean
   - Run `git show --stat --summary HEAD` and confirm the release version/artifact changes are present on `main`
7. Tag the merge commit on `main` as `vX.Y.Z` and push the tag
   - Never tag the release branch commit directly
   - Never create/push the release tag while checked out on `release/*`
   - Never assume the release branch tip and merged `main` commit are interchangeable; verify before tagging
   - The `Release` workflow triggers on `v*` tags and publishes the GitHub Release artifacts.
8. Do not immediately bump `main` to the next unreleased version with the current shared versioning model
   - `main` also carries live marketplace/plugin metadata and pinned CLI version references
   - A post-release bump on `main` can point live install paths at a package version that is not published yet
   - Keep next-version bumps in a later release-prep branch/PR unless versioning is explicitly decoupled first

## Stack

- Node: >=22
- Package manager: pnpm (workspace at root)
- Build: Vite 8 (library mode, Rolldown-powered)
- Tests: vitest
- Lint/format: biome
- Packages: `packages/core`, `packages/mcp-server`, `packages/viewer-server`, `packages/cli`
- Storage: SQLite (path configurable)

### Legacy Python (reference-only)

- Python backend code remains in `codemem/` and `tests/` for migration/reference work.
- Use `uv run ...` only when explicitly touching legacy Python surfaces.

**Publish model:** root `package.json` is workspace-only (`private: true`).
The published CLI package is `codemem` from `packages/cli`.
The published OpenCode plugin package is `@codemem/opencode-plugin` from `packages/opencode-plugin`.

## Quick Commands

### TypeScript default workflow

- Install JS deps: `pnpm install`
- Build all TS packages: `pnpm build`
- Run tests: `pnpm run test`
- Lint: `pnpm run lint`
- Typecheck: `pnpm run typecheck`
- Run TS CLI from source: `pnpm run codemem --help`

### Legacy Python setup (only when required)
- Install dev deps + create venv: `uv sync`
- Run commands via the venv (no activate): `uv run codemem --help`
- Activate (fish): `source .venv/bin/activate.fish`
- Activate (bash/zsh): `source .venv/bin/activate`

### Legacy Python build / install
- Editable install (if you want `codemem` on PATH): `uv pip install -e .`
- No-install run from this repo: `uv run codemem stats`
- One-off run via uvx: `uvx --from . codemem stats`

### TypeScript runtime commands (preferred)

- CLI help: `pnpm run codemem --help`
- Viewer help: `pnpm run codemem serve --help`
- Serve viewer (start): `pnpm run codemem serve start`
- Serve viewer (background): `pnpm run codemem serve --background`
- Serve viewer (restart): `pnpm run codemem serve restart`
- MCP server: `pnpm run codemem mcp`
- Claude hook ingest (stdin JSON): `pnpm run codemem claude-hook-ingest`
- Stats: `pnpm run codemem stats`
- Raw-event backlog: `pnpm run codemem db raw-events-status`

### Legacy Python runtime commands (only when explicitly required)

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

- `uv run pytest tests/test_store.py::test_deactivate_low_signal_observations`

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

## Frontend Development

Viewer UI is in `packages/ui` and served by `packages/viewer-server`.

### Viewer UI

- Source: `packages/ui/src/`
- Dev loop: edit UI files, run `pnpm build`, then restart viewer if needed

### OpenCode plugin

- Source: `packages/opencode-plugin/.opencode/plugins/codemem.js`
- Rules:
  - ESM only (`import`/`export`)
  - must never crash OpenCode (no uncaught exceptions)
  - avoid blocking hooks; defer heavy work to background CLI calls

## Repo Map
- `packages/core/src/`: core store/search/ingest/sync logic
- `packages/viewer-server/src/`: viewer API server
- `packages/ui/src/`: viewer frontend
- `packages/mcp-server/src/`: MCP server tools
- `packages/cli/src/`: CLI commands
- `packages/opencode-plugin/.opencode/plugins/codemem.js`: OpenCode plugin entrypoint
- `codemem/`, `tests/`: legacy Python backend/tests (reference only)

## Runtime Commands
- CLI entrypoint: `codemem`
- MCP server: `codemem mcp` (or `codemem-mcp`)
- Claude hook ingest (stdin JSON): `codemem claude-hook-ingest`
- Viewer: `codemem serve start|stop|restart` (or `codemem serve --background`)
- Export/Import: `codemem export-memories`, `codemem import-memories`
- Store maintenance: `codemem db prune-memories` (use `--dry-run` first)

## Environment Variables

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

## Memory Quality
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
- Prefer fast unit tests in `packages/**` via vitest (avoid network; mock external calls)
- Use targeted test runs for touched files, then broader runs as needed
- Legacy Python tests in `tests/` are for reference/migration surfaces

## Plugin / Viewer Notes
- Plugin must be defensive: no uncaught exceptions in hooks; avoid blocking work
- Viewer UI comes from `packages/ui` and `packages/viewer-server`; restart viewer to see runtime changes
- Docs:
  - `docs/architecture.md` (data flow, flush strategy)
  - `docs/user-guide.md` (viewer usage, troubleshooting)

## Quick Debug Checklist
- Plugin logging: `CODEMEM_PLUGIN_LOG=1` then check `~/.codemem/plugin.log`
- Missing sessions: confirm plugin + viewer use the same DB path (`CODEMEM_DB`)
- Flush/backlog issues: look for viewer logs and `codemem db raw-events-status` output

## When Changing Behavior
- If you change plugin behavior, update `README.md` (and relevant docs under `docs/`)
- If you change memory kinds, also update:
  - `packages/core/src/store.ts` (kind handling and persistence)
  - `packages/mcp-server/src/index.ts` (`memory_schema` tool)
  - `packages/ui/src/tabs/feed.ts` (UI kind presentation)
  - relevant vitest coverage in `packages/**`

## PR Hygiene

- Always use `.github/PULL_REQUEST_TEMPLATE.md` for every PR.
- Replace all template placeholder text before requesting review.
- Complete all checklist sections accurately:
  - Type of Change
  - Testing
  - Checklist
- Apply this to every PR in a stack (base PR and each follow-up PR).
- Keep PR titles/bodies and commit messages free of private inspiration references or other non-public context.

## Releases
- Release versions are prepared on a release branch + PR, then tagged only after that PR is merged to `main`.
- Before tagging:
  - `git checkout main`
  - `git pull --rebase`
  - verify the merged release commit is at `HEAD`
  - verify the worktree is clean
- Tag from `main` only: `git tag vX.Y.Z` then `git push origin vX.Y.Z`
- Do not tag from `release/*` branches.
- Do not immediately bump `main` to the next unreleased version with the current shared marketplace/package versioning model.

## Do / Don't
- Do keep changes small and deterministic; prefer adding tests when behavior changes
- Do validate inputs at boundaries; keep DB writes intentional
- Don't add new heavy dependencies without a clear need
- Don't let the plugin throw uncaught exceptions or block OpenCode hooks

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

## Issue Tracking

This project uses **bd (beads)** for issue tracking.
Run `bd prime` for workflow context, or install hooks (`bd hooks install`) for auto-injection.

**Quick reference:**
- `bd ready` - Find unblocked work
- `bd create "Title" --type task --priority 2` - Create issue
- `bd close <id>` - Complete work
- `bd dolt push` - Push beads to remote

**Agent rules:**
- Use `bd` for task tracking; do not create markdown TODO lists
- Prefer `--json` for programmatic commands
- Link discovered follow-up work with `discovered-from` when relevant

For full workflow details: `bd prime`
