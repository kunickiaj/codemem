# Stream-Only Rollout + Remaining Work Plan

This plan covers what you (operator) need to do to roll out stream-only mode in OpenCode, and what remains for me to implement afterward.

## Goal

Run opencode-mem in "stream now, flush later" mode:

- JS plugin streams events immediately to Python (viewer daemon) via HTTP.
- Python persists raw events durably and decides when to flush/extract.
- Flushing is idempotent (retries do not duplicate artifacts/memories).
- Backlog/health is visible via CLI and the viewer Diagnostics panel.

## What You Need To Do (Rollout Steps)

### 1) Set environment variables

Set these in the environment used to launch OpenCode (shell profile, systemd, whatever OpenCode inherits):

```bash
export OPENCODE_MEM_DISABLE_CLI_INGEST=1
export OPENCODE_MEM_RAW_EVENTS_AUTO_FLUSH=1
export OPENCODE_MEM_RAW_EVENTS_DEBOUNCE_MS=60000
export OPENCODE_MEM_RAW_EVENTS_SWEEPER=1
export OPENCODE_MEM_RAW_EVENTS_SWEEPER_IDLE_MS=120000

# Optional retention (example: 7 days)
# export OPENCODE_MEM_RAW_EVENTS_RETENTION_MS=$((7*24*60*60*1000))
```

Notes:
- `OPENCODE_MEM_DISABLE_CLI_INGEST=1` makes the plugin stop spawning `opencode-mem ingest`.
- Auto-flush + sweeper together prevent reliance on OpenCode idle/session_end semantics.

### 2) Restart OpenCode

Restart OpenCode so the plugin reloads with the new env.

### 3) Run a small validation session

In an OpenCode session:

- do a few tool calls (`read`, `bash`, edits, etc.)
- wait ~60s idle (or whatever debounce you set)

### 4) Verify backlog stays near zero

CLI:

```bash
uv run opencode-mem raw-events-status
```

If it shows error batches for a session (`batches=error:N`), retry them:

```bash
uv run opencode-mem raw-events-retry <opencode_session_id>
```

Viewer:

- open viewer
- open `Diagnostics` panel (toggle)
- verify it shows either no pending raw events or that pending drains shortly after idle

Expected:

- Pending events rise during activity, then drop to ~0 after debounce/idle.
- Sweeper should cover cases where idle markers never arrive.

## What I Still Need To Do (Remaining Engineering Tasks)

### A) Stuck-batch recovery (recommended)

Problem:

- If an observer/extraction attempt fails, a flush batch can end up marked `error`.
- Today: it won't automatically recover in a visible/controlled way.

Work to implement:

- Extend raw event backlog status (CLI + API) to show batch state counts per session:
  - `started`, `completed`, `error`
- Add CLI support to retry failed batches:
  - `opencode-mem raw-events-retry --session <id> [--only-error] [--limit]`
- Add a safe policy for `started` but stuck batches:
  - treat as stuck if `updated_at` older than N minutes and mark `error` or re-run
- Add unit tests covering:
  - error batch is retryable without duplication
  - stuck batch detection doesn't spam retries

Decision needed from you:

- Retry policy: `auto-retry` (sweeper retries error batches with backoff) vs `manual-retry`.

### B) Operational metrics / regression checks (recommended)

Work to implement:

- Add a small CLI report to compare pre/post rollouts:
  - raw event backlog size over time
  - flush frequency
  - observer token usage distribution
  - tags coverage
  - session_summary length distribution

### C) Optional improvements (only if you feel pain)

- Pack quality:
  - improve ranking/diversity using `tags_text`
  - avoid same-y pack composition (dedupe near-identical titles/bodies)
- More evidence shaping:
  - dedupe repetitive tool events before observer
  - stronger truncation/structuring for long tool outputs
- Default retention recommendation:
  - decide a default `OPENCODE_MEM_RAW_EVENTS_RETENTION_MS` guidance to prevent unbounded growth

## Current Status (already implemented)

Reliability / stream-only architecture:

- Raw events table + idempotent insert
- Viewer endpoint `POST /api/raw-events`
- Auto-flush (debounce in Python), plus sweeper for idle-marker-missing sessions
- Retention support for raw events
- Batch idempotency (flush batches), session mapping reuse
- Artifact/memory/session_summary dedupe on retries
- Backlog visibility:
  - CLI `opencode-mem raw-events-status`
  - viewer `/api/raw-events/status`
  - viewer Diagnostics panel (hidden by default toggle)

Memory usefulness:

- tags_text derivation + backfill command
- observer prompt tightened + `<skip_summary>` guidance
- strip `<private>...</private>` from stored text
- compact `read` tool output before observer to reduce cost/noise
- avoid ingesting internal memory retrieval tools (prevents feedback loops)

## After You Roll Out

Send me:

- output of `uv run opencode-mem raw-events-status`
- whether backlog drains as expected
- any examples of stuck flushes / large backlogs

Then I'll implement stuck-batch recovery and any follow-ups you want.
