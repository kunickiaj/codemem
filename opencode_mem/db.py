from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

DEFAULT_DB_PATH = Path.home() / ".opencode-mem.sqlite"


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
            metadata_json TEXT
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
            metadata_json TEXT
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

        CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
            DELETE FROM memory_fts WHERE rowid = old.id;
            INSERT INTO memory_fts(rowid, title, body_text, tags_text)
            VALUES (new.id, new.title, new.body_text, new.tags_text);
        END;

        CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
            DELETE FROM memory_fts WHERE rowid = old.id;
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

        CREATE TABLE IF NOT EXISTS user_prompts (
            id INTEGER PRIMARY KEY,
            session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
            project TEXT,
            prompt_text TEXT NOT NULL,
            prompt_number INTEGER,
            created_at TEXT NOT NULL,
            created_at_epoch INTEGER NOT NULL,
            metadata_json TEXT
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
            metadata_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
        CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
        """
    )
    _ensure_column(conn, "sessions", "project", "TEXT")
    _ensure_column(conn, "memory_items", "subtitle", "TEXT")
    _ensure_column(conn, "memory_items", "facts", "TEXT")
    _ensure_column(conn, "memory_items", "narrative", "TEXT")
    _ensure_column(conn, "memory_items", "concepts", "TEXT")
    _ensure_column(conn, "memory_items", "files_read", "TEXT")
    _ensure_column(conn, "memory_items", "files_modified", "TEXT")
    _ensure_column(conn, "memory_items", "prompt_number", "INTEGER")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project)")
    conn.commit()


def _ensure_column(
    conn: sqlite3.Connection, table: str, column: str, column_type: str
) -> None:
    existing = {
        row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
    }
    if column in existing:
        return
    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {column_type}")


def to_json(data: Any) -> str:
    if data is None:
        payload: Any = {}
    else:
        payload = data
    return json.dumps(payload, ensure_ascii=False)


def from_json(text: Optional[str]) -> Dict[str, Any]:
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}


def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> list[Dict[str, Any]]:
    return [dict(r) for r in rows]
