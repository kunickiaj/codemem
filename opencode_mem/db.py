from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import sqlite_vec

DEFAULT_DB_PATH = Path.home() / ".opencode-mem.sqlite"


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
            "If you need to run without embeddings temporarily, set OPENCODE_MEM_EMBEDDING_DISABLED=1."
        )
        text = str(exc)
        if "ELFCLASS32" in text:
            message = (
                "Failed to load sqlite-vec extension (ELFCLASS32). "
                "On Linux aarch64, PyPI may ship a 32-bit vec0.so; replace it with the 64-bit aarch64 loadable. "
                "See README section: 'sqlite-vec on aarch64 (Linux)'. "
                "If you need to run without embeddings temporarily, set OPENCODE_MEM_EMBEDDING_DISABLED=1."
            )
        raise RuntimeError(message) from exc
    finally:
        try:
            conn.enable_load_extension(False)
        except AttributeError:
            return


def connect(db_path: Path | str, check_same_thread: bool = True) -> sqlite3.Connection:
    path = Path(db_path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=check_same_thread)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError:
        conn.execute("PRAGMA journal_mode = DELETE")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def initialize_schema(conn: sqlite3.Connection) -> None:
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
            opencode_session_id TEXT NOT NULL,
            event_id TEXT,
            event_seq INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            ts_wall_ms INTEGER,
            ts_mono_ms REAL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(opencode_session_id, event_seq)
        );
        CREATE INDEX IF NOT EXISTS idx_raw_events_session_seq ON raw_events(opencode_session_id, event_seq);
        CREATE INDEX IF NOT EXISTS idx_raw_events_created_at ON raw_events(created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_events_event_id ON raw_events(opencode_session_id, event_id);

        CREATE TABLE IF NOT EXISTS raw_event_sessions (
            opencode_session_id TEXT PRIMARY KEY,
            cwd TEXT,
            project TEXT,
            started_at TEXT,
            last_seen_ts_wall_ms INTEGER,
            last_received_event_seq INTEGER NOT NULL DEFAULT -1,
            last_flushed_event_seq INTEGER NOT NULL DEFAULT -1,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS opencode_sessions (
            opencode_session_id TEXT PRIMARY KEY,
            session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_opencode_sessions_session_id ON opencode_sessions(session_id);

        CREATE TABLE IF NOT EXISTS raw_event_flush_batches (
            id INTEGER PRIMARY KEY,
            opencode_session_id TEXT NOT NULL,
            start_event_seq INTEGER NOT NULL,
            end_event_seq INTEGER NOT NULL,
            extractor_version TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(opencode_session_id, start_event_seq, end_event_seq, extractor_version)
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
    _ensure_column(conn, "memory_items", "import_key", "TEXT")
    _ensure_column(conn, "user_prompts", "import_key", "TEXT")
    _ensure_column(conn, "session_summaries", "import_key", "TEXT")
    _ensure_column(conn, "raw_event_sessions", "cwd", "TEXT")
    _ensure_column(conn, "raw_event_sessions", "project", "TEXT")
    _ensure_column(conn, "raw_event_sessions", "started_at", "TEXT")
    _ensure_column(conn, "raw_event_sessions", "last_seen_ts_wall_ms", "INTEGER")
    _ensure_column(conn, "raw_event_sessions", "last_received_event_seq", "INTEGER")
    _ensure_column(conn, "raw_events", "event_id", "TEXT")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_events_event_id ON raw_events(opencode_session_id, event_id)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_import_key ON sessions(import_key)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memory_items_import_key ON memory_items(import_key)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_summaries_import_key ON session_summaries(import_key)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_prompts_import_key ON user_prompts(import_key)"
    )

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
    conn.commit()


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, column_type: str) -> None:
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column in existing:
        return
    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {column_type}")


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
