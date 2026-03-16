# DB Coexistence Contract: Python/TS Migration

**Status:** Reviewed — prerequisites identified  
**Date:** 2026-03-15  
**Reviewed:** 2026-03-15 (CodeReviewer: 4 must-fix, 4 should-fix)

## Context

codemem stores all data in a single SQLite database (default: `~/.codemem/mem.sqlite`). During the incremental Python → TypeScript migration (Phases 2–4), both runtimes will coexist for months — a user might run the Python viewer alongside a TS MCP server, or vice versa. This document defines the rules for how two runtimes safely share the database.

### Current state (Python-only)

- **Schema version:** `PRAGMA user_version = 6` (`SCHEMA_VERSION = 6` in `codemem/db.py`)
- **Connection setup:** WAL mode, `busy_timeout = 5000ms`, `synchronous = NORMAL`, `foreign_keys = ON`
- **Schema init:** `initialize_schema()` runs on every `MemoryStore.__init__` — idempotent DDL via `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `_ensure_column` (adds columns only if missing)
- **FTS5:** `memory_fts` virtual table with `AFTER INSERT/UPDATE/DELETE` triggers on `memory_items` for content sync
- **sqlite-vec:** loaded via `sqlite_vec.load(conn)` on every connection; `memory_vectors` is a `vec0` virtual table
- **No migration history table** — schema versioning is a single integer (`user_version` pragma)

## Principles

These rules apply across all migration phases. They are not negotiable.

1. **Single writer for DDL.** At any point in time, exactly one runtime owns schema changes (CREATE TABLE, ALTER TABLE, DROP, CREATE INDEX, CREATE TRIGGER). The other runtime must treat the schema as read-only structure it did not create.

2. **Both runtimes may DML.** Both Python and TS may INSERT, UPDATE, DELETE data rows at any time. WAL mode supports this (see Concurrency Model).

3. **Schema must be forward-compatible.** The DDL-owning runtime must not make changes that break the non-owning runtime. Concretely: no column renames, no column removals, no type changes to existing columns. Additive-only changes (new columns with defaults, new tables, new indexes).

4. **Startup must be safe against the other runtime.** A runtime that opens the DB must tolerate schema versions it doesn't recognize, as long as the tables it needs exist. It must not crash or corrupt data when `user_version` is higher than expected.

5. **FTS triggers are schema, not data.** They are defined by DDL. The non-DDL-owning runtime must not recreate or modify them. Since triggers fire at the SQLite engine level (not application level), they work correctly regardless of which runtime issued the DML.

6. **No implicit VACUUM or destructive maintenance.** Neither runtime should run `VACUUM`, `REINDEX`, or table-rebuild operations without explicit user action. These operations require exclusive locks and would block the other runtime.

## Phase Rules

### Phase 1: Python owns everything (current state)

- **DDL owner:** Python
- **TS runtime:** Does not exist yet
- **Schema version:** 6
- No coexistence concerns

### Phase 2: TS MCP server introduced, Python still primary

- **DDL owner:** Python
- **TS runtime role:** DML-only (reads and writes data). The TS MCP server opens the database but does NOT call `initialize_schema()` or any equivalent. It validates that the schema it needs exists (tables, columns) and fails fast with a clear error if not.
- **Schema version tracking:** Python continues to set `user_version`. TS reads `user_version` on startup and checks it against a `MIN_COMPATIBLE_SCHEMA` constant. If `user_version < MIN_COMPATIBLE_SCHEMA`, TS refuses to start with a message like: `"Database schema version {v} is too old. Run the Python codemem CLI to upgrade."`
- **TS schema validation on connect:** TS runs read-only checks (PRAGMA table_info, sqlite_master queries) to confirm required tables and columns exist. No DDL.
- **New tables for TS-only features:** If the TS port needs a table that Python doesn't have, Python's `initialize_schema()` must create it first (coordinated via a shared schema spec). TS does not create tables.

### Phase 3: TS becomes primary, Python viewer still active

- **DDL owner:** TypeScript
- **Python role:** DML-only (the viewer reads data, may write usage events). Python's `initialize_schema()` is disabled or guarded — on startup it checks `user_version` and if it's ≥ the TS-managed threshold, it skips all DDL and only validates.
- **Schema version tracking:** TS sets `user_version`. Python reads it and checks `user_version >= KNOWN_MIN_VERSION`. If the version is unrecognized but tables exist, Python proceeds in read-only-schema mode.
- **Migration responsibility:** TS now runs schema migrations.

### Phase 4: Python runtime retired

- **DDL owner:** TypeScript
- **Python runtime:** Removed from the codebase
- **Cleanup:** TS may now perform non-additive schema changes (column renames, table consolidation) since there is no second runtime to break.

### Phase transition trigger

The transition from Phase 2 → Phase 3 is a **flag day in a release**, not gradual. A specific codemem release version marks the boundary:

- The release notes state: "Schema ownership transfers to TypeScript in this version."
- Python's `initialize_schema()` gains a guard: if `user_version >= PHASE3_MIN_VERSION`, skip DDL.
- TS's schema init gains DDL authority.
- Both changes ship in the same release.

## Schema Version Strategy

### Current approach: insufficient for two runtimes

The current `PRAGMA user_version` integer tells you *what version the schema is at* but not *who set it* or *what migrations ran*. With two runtimes, we need to know:

1. Is the schema at a version this runtime understands?
2. Did the other runtime advance the schema past what this runtime expects?

### Recommended approach: version ranges + compatibility constant

Each runtime defines two constants:

```
# Python
SCHEMA_VERSION = 8          # Version this runtime sets after running its migrations
MIN_COMPATIBLE_SCHEMA = 6   # Oldest schema version this runtime can operate against

