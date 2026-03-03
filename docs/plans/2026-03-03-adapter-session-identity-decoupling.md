# Decouple Adapter Session Identity from OpenCode Stream Semantics

**Bead:** codemem-afm.9
**Status:** Design
**Date:** 2026-03-03

## Problem

The raw-event queue and flush pipeline use `opencode_session_id` as the universal session key across all adapter sources. Claude sessions are stored with a synthetic `"claude:{uuid}"` value in that column — a prefix hack that conflates adapter source with session identity.

This causes:

- **Naming lies**: every function signature, column name, and variable says "opencode" when it means "any adapter stream"
- **Implicit source encoding**: the `"claude:"` prefix is the only way to distinguish adapter sources, requiring string parsing instead of a queryable column
- **Inconsistent convention**: OpenCode sessions use bare `"ses_*"` IDs with no prefix; Claude sessions are prefixed — no reason for the asymmetry when source is known

## Design

### Core change

1. Add explicit `source TEXT NOT NULL` and native `stream_id` identity across raw-event tables.
2. Use compound identity `(source, stream_id)` for all queue, flush, and stream-session operations.
3. Strip `"claude:"` prefix from existing Claude stream IDs during migration; store native UUID in `stream_id` and adapter in `source`.
4. Keep compatibility aliases for legacy `opencode_session_id` CLI/API inputs during transition.
5. Defer broad naming cleanup (column/table/function rename) to a second pass in `codemem-afm.11`.

### Rollout strategy

#### Phase 1 (this bead): identity decoupling with compatibility

- Introduce `source + stream_id` as canonical identity.
- Preserve runtime compatibility for legacy call sites and CLI arguments.
- Keep user-facing behavior stable while eliminating prefix-based source encoding.

#### Phase 2 (follow-up): naming cleanup

- Rename `opencode_session_id` references to adapter-neutral names in schema/code/docs.
- Rename `opencode_sessions` table to `stream_sessions` where it is operationally safe.
- Drop legacy compatibility aliases after one release window.

### Naming convention

| Adapter  | `source`    | `stream_id`              |
|----------|-------------|--------------------------|
| OpenCode | `opencode`  | `ses_abc123`             |
| Claude   | `claude`    | `b0be3bdc-d292-4e17-...` |
| Cursor   | `cursor`    | (whatever native ID)     |
| Codex    | `codex`     | (whatever native ID)     |

The `stream_id` is always the adapter's native session identifier. No prefixing.

### Schema migration

SQLite supports `RENAME COLUMN`, but this migration changes identity constraints and ON CONFLICT behavior.
To avoid partial constraint drift, recreate all identity tables and copy data in one transaction.

**Table recreation (identity + constraint updates):**

```sql
-- raw_events: compound stream identity and uniqueness
CREATE TABLE raw_events_new (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'opencode',
    stream_id TEXT NOT NULL,
    event_id TEXT,
    event_seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    ts_wall_ms INTEGER,
    ts_mono_ms REAL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(source, stream_id, event_seq),
    UNIQUE(source, stream_id, event_id)
);

INSERT INTO raw_events_new
SELECT
    id,
    CASE WHEN opencode_session_id LIKE 'claude:%' THEN 'claude' ELSE 'opencode' END,
    CASE WHEN opencode_session_id LIKE 'claude:%' THEN SUBSTR(opencode_session_id, 8) ELSE opencode_session_id END,
    event_id, event_seq, event_type, ts_wall_ms, ts_mono_ms, payload_json, created_at
FROM raw_events;

DROP TABLE raw_events;
ALTER TABLE raw_events_new RENAME TO raw_events;
CREATE INDEX idx_raw_events_source_stream_seq ON raw_events(source, stream_id, event_seq);

-- raw_event_sessions: (source, stream_id) compound PK
CREATE TABLE raw_event_sessions_new (
    source TEXT NOT NULL DEFAULT 'opencode',
    stream_id TEXT NOT NULL,
    cwd TEXT,
    project TEXT,
    started_at TEXT,
    last_seen_ts_wall_ms INTEGER,
    last_received_event_seq INTEGER NOT NULL DEFAULT -1,
    last_flushed_event_seq INTEGER NOT NULL DEFAULT -1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source, stream_id)
);

INSERT INTO raw_event_sessions_new
    SELECT
        CASE WHEN opencode_session_id LIKE 'claude:%' THEN 'claude' ELSE 'opencode' END,
        CASE WHEN opencode_session_id LIKE 'claude:%' THEN SUBSTR(opencode_session_id, 8) ELSE opencode_session_id END,
        cwd, project, started_at, last_seen_ts_wall_ms,
        last_received_event_seq, last_flushed_event_seq, updated_at
    FROM raw_event_sessions;

DROP TABLE raw_event_sessions;
ALTER TABLE raw_event_sessions_new RENAME TO raw_event_sessions;

-- raw_event_flush_batches: compound stream identity
CREATE TABLE raw_event_flush_batches_new (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'opencode',
    stream_id TEXT NOT NULL,
    start_event_seq INTEGER NOT NULL,
    end_event_seq INTEGER NOT NULL,
    extractor_version TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(source, stream_id, start_event_seq, end_event_seq, extractor_version)
);

INSERT INTO raw_event_flush_batches_new
SELECT
    id,
    CASE WHEN opencode_session_id LIKE 'claude:%' THEN 'claude' ELSE 'opencode' END,
    CASE WHEN opencode_session_id LIKE 'claude:%' THEN SUBSTR(opencode_session_id, 8) ELSE opencode_session_id END,
    start_event_seq, end_event_seq, extractor_version, status, created_at, updated_at, COALESCE(attempt_count, 0)
FROM raw_event_flush_batches;

DROP TABLE raw_event_flush_batches;
ALTER TABLE raw_event_flush_batches_new RENAME TO raw_event_flush_batches;
CREATE INDEX idx_raw_event_flush_batches_source_stream
    ON raw_event_flush_batches(source, stream_id, created_at DESC);

-- opencode_sessions → stream_sessions
CREATE TABLE stream_sessions (
    source TEXT NOT NULL DEFAULT 'opencode',
    stream_id TEXT NOT NULL,
    session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (source, stream_id)
);

INSERT INTO stream_sessions
    SELECT
        CASE WHEN opencode_session_id LIKE 'claude:%' THEN 'claude' ELSE 'opencode' END,
        CASE WHEN opencode_session_id LIKE 'claude:%' THEN SUBSTR(opencode_session_id, 8) ELSE opencode_session_id END,
        session_id, created_at
    FROM opencode_sessions;

DROP TABLE opencode_sessions;
CREATE INDEX idx_stream_sessions_session_id ON stream_sessions(session_id);
```

