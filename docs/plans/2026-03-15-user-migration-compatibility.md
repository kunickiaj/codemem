# User Migration Compatibility: Python → npm

## Status

Decision

## Context

codemem currently ships as a Python package (`pip install codemem` / `uvx codemem`). The TypeScript port will ship as an npm package. During transition, users may have both installed. This document defines how the npm version interoperates with existing Python installations and how users upgrade.

Current Python version: `0.19.0`. Plugin pinned backend: `codemem==0.19.0`.

## Config Compatibility

### Path and format: identical

The npm version MUST read `~/.config/codemem/config.json` (and `.jsonc`) using the same resolution logic:

1. `CODEMEM_CONFIG` env var (if set)
2. `~/.config/codemem/config.json` (if exists)
3. `~/.config/codemem/config.jsonc` (if exists)
4. Default to `~/.config/codemem/config.json`

The npm version MUST support JSONC (comments, trailing commas) — the Python version already does via `_strip_json_comments` / `_strip_trailing_commas`.

### Field compatibility

All config keys from `OpencodeMemConfig` (see `codemem/config.py`) MUST be recognized by the npm version. The npm version MAY add new keys but MUST NOT remove or rename existing ones.

**Environment variable overrides:** The npm version MUST honor the same `CODEMEM_*` env vars with the same semantics (see `CONFIG_ENV_OVERRIDES` and `_apply_env` in `config.py`). Env vars override file config.

**Python-only fields the npm version can ignore (but must not reject):**

- `runner`, `runner_from`, `use_opencode_run` — these control `uvx`/`uv run` dispatch, irrelevant to npm
- `opencode_model`, `opencode_agent` — OpenCode-specific runner config

**New npm-only fields:** Any new config keys MUST use a distinct namespace or be additive. The Python version ignores unknown keys (it only processes keys matching `OpencodeMemConfig` attributes), so coexistence is safe.

### Config writes

Both runtimes write config via the viewer Settings UI. The npm version MUST use the same `json.dumps(data, indent=2)` equivalent format. Writes are whole-file replacements — no merge conflicts possible since only one process writes at a time (user-initiated saves).

## Database Compatibility

Reference: [DB Coexistence Contract](2026-03-15-db-coexistence-contract.md)

### Schema reuse: yes, with constraints

The npm version opens `~/.codemem/mem.sqlite` (or `CODEMEM_DB`) directly. No migration step is needed for read/write access.

**Phase 2 rules apply:**

- Python owns DDL (schema changes). The npm version validates schema on connect but does NOT run `CREATE TABLE`, `ALTER TABLE`, or modify triggers.
- npm reads `PRAGMA user_version` and checks against `MIN_COMPATIBLE_SCHEMA`. If too old, it exits with: `"Database schema version {v} is too old. Run the Python codemem CLI to upgrade."`
- npm sets identical connection pragmas: `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`, `synchronous=NORMAL`.

### sqlite-vec

Both runtimes must load sqlite-vec. The npm version uses `sqlite-vec` from npm (`@anthropic-ai/sqlite-vec` or equivalent). Both MUST pin the same sqlite-vec version — verify via `SELECT vec_version()` on startup.

### Pre-migration backup

On first npm access to the database, the npm version creates a one-time backup:
```
~/.codemem/backups/mem.sqlite.pre-ts-{ISO_DATE}
```
Controlled by a marker file `~/.codemem/.ts-first-access`.

### FTS5 triggers

FTS triggers fire at the SQLite engine level regardless of which runtime issued the DML. The npm version MUST NOT use `INSERT OR REPLACE` on `memory_items` — use `INSERT ... ON CONFLICT DO UPDATE` instead (see DB coexistence contract for rationale).

## Plugin Runner Transition

### Current plugin architecture

The OpenCode plugin (`.opencode/plugin/codemem.js`) resolves a CLI backend via:

1. `CODEMEM_RUNNER` env var → uses that runner (`uvx`, `uv`, or custom)
2. Dev mode detection → if `pyproject.toml` contains `name = "codemem"`, uses `uv run`
3. Default → `uvx codemem==0.19.0` (pinned to `PINNED_BACKEND_VERSION`)

The plugin shells out to the resolved runner for: `codemem ingest`, `codemem mcp`, `codemem pack`, `codemem serve`, `codemem stats`, `codemem recent`, `codemem enqueue-raw-event`, `codemem version`.