# TypeScript
SCHEMA_VERSION = 8          # Same target — both runtimes agree on the current version
MIN_COMPATIBLE_SCHEMA = 6   # Same floor during coexistence
```

**Startup logic for the DDL-owning runtime:**

```
current = PRAGMA user_version
if current < SCHEMA_VERSION:
    run_migrations(current, SCHEMA_VERSION)
    PRAGMA user_version = SCHEMA_VERSION
```

**Startup logic for the non-DDL-owning runtime:**

```
current = PRAGMA user_version
if current < MIN_COMPATIBLE_SCHEMA:
    abort("Schema too old. Run [other runtime] to upgrade.")
if current > MAX_KNOWN_SCHEMA:
    warn("Schema newer than expected. Proceeding in compatibility mode.")
validate_required_tables_and_columns()
```

### Migration history table: not required yet

A full `schema_migrations` table (recording each migration with timestamp, runtime, direction) is useful for debugging but adds complexity. **Defer this to Phase 3.** During Phase 2, the single `user_version` integer is sufficient because Python is the only DDL runner.

If introduced later:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    applied_by TEXT NOT NULL,  -- 'python' or 'typescript'
    description TEXT
);
```

## Concurrency Model

### WAL mode

Both runtimes use WAL mode. This is the correct choice for coexistence.

**WAL concurrency guarantees (SQLite docs):**
- Multiple readers can operate concurrently with a single writer
- Writers do not block readers
- Readers do not block writers
- Only one writer can hold the write lock at a time; other writers get SQLITE_BUSY

### Busy timeout

Python sets `busy_timeout = 5000` (5 seconds). **The TS runtime must set the same or a higher value.** Recommendation: both use 5000ms.

When a write is attempted and another process holds the write lock, SQLite will retry for up to `busy_timeout` milliseconds before returning SQLITE_BUSY. With both runtimes writing, this timeout must be generous enough to survive the other runtime's longest transaction.

**Rule:** No transaction should hold the write lock for more than 1 second. Batch operations (bulk inserts, table rebuilds) must use chunked transactions or accept that they may temporarily block the other runtime.

### Write conflicts in practice

Typical coexistence scenario: Python viewer reads data and writes `usage_events`; TS MCP server reads and writes `memory_items`, `sessions`, `raw_events`.

