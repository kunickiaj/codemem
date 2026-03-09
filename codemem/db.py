from __future__ import annotations

import json
import os
import shutil
import sqlite3
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import sqlite_vec

DEFAULT_DB_PATH = Path.home() / ".codemem" / "mem.sqlite"
LEGACY_DEFAULT_DB_PATHS = (
    Path.home() / ".codemem.sqlite",
    Path.home() / ".opencode-mem.sqlite",
)
SCHEMA_VERSION = 5


def _sidecar_paths(path: Path) -> list[Path]:
    return [path, Path(f"{path}-wal"), Path(f"{path}-shm")]


def _move_with_sidecars(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    for src_part, dst_part in zip(_sidecar_paths(src), _sidecar_paths(dst), strict=True):
        if not src_part.exists():
            continue
        try:
            src_part.replace(dst_part)
        except OSError:
            shutil.copy2(src_part, dst_part)
            src_part.unlink(missing_ok=True)


def migrate_legacy_default_db(target: Path) -> None:
    if target != DEFAULT_DB_PATH:
        return
    if target.exists():
        return
    for legacy in LEGACY_DEFAULT_DB_PATHS:
        legacy_path = legacy.expanduser()
        if not legacy_path.exists():
            continue
        _move_with_sidecars(legacy_path, target)
        return


def sqlite_vec_version(conn: sqlite3.Connection) -> str | None:
    try:
        row = conn.execute("select vec_version()").fetchone()
    except sqlite3.Error:
        return None
    if not row or row[0] is None:
        return None
    return str(row[0])


def _load_sqlite_vec(conn: sqlite3.Connection) -> None:
    try:
        conn.enable_load_extension(True)
    except AttributeError as exc:
        raise RuntimeError(
            "sqlite-vec requires a Python SQLite build that supports extension loading. "
            "Install a Python build with enable_load_extension (mise/homebrew) and try again."
        ) from exc
    try:
        sqlite_vec.load(conn)
        if sqlite_vec_version(conn) is None:
            raise RuntimeError("sqlite-vec loaded but version check failed")
    except Exception as exc:  # pragma: no cover
        message = (
            "Failed to load sqlite-vec extension. "
            "Semantic recall requires sqlite-vec; see README for platform-specific setup. "
            "If you need to run without embeddings temporarily, set CODEMEM_EMBEDDING_DISABLED=1."
        )
        text = str(exc)
        if "ELFCLASS32" in text:
            message = (
                "Failed to load sqlite-vec extension (ELFCLASS32). "
                "On Linux aarch64, PyPI may ship a 32-bit vec0.so; replace it with the 64-bit aarch64 loadable. "
                "See README section: 'sqlite-vec on aarch64 (Linux)'. "
                "If you need to run without embeddings temporarily, set CODEMEM_EMBEDDING_DISABLED=1."
            )
        raise RuntimeError(message) from exc
    finally:
        try:
            conn.enable_load_extension(False)
        except AttributeError:
            return


def connect(db_path: Path | str, check_same_thread: bool = True) -> sqlite3.Connection:
    path = Path(db_path).expanduser()
    migrate_legacy_default_db(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=check_same_thread)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError:
        conn.execute("PRAGMA journal_mode = DELETE")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def _initialize_schema_v1(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            cwd TEXT,
            project TEXT,
            git_remote TEXT,
            git_branch TEXT,
            user TEXT,
            tool_version TEXT,
            metadata_json TEXT,
            import_key TEXT
        );

        CREATE TABLE IF NOT EXISTS artifacts (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            path TEXT,
            content_text TEXT,
            content_hash TEXT,
            created_at TEXT NOT NULL,
            metadata_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_artifacts_session_kind ON artifacts(session_id, kind);

        CREATE TABLE IF NOT EXISTS memory_items (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            body_text TEXT NOT NULL,
            confidence REAL DEFAULT 0.5,
            tags_text TEXT DEFAULT '',
            active INTEGER DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            metadata_json TEXT,
            actor_id TEXT,
            actor_display_name TEXT,
            visibility TEXT,
            workspace_id TEXT,
            workspace_kind TEXT,
            origin_device_id TEXT,
            origin_source TEXT,
            trust_state TEXT,
            user_prompt_id INTEGER,
            deleted_at TEXT,
            rev INTEGER DEFAULT 0,
            import_key TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memory_items_active_created ON memory_items(active, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_items_session ON memory_items(session_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            title, body_text, tags_text,
            content='memory_items',
            content_rowid='id'
        );

        CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
            INSERT INTO memory_fts(rowid, title, body_text, tags_text)
            VALUES (new.id, new.title, new.body_text, new.tags_text);
        END;

        DROP TRIGGER IF EXISTS memory_items_au;
        CREATE TRIGGER memory_items_au AFTER UPDATE ON memory_items BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, title, body_text, tags_text)
            VALUES('delete', old.id, old.title, old.body_text, old.tags_text);
            INSERT INTO memory_fts(rowid, title, body_text, tags_text)
            VALUES (new.id, new.title, new.body_text, new.tags_text);
        END;

        DROP TRIGGER IF EXISTS memory_items_ad;
        CREATE TRIGGER memory_items_ad AFTER DELETE ON memory_items BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, title, body_text, tags_text)
            VALUES('delete', old.id, old.title, old.body_text, old.tags_text);
        END;

        CREATE TABLE IF NOT EXISTS usage_events (
            id INTEGER PRIMARY KEY,
            session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
            event TEXT NOT NULL,
            tokens_read INTEGER DEFAULT 0,
            tokens_written INTEGER DEFAULT 0,
            tokens_saved INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            metadata_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_usage_events_event_created ON usage_events(event, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id);

        CREATE TABLE IF NOT EXISTS raw_events (
            id INTEGER PRIMARY KEY,
            source TEXT NOT NULL DEFAULT 'opencode',
            stream_id TEXT NOT NULL DEFAULT '',
            opencode_session_id TEXT NOT NULL,
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
        CREATE INDEX IF NOT EXISTS idx_raw_events_session_seq ON raw_events(opencode_session_id, event_seq);
        CREATE INDEX IF NOT EXISTS idx_raw_events_created_at ON raw_events(created_at DESC);

        CREATE TABLE IF NOT EXISTS raw_event_sessions (
            source TEXT NOT NULL DEFAULT 'opencode',
            stream_id TEXT NOT NULL DEFAULT '',
            opencode_session_id TEXT NOT NULL,
            cwd TEXT,
            project TEXT,
            started_at TEXT,
            last_seen_ts_wall_ms INTEGER,
            last_received_event_seq INTEGER NOT NULL DEFAULT -1,
            last_flushed_event_seq INTEGER NOT NULL DEFAULT -1,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (source, stream_id)
        );

        CREATE TABLE IF NOT EXISTS opencode_sessions (
            source TEXT NOT NULL DEFAULT 'opencode',
            stream_id TEXT NOT NULL DEFAULT '',
            opencode_session_id TEXT NOT NULL,
            session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            PRIMARY KEY (source, stream_id)
        );
        CREATE INDEX IF NOT EXISTS idx_opencode_sessions_session_id ON opencode_sessions(session_id);

        CREATE TABLE IF NOT EXISTS raw_event_flush_batches (
            id INTEGER PRIMARY KEY,
            source TEXT NOT NULL DEFAULT 'opencode',
            stream_id TEXT NOT NULL DEFAULT '',
            opencode_session_id TEXT NOT NULL,
            start_event_seq INTEGER NOT NULL,
            end_event_seq INTEGER NOT NULL,
            extractor_version TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(source, stream_id, start_event_seq, end_event_seq, extractor_version)
        );
        CREATE INDEX IF NOT EXISTS idx_raw_event_flush_batches_session ON raw_event_flush_batches(opencode_session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_raw_event_flush_batches_status ON raw_event_flush_batches(status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS user_prompts (
            id INTEGER PRIMARY KEY,
            session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
            project TEXT,
            prompt_text TEXT NOT NULL,
            prompt_number INTEGER,
            created_at TEXT NOT NULL,
            created_at_epoch INTEGER NOT NULL,
            metadata_json TEXT,
            import_key TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_id);
        CREATE INDEX IF NOT EXISTS idx_user_prompts_project ON user_prompts(project);
        CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC);

        CREATE TABLE IF NOT EXISTS session_summaries (
            id INTEGER PRIMARY KEY,
            session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
            project TEXT,
            request TEXT,
            investigated TEXT,
            learned TEXT,
            completed TEXT,
            next_steps TEXT,
            notes TEXT,
            files_read TEXT,
            files_edited TEXT,
            prompt_number INTEGER,
            created_at TEXT NOT NULL,
            created_at_epoch INTEGER NOT NULL,
            metadata_json TEXT,
            import_key TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
        CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);

        CREATE TABLE IF NOT EXISTS replication_ops (
            op_id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            op_type TEXT NOT NULL,
            payload_json TEXT,
            clock_rev INTEGER NOT NULL,
            clock_updated_at TEXT NOT NULL,
            clock_device_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_replication_ops_created ON replication_ops(created_at, op_id);
        CREATE INDEX IF NOT EXISTS idx_replication_ops_entity ON replication_ops(entity_type, entity_id);

        CREATE TABLE IF NOT EXISTS replication_cursors (
            peer_device_id TEXT PRIMARY KEY,
            last_applied_cursor TEXT,
            last_acked_cursor TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_peers (
            peer_device_id TEXT PRIMARY KEY,
            name TEXT,
            pinned_fingerprint TEXT,
            public_key TEXT,
            addresses_json TEXT,
            claimed_local_actor INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            last_seen_at TEXT,
            last_sync_at TEXT,
            last_error TEXT
        );

        CREATE TABLE IF NOT EXISTS sync_nonces (
            nonce TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_device (
            device_id TEXT PRIMARY KEY,
            public_key TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            peer_device_id TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            ok INTEGER NOT NULL,
            ops_in INTEGER NOT NULL,
            ops_out INTEGER NOT NULL,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sync_attempts_peer_started ON sync_attempts(peer_device_id, started_at);

        CREATE TABLE IF NOT EXISTS sync_daemon_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            last_error TEXT,
            last_traceback TEXT,
            last_error_at TEXT,
            last_ok_at TEXT
        );
        """
    )
    _ensure_column(conn, "sessions", "project", "TEXT")
    _ensure_column(conn, "sessions", "import_key", "TEXT")
    _ensure_column(conn, "memory_items", "subtitle", "TEXT")
    _ensure_column(conn, "memory_items", "facts", "TEXT")
    _ensure_column(conn, "memory_items", "narrative", "TEXT")
    _ensure_column(conn, "memory_items", "concepts", "TEXT")
    _ensure_column(conn, "memory_items", "files_read", "TEXT")
    _ensure_column(conn, "memory_items", "files_modified", "TEXT")
    _ensure_column(conn, "memory_items", "prompt_number", "INTEGER")
    _ensure_column(conn, "memory_items", "user_prompt_id", "INTEGER")
    _ensure_column(conn, "memory_items", "import_key", "TEXT")
    _ensure_column(conn, "memory_items", "deleted_at", "TEXT")
    _ensure_column(conn, "memory_items", "rev", "INTEGER")
    _ensure_column(conn, "memory_items", "actor_id", "TEXT")
    _ensure_column(conn, "memory_items", "actor_display_name", "TEXT")
    _ensure_column(conn, "memory_items", "visibility", "TEXT")
    _ensure_column(conn, "memory_items", "workspace_id", "TEXT")
    _ensure_column(conn, "memory_items", "workspace_kind", "TEXT")
    _ensure_column(conn, "memory_items", "origin_device_id", "TEXT")
    _ensure_column(conn, "memory_items", "origin_source", "TEXT")
    _ensure_column(conn, "memory_items", "trust_state", "TEXT")
    _ensure_column(conn, "user_prompts", "import_key", "TEXT")
    _ensure_column(conn, "session_summaries", "import_key", "TEXT")
    _ensure_column(conn, "raw_event_sessions", "cwd", "TEXT")
    _ensure_column(conn, "sync_peers", "public_key", "TEXT")
    _ensure_column(conn, "sync_peers", "projects_include_json", "TEXT")
    _ensure_column(conn, "sync_peers", "projects_exclude_json", "TEXT")
    _ensure_column(conn, "sync_peers", "claimed_local_actor", "INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "raw_event_sessions", "project", "TEXT")
    _ensure_column(conn, "raw_event_sessions", "started_at", "TEXT")
    _ensure_column(conn, "raw_event_sessions", "last_seen_ts_wall_ms", "INTEGER")
    _ensure_column(conn, "raw_event_sessions", "last_received_event_seq", "INTEGER")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_import_key ON sessions(import_key)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memory_items_import_key ON memory_items(import_key)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memory_items_user_prompt_id ON memory_items(user_prompt_id)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_memory_items_actor_id ON memory_items(actor_id)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memory_items_visibility ON memory_items(visibility)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memory_items_workspace_id ON memory_items(workspace_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_summaries_import_key ON session_summaries(import_key)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_prompts_import_key ON user_prompts(import_key)"
    )


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def _table_pk_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    pk_rows = [row for row in rows if int(row[5] or 0) > 0]
    pk_rows.sort(key=lambda row: int(row[5]))
    return [str(row[1]) for row in pk_rows]


def _table_create_sql(conn: sqlite3.Connection, table: str) -> str:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    if row is None or row[0] is None:
        return ""
    return " ".join(str(row[0]).lower().split())


def _raw_event_identity_needs_rebuild(conn: sqlite3.Connection) -> bool:
    if not _table_exists(conn, "raw_event_sessions") or not _table_exists(
        conn, "opencode_sessions"
    ):
        return False
    if _table_pk_columns(conn, "raw_event_sessions") != [
        "source",
        "stream_id",
    ]:
        return True
    if _table_pk_columns(conn, "opencode_sessions") != ["source", "stream_id"]:
        return True

    raw_events_sql = _table_create_sql(conn, "raw_events")
    if "unique(source, stream_id, event_seq)" not in raw_events_sql:
        return True
    if "unique(source, stream_id, event_id)" not in raw_events_sql:
        return True

    batches_sql = _table_create_sql(conn, "raw_event_flush_batches")
    return (
        "unique(source, stream_id, start_event_seq, end_event_seq, extractor_version)"
        not in batches_sql
    )


def _raw_event_identity_needs_data_migration(conn: sqlite3.Connection) -> bool:
    required_columns = {
        "raw_events": {"source", "stream_id"},
        "raw_event_sessions": {"source", "stream_id"},
        "raw_event_flush_batches": {"source", "stream_id"},
        "opencode_sessions": {"source", "stream_id"},
    }
    for table, columns in required_columns.items():
        if not _table_exists(conn, table):
            continue
        existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if not columns.issubset(existing):
            return True
    return _raw_event_identity_needs_rebuild(conn)


def _assert_no_raw_event_identity_collisions(conn: sqlite3.Connection) -> None:
    checks = [
        (
            "raw_events(source, stream_id, event_seq)",
            """
            SELECT source, stream_id, event_seq
            FROM raw_events
            GROUP BY source, stream_id, event_seq
            HAVING COUNT(*) > 1
            LIMIT 1
            """,
        ),
        (
            "raw_events(source, stream_id, event_id)",
            """
            SELECT source, stream_id, event_id
            FROM raw_events
            WHERE event_id IS NOT NULL
            GROUP BY source, stream_id, event_id
            HAVING COUNT(*) > 1
            LIMIT 1
            """,
        ),
        (
            "raw_event_sessions(source, stream_id)",
            """
            SELECT source, stream_id
            FROM raw_event_sessions
            GROUP BY source, stream_id
            HAVING COUNT(*) > 1
            LIMIT 1
            """,
        ),
        (
            "raw_event_flush_batches(source, stream_id, start_event_seq, end_event_seq, extractor_version)",
            """
            SELECT source, stream_id, start_event_seq, end_event_seq, extractor_version
            FROM raw_event_flush_batches
            GROUP BY source, stream_id, start_event_seq, end_event_seq, extractor_version
            HAVING COUNT(*) > 1
            LIMIT 1
            """,
        ),
        (
            "opencode_sessions(source, stream_id)",
            """
            SELECT source, stream_id
            FROM opencode_sessions
            GROUP BY source, stream_id
            HAVING COUNT(*) > 1
            LIMIT 1
            """,
        ),
    ]
    for label, sql in checks:
        row = conn.execute(sql).fetchone()
        if row is not None:
            raise RuntimeError(f"Raw-event identity migration collision detected in {label}")


def _rebuild_raw_event_identity_tables(conn: sqlite3.Connection) -> None:
    _assert_no_raw_event_identity_collisions(conn)

    before_counts = {
        "raw_events": int(conn.execute("SELECT COUNT(*) FROM raw_events").fetchone()[0]),
        "raw_event_sessions": int(
            conn.execute("SELECT COUNT(*) FROM raw_event_sessions").fetchone()[0]
        ),
        "raw_event_flush_batches": int(
            conn.execute("SELECT COUNT(*) FROM raw_event_flush_batches").fetchone()[0]
        ),
        "opencode_sessions": int(
            conn.execute("SELECT COUNT(*) FROM opencode_sessions").fetchone()[0]
        ),
    }

    batch_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(raw_event_flush_batches)").fetchall()
    }
    batch_attempt_expr = "COALESCE(attempt_count, 0)" if "attempt_count" in batch_columns else "0"

    conn.executescript(
        """
        CREATE TABLE raw_events_v2 (
            id INTEGER PRIMARY KEY,
            source TEXT NOT NULL DEFAULT 'opencode',
            stream_id TEXT NOT NULL,
            opencode_session_id TEXT NOT NULL,
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

        CREATE TABLE raw_event_sessions_v2 (
            source TEXT NOT NULL DEFAULT 'opencode',
            stream_id TEXT NOT NULL,
            opencode_session_id TEXT NOT NULL,
            cwd TEXT,
            project TEXT,
            started_at TEXT,
            last_seen_ts_wall_ms INTEGER,
            last_received_event_seq INTEGER NOT NULL DEFAULT -1,
            last_flushed_event_seq INTEGER NOT NULL DEFAULT -1,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (source, stream_id)
        );

        CREATE TABLE raw_event_flush_batches_v2 (
            id INTEGER PRIMARY KEY,
            source TEXT NOT NULL DEFAULT 'opencode',
            stream_id TEXT NOT NULL,
            opencode_session_id TEXT NOT NULL,
            start_event_seq INTEGER NOT NULL,
            end_event_seq INTEGER NOT NULL,
            extractor_version TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            UNIQUE(source, stream_id, start_event_seq, end_event_seq, extractor_version)
        );

        CREATE TABLE opencode_sessions_v2 (
            source TEXT NOT NULL DEFAULT 'opencode',
            stream_id TEXT NOT NULL,
            opencode_session_id TEXT NOT NULL,
            session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            PRIMARY KEY (source, stream_id)
        );
        """
    )

    conn.execute(
        """
        INSERT INTO raw_events_v2(
            id,
            source,
            stream_id,
            opencode_session_id,
            event_id,
            event_seq,
            event_type,
            ts_wall_ms,
            ts_mono_ms,
            payload_json,
            created_at
        )
        SELECT
            id,
            source,
            stream_id,
            stream_id,
            event_id,
            event_seq,
            event_type,
            ts_wall_ms,
            ts_mono_ms,
            payload_json,
            created_at
        FROM raw_events
        """
    )
    conn.execute(
        """
        INSERT INTO raw_event_sessions_v2(
            source,
            stream_id,
            opencode_session_id,
            cwd,
            project,
            started_at,
            last_seen_ts_wall_ms,
            last_received_event_seq,
            last_flushed_event_seq,
            updated_at
        )
        SELECT
            source,
            stream_id,
            stream_id,
            cwd,
            project,
            started_at,
            last_seen_ts_wall_ms,
            last_received_event_seq,
            last_flushed_event_seq,
            updated_at
        FROM raw_event_sessions
        """
    )
    conn.execute(
        f"""
        INSERT INTO raw_event_flush_batches_v2(
            id,
            source,
            stream_id,
            opencode_session_id,
            start_event_seq,
            end_event_seq,
            extractor_version,
            status,
            created_at,
            updated_at,
            attempt_count
        )
        SELECT
            id,
            source,
            stream_id,
            stream_id,
            start_event_seq,
            end_event_seq,
            extractor_version,
            status,
            created_at,
            updated_at,
            {batch_attempt_expr}
        FROM raw_event_flush_batches
        """
    )
    conn.execute(
        """
        INSERT INTO opencode_sessions_v2(
            source,
            stream_id,
            opencode_session_id,
            session_id,
            created_at
        )
        SELECT
            os.source,
            os.stream_id,
            os.stream_id,
            CASE
                WHEN os.session_id IS NULL THEN NULL
                WHEN EXISTS(SELECT 1 FROM sessions s WHERE s.id = os.session_id) THEN os.session_id
                ELSE NULL
            END,
            os.created_at
        FROM opencode_sessions os
        """
    )

    after_counts = {
        "raw_events": int(conn.execute("SELECT COUNT(*) FROM raw_events_v2").fetchone()[0]),
        "raw_event_sessions": int(
            conn.execute("SELECT COUNT(*) FROM raw_event_sessions_v2").fetchone()[0]
        ),
        "raw_event_flush_batches": int(
            conn.execute("SELECT COUNT(*) FROM raw_event_flush_batches_v2").fetchone()[0]
        ),
        "opencode_sessions": int(
            conn.execute("SELECT COUNT(*) FROM opencode_sessions_v2").fetchone()[0]
        ),
    }
    if before_counts != after_counts:
        raise RuntimeError(
            "Raw-event identity migration row-count mismatch; aborting rebuild "
            f"(before={before_counts}, after={after_counts})"
        )

    conn.executescript(
        """
        DROP TABLE raw_events;
        ALTER TABLE raw_events_v2 RENAME TO raw_events;

        DROP TABLE raw_event_sessions;
        ALTER TABLE raw_event_sessions_v2 RENAME TO raw_event_sessions;

        DROP TABLE raw_event_flush_batches;
        ALTER TABLE raw_event_flush_batches_v2 RENAME TO raw_event_flush_batches;

        DROP TABLE opencode_sessions;
        ALTER TABLE opencode_sessions_v2 RENAME TO opencode_sessions;
        """
    )

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_raw_events_session_seq ON raw_events(opencode_session_id, event_seq)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_raw_events_created_at ON raw_events(created_at DESC)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_raw_events_event_id ON raw_events(opencode_session_id, event_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_raw_events_source_stream_event_id ON raw_events(source, stream_id, event_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_raw_events_source_stream_seq ON raw_events(source, stream_id, event_seq)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_raw_event_sessions_source_stream ON raw_event_sessions(source, stream_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_raw_event_sessions_legacy_session ON raw_event_sessions(opencode_session_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_raw_event_flush_batches_session ON raw_event_flush_batches(opencode_session_id, created_at DESC)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_raw_event_flush_batches_source_stream ON raw_event_flush_batches(source, stream_id, created_at DESC)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_raw_event_flush_batches_status ON raw_event_flush_batches(status, updated_at DESC)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_opencode_sessions_session_id ON opencode_sessions(session_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_opencode_sessions_source_stream ON opencode_sessions(source, stream_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_opencode_sessions_legacy_session ON opencode_sessions(opencode_session_id)"
    )


def _ensure_raw_event_identity_schema(conn: sqlite3.Connection, *, migrate_data: bool) -> None:
    if _table_exists(conn, "raw_event_sessions"):
        _ensure_column(conn, "raw_event_sessions", "source", "TEXT NOT NULL DEFAULT 'opencode'")
        _ensure_column(conn, "raw_event_sessions", "stream_id", "TEXT NOT NULL DEFAULT ''")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_raw_event_sessions_source_stream ON raw_event_sessions(source, stream_id)"
        )

    if _table_exists(conn, "raw_events"):
        _ensure_column(conn, "raw_events", "event_id", "TEXT")
        _ensure_column(conn, "raw_events", "source", "TEXT NOT NULL DEFAULT 'opencode'")
        _ensure_column(conn, "raw_events", "stream_id", "TEXT NOT NULL DEFAULT ''")
        _ensure_column(conn, "raw_events", "ts_wall_ms", "INTEGER")
        _ensure_column(conn, "raw_events", "ts_mono_ms", "REAL")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_raw_events_event_id ON raw_events(opencode_session_id, event_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_raw_events_source_stream_event_id ON raw_events(source, stream_id, event_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_raw_events_source_stream_seq ON raw_events(source, stream_id, event_seq)"
        )

    if _table_exists(conn, "raw_event_flush_batches"):
        _ensure_column(
            conn, "raw_event_flush_batches", "source", "TEXT NOT NULL DEFAULT 'opencode'"
        )
        _ensure_column(conn, "raw_event_flush_batches", "stream_id", "TEXT NOT NULL DEFAULT ''")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_raw_event_flush_batches_source_stream ON raw_event_flush_batches(source, stream_id, created_at DESC)"
        )

    if _table_exists(conn, "opencode_sessions"):
        _ensure_column(conn, "opencode_sessions", "source", "TEXT NOT NULL DEFAULT 'opencode'")
        _ensure_column(conn, "opencode_sessions", "stream_id", "TEXT NOT NULL DEFAULT ''")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_opencode_sessions_source_stream ON opencode_sessions(source, stream_id)"
        )

    if not migrate_data:
        return
    _backfill_raw_event_identity_columns(conn)
    if _raw_event_identity_needs_rebuild(conn):
        _rebuild_raw_event_identity_tables(conn)


def _backfill_raw_event_identity_columns(conn: sqlite3.Connection) -> None:
    known_prefixes = {"opencode", "claude", "cursor", "codex"}

    def _normalize_legacy_identity(key: str, source: str, stream_id: str) -> tuple[str, str]:
        source_norm = source.strip().lower() or "opencode"
        stream_norm = stream_id.strip()
        if stream_norm:
            if ":" in stream_norm:
                prefix, remainder = stream_norm.split(":", 1)
                prefix = prefix.strip().lower()
                remainder = remainder.strip()
                if (
                    prefix in known_prefixes
                    and remainder
                    and (source_norm == "opencode" or source_norm == prefix)
                ):
                    return prefix, remainder
            return source_norm, stream_norm

        key_norm = key.strip()
        if not key_norm:
            return source_norm, key_norm
        if ":" in key_norm:
            prefix, remainder = key_norm.split(":", 1)
            prefix = prefix.strip().lower()
            remainder = remainder.strip()
            if (
                prefix in known_prefixes
                and remainder
                and (source_norm == "opencode" or source_norm == prefix)
            ):
                return prefix, remainder
        return source_norm, key_norm

    targets = [
        ("raw_events", "opencode_session_id"),
        ("raw_event_sessions", "opencode_session_id"),
        ("raw_event_flush_batches", "opencode_session_id"),
        ("opencode_sessions", "opencode_session_id"),
    ]
    for table, key_col in targets:
        columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if key_col not in columns or "source" not in columns or "stream_id" not in columns:
            continue
        rows = conn.execute(
            f"SELECT rowid AS _rid, {key_col}, source, stream_id FROM {table}"
        ).fetchall()
        updates: list[tuple[str, str, int]] = []
        for row in rows:
            key = str(row[key_col] or "").strip()
            if not key:
                continue
            current_source = str(row["source"] or "").strip().lower() or "opencode"
            current_stream = str(row["stream_id"] or "").strip()
            source, stream_id = _normalize_legacy_identity(
                key=key,
                source=current_source,
                stream_id=current_stream,
            )
            if current_source == source and current_stream == stream_id:
                continue
            updates.append((source, stream_id, int(row["_rid"])))
        if updates:
            conn.executemany(
                f"UPDATE {table} SET source = ?, stream_id = ? WHERE rowid = ?",
                updates,
            )


def _schema_user_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("PRAGMA user_version").fetchone()
    if row is None:
        return 0
    return int(row[0])


def _normalize_legacy_memory_kinds(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT 1 FROM memory_items WHERE lower(trim(kind)) = 'project' LIMIT 1"
    ).fetchone()
    if row is None:
        return
    conn.execute("UPDATE memory_items SET kind = 'decision' WHERE lower(trim(kind)) = 'project'")


def _ensure_vector_schema(conn: sqlite3.Connection) -> None:
    if os.getenv("CODEMEM_EMBEDDING_DISABLED", "").lower() in {"1", "true", "yes"}:
        return
    _load_sqlite_vec(conn)
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
            embedding float[384],
            memory_id INTEGER,
            chunk_index INTEGER,
            content_hash TEXT,
            model TEXT
        );
        """
    )


def _ensure_raw_event_reliability_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS raw_event_ingest_stats (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            inserted_events INTEGER NOT NULL DEFAULT 0,
            skipped_events INTEGER NOT NULL DEFAULT 0,
            skipped_invalid INTEGER NOT NULL DEFAULT 0,
            skipped_duplicate INTEGER NOT NULL DEFAULT 0,
            skipped_conflict INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS raw_event_ingest_samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            inserted_events INTEGER NOT NULL DEFAULT 0,
            skipped_invalid INTEGER NOT NULL DEFAULT 0,
            skipped_duplicate INTEGER NOT NULL DEFAULT 0,
            skipped_conflict INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_raw_event_ingest_samples_created
        ON raw_event_ingest_samples(created_at)
        """
    )
    _ensure_column(conn, "raw_event_ingest_stats", "skipped_invalid", "INTEGER NOT NULL DEFAULT 0")
    _ensure_column(
        conn, "raw_event_ingest_stats", "skipped_duplicate", "INTEGER NOT NULL DEFAULT 0"
    )
    _ensure_column(conn, "raw_event_ingest_stats", "skipped_conflict", "INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "raw_event_flush_batches", "attempt_count", "INTEGER NOT NULL DEFAULT 0")


def _ensure_memory_identity_schema(conn: sqlite3.Connection) -> None:
    if not _table_exists(conn, "memory_items"):
        return
    _ensure_column(conn, "memory_items", "subtitle", "TEXT")
    _ensure_column(conn, "memory_items", "facts", "TEXT")
    _ensure_column(conn, "memory_items", "narrative", "TEXT")
    _ensure_column(conn, "memory_items", "concepts", "TEXT")
    _ensure_column(conn, "memory_items", "files_read", "TEXT")
    _ensure_column(conn, "memory_items", "files_modified", "TEXT")
    _ensure_column(conn, "memory_items", "prompt_number", "INTEGER")
    _ensure_column(conn, "memory_items", "user_prompt_id", "INTEGER")
    _ensure_column(conn, "memory_items", "import_key", "TEXT")
    _ensure_column(conn, "memory_items", "deleted_at", "TEXT")
    _ensure_column(conn, "memory_items", "rev", "INTEGER")
    _ensure_column(conn, "memory_items", "actor_id", "TEXT")
    _ensure_column(conn, "memory_items", "actor_display_name", "TEXT")
    _ensure_column(conn, "memory_items", "visibility", "TEXT")
    _ensure_column(conn, "memory_items", "workspace_id", "TEXT")
    _ensure_column(conn, "memory_items", "workspace_kind", "TEXT")
    _ensure_column(conn, "memory_items", "origin_device_id", "TEXT")
    _ensure_column(conn, "memory_items", "origin_source", "TEXT")
    _ensure_column(conn, "memory_items", "trust_state", "TEXT")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memory_items_import_key ON memory_items(import_key)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memory_items_user_prompt_id ON memory_items(user_prompt_id)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_memory_items_actor_id ON memory_items(actor_id)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memory_items_visibility ON memory_items(visibility)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memory_items_workspace_id ON memory_items(workspace_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memory_items_workspace_kind ON memory_items(workspace_kind)"
    )


def _ensure_sync_peer_schema(conn: sqlite3.Connection) -> None:
    if not _table_exists(conn, "sync_peers"):
        return
    _ensure_column(conn, "sync_peers", "public_key", "TEXT")
    _ensure_column(conn, "sync_peers", "projects_include_json", "TEXT")
    _ensure_column(conn, "sync_peers", "projects_exclude_json", "TEXT")
    _ensure_column(conn, "sync_peers", "claimed_local_actor", "INTEGER NOT NULL DEFAULT 0")


def _ensure_artifact_storage_schema(conn: sqlite3.Connection) -> None:
    if not _table_exists(conn, "artifacts"):
        return
    _ensure_column(conn, "artifacts", "content_encoding", "TEXT")
    _ensure_column(conn, "artifacts", "content_blob", "BLOB")


def initialize_schema(conn: sqlite3.Connection) -> None:
    current_version = _schema_user_version(conn)
    raw_event_identity_migrate = _raw_event_identity_needs_data_migration(conn)
    if current_version < 1:
        _initialize_schema_v1(conn)
        current_version = 1
    _ensure_memory_identity_schema(conn)
    _ensure_sync_peer_schema(conn)
    _ensure_artifact_storage_schema(conn)
    _ensure_raw_event_identity_schema(conn, migrate_data=raw_event_identity_migrate)
    if current_version < SCHEMA_VERSION:
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    _ensure_vector_schema(conn)
    _ensure_raw_event_reliability_schema(conn)
    _normalize_legacy_memory_kinds(conn)
    _cleanup_orphan_prompt_links(conn)
    if conn.in_transaction:
        conn.commit()


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, column_type: str) -> None:
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column in existing:
        return
    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {column_type}")


def _cleanup_orphan_prompt_links(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        UPDATE memory_items AS m
        SET user_prompt_id = NULL
        WHERE m.user_prompt_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM user_prompts WHERE user_prompts.id = m.user_prompt_id
          )
        """
    )


def to_json(data: Any) -> str:
    if data is None:
        payload: Any = {}
    else:
        payload = data
    return json.dumps(payload, ensure_ascii=False)


def from_json(text: str | None) -> dict[str, Any]:
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}


def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]
