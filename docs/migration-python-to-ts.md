# Migration: Python to TypeScript backend

> **Status: Complete.** The TypeScript backend is the primary and only shipped runtime
> as of `0.20.x`. The legacy Python backend has been removed from `main`; use git
> history or the archive ref if you need the old implementation for reference.

## Background

codemem originally used a Python backend (`uvx codemem`). The TS backend
(`codemem` npm package) reached full feature parity and is now the sole shipped path.

## Database compatibility

Both backends share `~/.codemem/mem.sqlite`. The TS backend owns schema initialization
and migrations. If you previously ran the Python backend, the TS runtime handles the
existing database seamlessly — no manual migration is needed.

## Environment variables

| Variable | Purpose |
|---|---|
| `CODEMEM_DB` | Database path |
| `CODEMEM_DEVICE_ID` | Device identity |
| `CODEMEM_ACTOR_ID` | Actor identity |

## Migration history

| Stage | Status |
|---|---|
| Stage 1: Opt-in TS via `CODEMEM_RUNNER=npx` | Complete |
| Stage 2: TS as default runner | Complete |
| Stage 3: Python removal from release path | Complete (`0.20.x`) |