Write conflicts are rare because:
- The runtimes write to mostly different tables
- Individual writes are fast (single-row INSERTs)
- WAL mode serializes writers transparently — the second writer waits, it doesn't fail (within `busy_timeout`)

**When SQLITE_BUSY occurs:** The application must retry. Both runtimes should wrap writes in retry logic:

```
max_retries = 3
for attempt in range(max_retries):
    try:
        execute_write()
        break
    except SQLITE_BUSY:
        if attempt == max_retries - 1:
            raise
        sleep(0.1 * (attempt + 1))
```

### Extension loading: sqlite-vec

Both runtimes must load the sqlite-vec extension to query `memory_vectors` (a `vec0` virtual table).

- Python: `sqlite_vec.load(conn)` — loads the extension into the Python process's connection
- Node/TS: `sqliteVec.load(db)` — loads the extension into the Node process's connection

**No conflict.** Extension loading is per-connection, per-process. Two processes can both have sqlite-vec loaded simultaneously without issues. The extension registers virtual table modules and functions (like `vec_version()`) in each connection's namespace independently.

**Caveat:** Both runtimes must use compatible sqlite-vec versions. If Python uses sqlite-vec 0.1.6 and TS uses 0.1.2, the `vec0` table format might differ. **Pin sqlite-vec to the same version in both runtimes' dependency specs.** Document the pinned version in a shared location (e.g., a `db-compat.json` or in the repo's top-level README).

### Connection pragmas: must match

Both runtimes must set identical connection pragmas. Mismatched pragmas cause subtle bugs:

| Pragma | Required value | Why |
|---|---|---|
| `journal_mode` | `WAL` | Concurrent access requires WAL |
| `busy_timeout` | `5000` | Must match to avoid asymmetric retry behavior |
| `foreign_keys` | `ON` | Both runtimes must enforce FK constraints |
| `synchronous` | `NORMAL` | Consistent durability guarantees |

**Enforce this in code:** Both runtimes should have a `connect()` function that sets all four pragmas. This function should be tested.

## Migration Execution Rules

### Who runs DDL

| Phase | DDL owner | Non-DDL runtime behavior |
|---|---|---|
| 1 | Python | (no TS runtime) |
| 2 | Python | TS validates schema, DML only |
| 3 | TypeScript | Python validates schema, DML only |
| 4 | TypeScript | (no Python runtime) |

### Race condition: two processes start simultaneously

Scenario: User starts both the Python CLI and the TS MCP server at the same time. Python tries to run `initialize_schema()` while TS is connecting.

**This is safe because:**
1. Only the DDL-owning runtime runs migrations.
2. SQLite's write lock serializes DDL operations — even if two Python processes start simultaneously, one waits for the other.
3. The non-DDL runtime only runs read-only validation queries.

### Race condition: DDL owner upgrades schema while non-DDL runtime is active

Scenario: TS MCP server is running. User runs `codemem stats`, which triggers Python's `initialize_schema()`, advancing `user_version` from 6 to 7. The TS MCP server was validated against version 6.

