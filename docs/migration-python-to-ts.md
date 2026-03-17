# Migration: Python to TypeScript backend

## Overview

codemem is migrating from a Python backend (`uvx codemem`) to a TypeScript backend
(`npx @codemem/cli`). Both backends share the same SQLite database.

## How to switch

### Using npx (recommended)

```bash
export CODEMEM_RUNNER=npx
```

This runs the TS CLI via `npx @codemem/cli`. No global install required.

### Using a global install

```bash
npm install -g @codemem/cli
export CODEMEM_RUNNER=node
export CODEMEM_RUNNER_FROM=$(which codemem)
```

### Using a local repo (dev mode)

```bash
export CODEMEM_RUNNER=node
export CODEMEM_RUNNER_FROM=/path/to/codemem
```

Requires `pnpm build` in the repo first.

### Switching back to Python

```bash
export CODEMEM_RUNNER=uvx
# or unset CODEMEM_RUNNER
```

## Database compatibility

Both backends share `~/.codemem/mem.sqlite`. The coexistence contract:

- **Schema ownership**: Python currently owns DDL (schema migrations). TS validates
  but does not create or migrate tables.
- **Additive tolerance**: TS tolerates newer schema versions from Python.
- **Backup on first TS access**: The TS runtime creates a timestamped backup
  (`mem.sqlite.pre-ts-YYYYMMDDTHHMMSS.bak`) before its first write.
- **Required tables**: TS hard-fails if required tables are missing, with clear
  messages pointing to the Python runtime for initialization.

## Environment variables

| Variable | Purpose |
|---|---|
| `CODEMEM_RUNNER` | Backend runner: `uvx` (default), `uv`, `node`, `npx` |
| `CODEMEM_RUNNER_FROM` | Runner source path/package override |
| `CODEMEM_DB` | Database path (shared by both backends) |
| `CODEMEM_DEVICE_ID` | Device identity (shared) |
| `CODEMEM_ACTOR_ID` | Actor identity (shared) |

## Staged rollout

### Stage 1: Opt-in (current)

Python is the default. Users opt in to TS via `CODEMEM_RUNNER=npx`.

### Stage 2: TS as default

Plugin default runner switches from `uvx` to `npx`. Python still available
via `CODEMEM_RUNNER=uvx`.

### Stage 3: Python removal

Python backend, `pyproject.toml`, and `uv`/`uvx` runner paths removed.

## Known gaps (TS vs Python)

| Area | Status |
|---|---|
| Core CRUD, search, pack | Complete |
| MCP server (13 tools) | Complete |
| CLI (stats, search, pack, serve, mcp) | Complete |
| Viewer server (all routes) | Complete |
| Raw event sweeper (background ingest) | Complete |
| POST /api/raw-events | Complete |
| Config read | Complete |
| Config write + runtime effects | Not yet ported |
| Schema initialization (DDL) | Python-only |
| `/api/claude-hooks` ingestion | Not yet ported |

## Rollback

If issues arise with the TS backend:

1. Set `CODEMEM_RUNNER=uvx` to return to Python
2. Restore the database backup if needed:
   ```bash
   cp ~/.codemem/mem.sqlite.pre-ts-*.bak ~/.codemem/mem.sqlite
   ```