### PATH resolution during coexistence

If both Python (`uvx codemem`) and npm (`npx codemem`) are installed:

- **`uvx` path:** Always resolves to the Python version. The plugin's default runner is `uvx`, so existing installs continue using Python.
- **`npx` / global npm path:** Resolves to the npm version. A bare `codemem` on PATH depends on which was installed last / which is earlier in PATH.
- **No conflict by default:** The plugin explicitly uses `uvx` dispatch, not bare `codemem`. Users on the Python plugin will not accidentally pick up the npm version.

### Plugin migration strategy

The plugin itself is the natural migration point. When the npm version ships:

1. **New plugin version** updates `buildRunnerArgs` and `runCli` to handle `npx` dispatch correctly (currently only `uvx`/`uv` are wired — `npx` would produce `npx stats` instead of `npx codemem stats`). This plugin update MUST ship before users set `CODEMEM_RUNNER=npx`.
2. **`CODEMEM_RUNNER=npx`** serves as the opt-in during transition, but only after the plugin runner wiring is updated.
3. **`CODEMEM_RUNNER=uvx`** remains supported for users who want to stay on Python.
4. A future plugin release (after Python deprecation) removes `uvx` support and defaults to npm.

### Detection logic (recommended)

The plugin should detect which backend is available:

```javascript
async function detectBackend() {
  // 1. Explicit env var wins
  if (process.env.CODEMEM_RUNNER) return process.env.CODEMEM_RUNNER;

  // 2. Dev mode (pyproject.toml present)
  if (isDevMode(cwd)) return "uv";

  // 3. Try npm first (preferred after transition)
  try {
    const result = await exec(["npx", "codemem", "version"]);
    if (result.exitCode === 0) return "npx";
  } catch {}

  // 4. Fall back to uvx
  return "uvx";
}
```

This is deferred to the plugin release that ships npm support. The current plugin does not need changes until then.

### Claude Code plugin

The Claude Code marketplace plugin uses `uvx codemem==<version> mcp` for MCP server launch and `codemem ingest-claude-hook` / `codemem claude-hook-inject` for hook ingestion. The same runner transition strategy applies — update the hook scripts to resolve `npx codemem` when available.

## Upgrade Path

### Step-by-step: uvx → npm

```bash
# 1. Verify current install works
uvx codemem stats

# 2. Install npm version
npm install -g codemem
# or: use npx codemem (no global install needed)

# 3. Verify npm version reads existing data
npx codemem stats
# Should show the same memory counts as step 1

# 4. Switch the plugin runner (if using OpenCode)
# PREREQUISITE: The plugin's command builder must be updated to support
# npx dispatch first (currently .opencode/plugin/codemem.js only handles
# uvx/uv runner args). Do NOT set CODEMEM_RUNNER=npx until a plugin
# release that wires npx command building is published.
# When ready:
# export CODEMEM_RUNNER=npx

# 5. Restart OpenCode / Claude Code

# 6. Verify plugin uses npm backend
# Check plugin log (~/.codemem/plugin.log) for runner info

# 7. (Optional) Uninstall Python version
uv tool uninstall codemem
# or: pip uninstall codemem
```

### Verification checklist

After switching to npm:

- [ ] `npx codemem stats` shows expected memory counts
- [ ] `npx codemem search "recent work"` returns results
- [ ] `npx codemem serve` launches the viewer
- [ ] Plugin injects context on new sessions (check toast message)
- [ ] MCP tools (`mem-status`, `mem-recent`, `mem-stats`) work

### Rollback

If the npm version has issues:

```bash
# Revert runner
unset CODEMEM_RUNNER  # or set CODEMEM_RUNNER=uvx

# Restart OpenCode / Claude Code
# Python backend resumes immediately — same DB, same config
```

## Breaking Changes

### Intentional differences (npm vs Python)

| Area | Python | npm | Impact |
|------|--------|-----|--------|
| Runtime prerequisite | Python 3.11+ / uv | Node 22+ | Different install chain |
| Runner dispatch | `uvx codemem==X.Y.Z` | `npx codemem` or global | Plugin config change |
| Extension loading | `sqlite_vec.load(conn)` | `sqliteVec.load(db)` | Transparent to users |
| Observer runtime | `claude_sidecar` option uses Python subprocess | TBD — may drop `claude_sidecar` | Users on `claude_sidecar` must switch to `api_http` |