**This is safe because:**
1. Schema changes are additive-only (Principle 3). New columns have defaults, so existing queries still work.
2. New tables are ignored by the runtime that doesn't know about them.
3. New indexes are invisible to query logic (they help the optimizer but don't change results).
4. The TS runtime continues operating with its validated schema view.

**Edge case:** If the DDL owner adds a NOT NULL column without a default, existing INSERTs from the non-DDL runtime will fail. **This is a violation of Principle 3 and must not happen.**

### FTS5 triggers during coexistence

FTS5 content sync triggers (`memory_items_ai`, `memory_items_au`, `memory_items_ad`) are created by `_initialize_schema_v1()` in Python. They are stored in the database schema (sqlite_master), not in application memory.

**Key insight:** Triggers fire at the SQLite engine level. When the TS runtime INSERTs a row into `memory_items`, the `memory_items_ai` trigger fires and updates `memory_fts` — even though the TS runtime didn't create the trigger. This is standard SQLite behavior.

**Requirements:**
- The TS runtime must NOT recreate or modify these triggers (they are DDL, owned by Python in Phase 2)
- The TS runtime's INSERT/UPDATE/DELETE statements on `memory_items` must provide all columns referenced by the triggers (`title`, `body_text`, `tags_text`) — which they will, since these are NOT NULL or have defaults
- The TS runtime must NOT use `INSERT OR REPLACE` on `memory_items`. With SQLite's default `PRAGMA recursive_triggers=OFF`, the implicit DELETE done by REPLACE does not fire `AFTER DELETE` triggers, so `memory_items_ad` won't run — leaving stale terms in `memory_fts` and corrupting search results. Use `INSERT ... ON CONFLICT DO UPDATE` instead, which fires the `AFTER UPDATE` trigger correctly.

**Testing:** The parity test corpus should include a test case where TS inserts a memory and Python verifies the FTS index includes it.

## Rollback and Recovery

### Pre-migration backup

Before the TS runtime first opens a database, it should create a one-time backup:

```
~/.codemem/mem.sqlite → ~/.codemem/backups/mem.sqlite.pre-ts-{ISO_DATE}
```

**Implementation:** The TS `connect()` function checks for a marker file (`~/.codemem/.ts-first-access`). If the marker doesn't exist:

1. Copy `mem.sqlite`, `mem.sqlite-wal`, `mem.sqlite-shm` to the backup directory
2. Write the marker file
3. Proceed with normal connection

This is a one-time cost. The backup allows full rollback to the pre-TS state if the TS port corrupts data.

### Runtime-level rollback

If a TS bug corrupts data (e.g., wrong values in `memory_items`, broken FTS sync):

1. **Stop the TS runtime**
2. **Assess damage:** Run `codemem stats` (Python) to check memory counts, FTS integrity
3. **If FTS is desynced:** Run `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')` — this is a standard FTS5 rebuild command
4. **If data rows are corrupted:** Restore from the pre-TS backup or from a regular backup
5. **If the vec0 table is corrupted:** Drop and rebuild `memory_vectors` (embeddings can be regenerated)

### WAL checkpoint safety

If one runtime crashes mid-write, the WAL file may contain uncommitted data. SQLite's WAL recovery is automatic: the next connection that opens the database will replay committed transactions from the WAL and discard uncommitted ones. **No special handling needed.**

### Schema rollback

If a DDL migration needs to be reverted:

- SQLite does not support `ALTER TABLE DROP COLUMN` (before 3.35.0) or transactional DDL rollback for some operations
- **Preferred approach:** Ship a new migration that is the inverse (add column back, recreate dropped index)
- **Nuclear option:** Restore from backup

## Testing Requirements

### 1. Schema validation tests

Both runtimes must have tests that verify:
- The expected tables exist
- Required columns exist with correct types
- Required indexes exist
- Required triggers exist
- `user_version` is within the expected range

### 2. Cross-runtime DML parity

Using the parity test corpus:
- Python inserts a set of memories → TS reads them and gets identical results
- TS inserts a set of memories → Python reads them and gets identical results
- Both insert memories → both can search/recall all of them via FTS and semantic search

### 3. FTS trigger verification

- TS inserts a memory into `memory_items`
- Verify `memory_fts` contains the corresponding row (trigger fired)
- TS updates a memory → verify FTS is updated
- TS deletes a memory → verify FTS entry is removed

### 4. Concurrent access tests

These require two processes (not just two connections in one process):

- **Concurrent writes:** Both runtimes write to different tables simultaneously → no SQLITE_BUSY after retry
- **Writer starvation:** One runtime holds a long read transaction → the other can still write (WAL allows this)
- **Busy timeout:** Simulate a long write in one runtime → verify the other runtime retries and succeeds within 5 seconds

### 5. Extension compatibility

- Verify both runtimes load the same sqlite-vec version
- Verify both can read from `memory_vectors` after the other wrote to it
- Verify `vec_version()` returns the same value in both runtimes

### 6. Upgrade path tests

- Start with schema version N (Python only)
- Upgrade Python → schema version N+1
- TS connects and validates → succeeds
- TS connects to schema version N-1 (too old) → fails with clear error

## Phase 2 Prerequisites

These must be completed before the TS runtime first opens the database:

1. **FTS trigger DROP/CREATE race (codemem-zl8q).** The `au` and `ad` triggers are unconditionally dropped and recreated on every `initialize_schema()` call. Fix: use `CREATE TRIGGER IF NOT EXISTS` for all three triggers. The `ai` trigger already does this.

2. **executescript non-atomicity (codemem-i623).** `_rebuild_raw_event_identity_tables` uses `executescript` which auto-commits each statement individually. A crash between `DROP TABLE` and `RENAME` loses data. Either refactor to single-transaction DDL or gate this migration so it cannot run during coexistence.

3. **WAL→DELETE fallback (codemem-hx3m).** `connect()` falls back to DELETE journal mode on `OperationalError`. During coexistence, this silently collapses WAL concurrency guarantees for all connections. Fix: fail with a clear error instead of degrading.

4. **SQLITE_BUSY retry logic.** The Python codebase has no retry logic for SQLITE_BUSY beyond `busy_timeout`. Coexistence makes write conflicts more likely. Either implement retry logic in both runtimes or explicitly accept and document the risk.

## Additional Contract Rules (from review)

- **No shared cache mode.** Both runtimes must NOT use `PRAGMA shared_cache` or URI connections with `?cache=shared`. Shared cache changes locking semantics from database-level to table-level.

- **BEGIN IMMEDIATE for write transactions.** Any transaction that will definitely write should use `BEGIN IMMEDIATE` to acquire the write lock upfront, avoiding deferred-transaction deadlocks.

- **vec0/embedding sync is application-level.** `memory_vectors` has no triggers — embedding insertion/deletion is managed by application code. Both runtimes must maintain vector sync explicitly. Stale vectors are detected via `backfill_vectors`.

- **WAL auto-checkpoint.** Both runtimes use SQLite's default `wal_autocheckpoint = 1000`. This is safe — SQLite handles concurrent checkpoint attempts correctly.

- **Startup DML storms.** `MemoryStore.__init__` runs extensive data migrations on every startup (`_backfill_identity_provenance`, `_migrate_project_first_sharing_defaults`, etc.). These are a source of lock contention with the TS runtime. The TS runtime should expect brief write contention on Python startup.

## Open Questions

1. **sqlite-vec version pinning mechanism.** Where do we document/enforce that both runtimes use the same sqlite-vec version? Options: a shared `db-compat.json` at repo root, CI checks that compare dependency versions, or a version check on startup (`vec_version()` must equal expected value).

2. ~~**WAL checkpoint strategy.**~~ **Resolved:** Default auto-checkpoint (1000 pages) is fine. Both runtimes use it. SQLite handles concurrent checkpoint attempts correctly.

3. **Phase 3 timing.** When does the TS runtime become mature enough to own DDL? Criteria to evaluate: test coverage parity, production usage duration, schema migration tooling in TS.

4. ~~**`executescript` atomicity.**~~ **Resolved:** Escalated to Phase 2 prerequisite (codemem-i623). Risk is data loss, not just visibility — must be fixed before TS runtime introduction.

5. **better-sqlite3 vs node:sqlite.** The Node SQLite driver choice affects extension loading, WAL behavior, and busy timeout semantics. `better-sqlite3` is synchronous (simpler concurrency model), while `node:sqlite` (Node 22+) is newer. The driver must support `enable_load_extension` for sqlite-vec. This decision affects all concurrency guarantees in this document.

6. ~~**Shared connection pragma test.**~~ **Resolved:** Yes, add it. Both runtimes' `connect()` functions must produce connections with identical pragma values. Trivial to implement as a test in each runtime.