### API / function signature changes

`flush_raw_events` becomes:

```python
def flush_raw_events(
    store: MemoryStore,
    *,
    source: str,
    stream_id: str,
    cwd: str | None,
    project: str | None,
    started_at: str | None,
    max_events: int | None = None,
) -> dict[str, int]:
```

Callers pass `source` explicitly:

- **OpenCode adapter** (viewer API / CLI fallback): `source="opencode"`
- **Claude hooks** (`claude_integration_cmds.py`): `source="claude"`
- **CLI `flush-raw-events`**: accepts `--source` flag, defaults to `"opencode"`; legacy `opencode_session_id` args remain accepted as aliases.
- **Sweeper / idle worker**: reads `source` from `raw_event_sessions` row

The `_adapter_stream_id` function in `claude_integration_cmds.py` stops prepending the source:

```python
# Before
def _adapter_stream_id(*, source: str, session_id: str, cwd: str | None) -> str:
    return f"{source}:{session_id}"

# After — just returns the native ID
def _adapter_stream_id(*, source: str, session_id: str, cwd: str | None) -> str:
    return session_id
```

Session context passed into `ingest()`:

```python
session_context["source"] = source
session_context["stream_id"] = stream_id
```

Store methods (`get_or_create_opencode_session`, `record_raw_event`, etc.) take `(source, stream_id)` as canonical identity. Legacy wrappers can map old signatures during Phase 1.

### Code rename scope

~230 references to `opencode_session_id` across:

- `codemem/store/raw_events.py` — bulk of store operations
- `codemem/store/_store.py` — MemoryStore facade methods
- `codemem/store/maintenance.py` — discovery tokens, project backfill
- `codemem/raw_event_flush.py` — flush orchestration
- `codemem/plugin_ingest.py` — ingest entry point, session creation
- `codemem/commands/claude_integration_cmds.py` — Claude hook adapter
- `codemem/cli_app.py` — CLI commands
- `codemem/viewer_raw_events.py` — viewer API
- `tests/` — test fixtures and assertions

Do not do a global mechanical rename in Phase 1. First add canonical `(source, stream_id)` paths and compatibility adapters, then rename in Phase 2.

## Scope boundaries

**In scope:**
- Canonical `(source, stream_id)` identity across raw-event tables and store APIs
- Table recreation for identity/constraint updates (`raw_events`, `raw_event_sessions`, `raw_event_flush_batches`, mapping table)
- Claude prefix stripping + data migration
- Function signatures: `flush_raw_events`, store methods, ingest (with compatibility aliases)
- Index/unique recreation with compound keys

**Out of scope (separate beads):**
- Observer isolation / UUID bleed fix — codemem-afm.10
- Observer provider resolution decoupling — codemem-afm.10
- Full CLI/docs naming cleanup (`raw-events-status`, args/help text) — codemem-afm.11
- Viewer API response format changes — follow-up
- `_adapter` envelope format — already has `source` field, untouched

## Migration risk

- **Data loss**: low if migration runs in one transaction with copy-then-swap table recreation.
- **Rollback**: require pre-migration DB backup and schema gate; rollback is restore-from-backup.
- **Concurrent access**: migration must run with viewer/sweeper stopped to avoid mid-copy writes.
- **Constraint drift**: avoided by recreating tables instead of partial ALTER + index patching.

## Required migration tests

1. **Cross-source uniqueness**: same `event_id` and `event_seq` can exist for different sources without collision.
2. **Batch uniqueness**: `(source, stream_id, start_event_seq, end_event_seq, extractor_version)` conflict behavior matches pre-migration semantics.
3. **Prefix migration**: `claude:{uuid}` rows migrate to `(source='claude', stream_id='{uuid}')` in all identity tables.
4. **Legacy compatibility**: old CLI/API input names still function and map to canonical `(source, stream_id)`.
5. **Mixed-source flush**: OpenCode and Claude streams flush independently with no identity bleed.