### CLI command parity

The npm version MUST support all CLI commands from the Python version at launch:

- `stats`, `recent`, `search`, `embed`, `serve`, `pack`, `mcp`, `version`
- `ingest`, `enqueue-raw-event`, `raw-events-status`
- `export-memories`, `import-memories`
- `sync` subcommands
- `install-mcp`, `install-plugin`
- `db prune-memories`

Any command not ported at launch MUST print a clear message: `"This command is not yet available in the npm version. Use uvx codemem <command> instead."`

### Config key changes: none

No config keys are renamed or removed. The npm version adds keys only.

### Default value changes: none planned

All defaults match the Python version. If any must change, document in release notes with migration instructions.

## Version Parity

### Recommendation: start fresh at 1.0.0

The npm package should start at `1.0.0`, not `0.19.x`. Rationale:

1. **Clean semver signal.** `1.0.0` communicates "stable, ready for production" to npm users who have no context on the Python version history.
2. **Avoid confusion.** If the npm package is `0.19.0`, users may think it's the same release as the Python `0.19.0` — but the codebases will diverge immediately.
3. **Independent versioning.** The two packages have different release cadences once the port ships. Coupled version numbers create false expectations.

The npm `1.0.0` release notes should state: "Port of Python codemem 0.19.x. Full database and config compatibility."

### Plugin version pinning

The OpenCode plugin pins `PINNED_BACKEND_VERSION` to a specific backend version. During transition, this pin must specify which runtime:

```javascript
const PINNED_BACKEND_VERSION = "1.0.0";          // npm version
const PINNED_PYTHON_BACKEND_VERSION = "0.19.0";  // fallback
```

## Deprecation Strategy

### Timeline

1. **T+0:** npm `1.0.0` ships. Python `0.19.x` continues to work. Plugin defaults to `uvx` runner.
2. **T+2 weeks:** Plugin update defaults to `npx` runner (with `uvx` fallback). Release notes announce Python deprecation timeline.
3. **T+1 month:** Publish Python `0.20.0` — a thin deprecation release (see below).
4. **T+3 months:** Remove Python package from active support. PyPI package remains installable but unmaintained.

### Deprecation release (Python 0.20.0)

Publish a final Python version that:

1. **Prints a deprecation notice on every CLI invocation:**
   ```
   ⚠️  codemem has moved to npm. Install with: npm install -g codemem
       This Python version (0.20.0) will not receive further updates.
       Your data and config will work unchanged with the npm version.
   ```
2. **Still works normally** — all commands function. The notice is informational, not blocking.
3. **Adds `CODEMEM_SUPPRESS_DEPRECATION=1`** env var to silence the notice (for CI, scripts).

This approach is better than publishing a broken/stub package — users who depend on the Python version for automation should not be broken by the deprecation notice.

### PyPI package metadata

Update the Python package's PyPI description and README to redirect:

```
⚠️ This package has been superseded by the npm version.
Install: npm install -g codemem
Docs: https://github.com/kunickiaj/codemem
```

### Communication channels

- GitHub release notes for both the npm `1.0.0` and Python `0.20.0` releases
- README.md update (this repo) — update Quick Start to show npm install path
- OpenCode plugin marketplace description update

## Open Questions

1. **npm package name.** Is `codemem` available on npm? If not, use `@kunickiaj/codemem` or similar scoped name. This affects all `npx` commands in this document.

2. **Node version floor.** Node 22+ for `node:sqlite`? Or Node 18+ with `better-sqlite3`? This affects the install prerequisites section. (See DB coexistence contract, open question 5.)

3. **`claude_sidecar` observer runtime.** The Python version supports shelling out to `claude` CLI for observation. Does the npm version support this, or do we drop it and require `api_http`? Affects users who rely on Claude CLI for observer inference.

4. **Sync daemon.** The Python version has `codemem sync daemon` which runs as a long-lived process. Does the npm version reimplement this, or defer it? Sync is a significant surface area.

5. **Viewer embedding.** The Python viewer is embedded in `codemem/viewer.py` as inline HTML. The npm version likely serves static files differently. Is the viewer ported in the initial npm release, or deferred?

6. **Plugin ecosystem.** Both OpenCode (`.opencode/plugin/`) and Claude Code (`.Claude/plugin/`) plugins exist. Do both get updated simultaneously, or is one prioritized?
