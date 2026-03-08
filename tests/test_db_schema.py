from __future__ import annotations

from pathlib import Path

from codemem import db


def test_initialize_schema_sets_user_version(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CODEMEM_EMBEDDING_DISABLED", "1")
    conn = db.connect(tmp_path / "mem.sqlite")
    try:
        db.initialize_schema(conn)
        row = conn.execute("PRAGMA user_version").fetchone()
        ingest_table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'raw_event_ingest_stats'"
        ).fetchone()
        ingest_samples_table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'raw_event_ingest_samples'"
        ).fetchone()
        ingest_reason_column = conn.execute(
            "SELECT name FROM pragma_table_info('raw_event_ingest_stats') WHERE name = 'skipped_invalid'"
        ).fetchone()
        attempt_column = conn.execute(
            "SELECT name FROM pragma_table_info('raw_event_flush_batches') WHERE name = 'attempt_count'"
        ).fetchone()
        actor_column = conn.execute(
            "SELECT name FROM pragma_table_info('memory_items') WHERE name = 'actor_id'"
        ).fetchone()
        visibility_column = conn.execute(
            "SELECT name FROM pragma_table_info('memory_items') WHERE name = 'visibility'"
        ).fetchone()
        workspace_column = conn.execute(
            "SELECT name FROM pragma_table_info('memory_items') WHERE name = 'workspace_id'"
        ).fetchone()
    finally:
        conn.close()

    assert row is not None
    assert int(row[0]) == db.SCHEMA_VERSION
    assert ingest_table is not None
    assert ingest_samples_table is not None
    assert ingest_reason_column is not None
    assert attempt_column is not None
    assert actor_column is not None
    assert visibility_column is not None
    assert workspace_column is not None


def test_initialize_schema_skips_reinit_but_keeps_kind_normalization(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("CODEMEM_EMBEDDING_DISABLED", "1")
    conn = db.connect(tmp_path / "mem.sqlite")
    try:
        db.initialize_schema(conn)

        conn.execute(
            """
            INSERT INTO sessions(started_at, cwd, project, user, tool_version)
            VALUES (?, ?, ?, ?, ?)
            """,
            ("2026-01-01T00:00:00Z", "/tmp", "proj", "me", "test"),
        )
        session_id = int(conn.execute("SELECT id FROM sessions").fetchone()[0])
        conn.execute(
            """
            INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (session_id, "project", "t", "b", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
        )
        conn.commit()

        def _unexpected_reinit(_conn):
            raise AssertionError(
                "initialize_schema should not rerun full migration at current version"
            )

        monkeypatch.setattr(db, "_initialize_schema_v1", _unexpected_reinit)
        db.initialize_schema(conn)

        kind = conn.execute("SELECT kind FROM memory_items LIMIT 1").fetchone()[0]
    finally:
        conn.close()

    assert kind == "decision"


def test_initialize_schema_upgrades_existing_v3_db_with_identity_columns(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("CODEMEM_EMBEDDING_DISABLED", "1")
    conn = db.connect(tmp_path / "mem.sqlite")
    try:
        conn.executescript(
            """
            CREATE TABLE sessions (
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

            CREATE TABLE memory_items (
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

            CREATE TABLE raw_event_flush_batches (
                id INTEGER PRIMARY KEY,
                opencode_session_id TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE user_prompts (
                id INTEGER PRIMARY KEY,
                session_id INTEGER,
                project TEXT,
                prompt_text TEXT,
                created_at TEXT
            );
            """
        )
        conn.execute("PRAGMA user_version = 3")
        conn.commit()

        db.initialize_schema(conn)

        actor_column = conn.execute(
            "SELECT name FROM pragma_table_info('memory_items') WHERE name = 'actor_id'"
        ).fetchone()
        visibility_column = conn.execute(
            "SELECT name FROM pragma_table_info('memory_items') WHERE name = 'visibility'"
        ).fetchone()
        row = conn.execute("PRAGMA user_version").fetchone()
    finally:
        conn.close()

    assert actor_column is not None
    assert visibility_column is not None
    assert row is not None
    assert int(row[0]) == db.SCHEMA_VERSION


def test_initialize_schema_backfills_raw_event_identity_without_reinit(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("CODEMEM_EMBEDDING_DISABLED", "1")
    conn = db.connect(tmp_path / "legacy.sqlite")
    try:
        conn.execute("PRAGMA user_version = 1")
        conn.executescript(
            """
            CREATE TABLE raw_events (
                id INTEGER PRIMARY KEY,
                opencode_session_id TEXT NOT NULL,
                event_seq INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(opencode_session_id, event_seq)
            );

            CREATE TABLE raw_event_sessions (
                opencode_session_id TEXT PRIMARY KEY,
                cwd TEXT,
                project TEXT,
                started_at TEXT,
                last_seen_ts_wall_ms INTEGER,
                last_received_event_seq INTEGER NOT NULL DEFAULT -1,
                last_flushed_event_seq INTEGER NOT NULL DEFAULT -1,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE raw_event_flush_batches (
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

            CREATE TABLE opencode_sessions (
                opencode_session_id TEXT PRIMARY KEY,
                session_id INTEGER,
                created_at TEXT NOT NULL
            );

            CREATE TABLE sessions (
                id INTEGER PRIMARY KEY,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                cwd TEXT,
                git_remote TEXT,
                git_branch TEXT,
                user TEXT,
                tool_version TEXT,
                metadata_json TEXT,
                project TEXT,
                import_key TEXT
            );

            CREATE TABLE memory_items (
                id INTEGER PRIMARY KEY,
                session_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                body_text TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                user_prompt_id INTEGER
            );

            CREATE TABLE user_prompts (
                id INTEGER PRIMARY KEY
            );
            """
        )
        conn.execute(
            "INSERT INTO raw_events(opencode_session_id, event_seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
            ("claude:sess-legacy", 1, "prompt", "{}", "2026-01-01T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO raw_event_sessions(opencode_session_id, updated_at) VALUES (?, ?)",
            ("claude:sess-legacy", "2026-01-01T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO raw_event_flush_batches(opencode_session_id, start_event_seq, end_event_seq, extractor_version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                "claude:sess-legacy",
                1,
                1,
                "v1",
                "pending",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z",
            ),
        )
        conn.execute(
            "INSERT INTO sessions(id, started_at, cwd, user, tool_version) VALUES (?, ?, ?, ?, ?)",
            (1, "2026-01-01T00:00:00Z", "/tmp", "tester", "test"),
        )
        conn.execute(
            "INSERT INTO opencode_sessions(opencode_session_id, session_id, created_at) VALUES (?, ?, ?)",
            ("claude:sess-legacy", 1, "2026-01-01T00:00:00Z"),
        )
        conn.commit()

        def _unexpected_reinit(_conn):
            raise AssertionError(
                "initialize_schema should not rerun full migration at current version"
            )

        monkeypatch.setattr(db, "_initialize_schema_v1", _unexpected_reinit)
        db.initialize_schema(conn)

        for table in (
            "raw_events",
            "raw_event_sessions",
            "raw_event_flush_batches",
            "opencode_sessions",
        ):
            columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
            assert "source" in columns
            assert "stream_id" in columns
        assert [
            row[1]
            for row in conn.execute("PRAGMA table_info(raw_event_sessions)").fetchall()
            if row[5]
        ] == [
            "source",
            "stream_id",
        ]
        assert [
            row[1]
            for row in conn.execute("PRAGMA table_info(opencode_sessions)").fetchall()
            if row[5]
        ] == [
            "source",
            "stream_id",
        ]

        row = conn.execute(
            "SELECT source, stream_id, opencode_session_id FROM raw_event_sessions WHERE source = ? AND stream_id = ?",
            ("claude", "sess-legacy"),
        ).fetchone()
        assert row is not None
        assert row[0] == "claude"
        assert row[1] == "sess-legacy"
        assert row[2] == "sess-legacy"
    finally:
        conn.close()


def test_initialize_schema_fails_fast_on_identity_collisions(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CODEMEM_EMBEDDING_DISABLED", "1")
    conn = db.connect(tmp_path / "legacy-collision.sqlite")
    try:
        conn.execute("PRAGMA user_version = 1")
        conn.executescript(
            """
            CREATE TABLE raw_events (
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

            CREATE TABLE raw_event_sessions (
                opencode_session_id TEXT PRIMARY KEY,
                source TEXT NOT NULL DEFAULT 'opencode',
                stream_id TEXT NOT NULL DEFAULT '',
                cwd TEXT,
                project TEXT,
                started_at TEXT,
                last_seen_ts_wall_ms INTEGER,
                last_received_event_seq INTEGER NOT NULL DEFAULT -1,
                last_flushed_event_seq INTEGER NOT NULL DEFAULT -1,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE raw_event_flush_batches (
                id INTEGER PRIMARY KEY,
                opencode_session_id TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'opencode',
                stream_id TEXT NOT NULL DEFAULT '',
                start_event_seq INTEGER NOT NULL,
                end_event_seq INTEGER NOT NULL,
                extractor_version TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                UNIQUE(opencode_session_id, start_event_seq, end_event_seq, extractor_version)
            );

            CREATE TABLE sessions (
                id INTEGER PRIMARY KEY,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                cwd TEXT,
                git_remote TEXT,
                git_branch TEXT,
                user TEXT,
                tool_version TEXT,
                metadata_json TEXT,
                project TEXT,
                import_key TEXT
            );

            CREATE TABLE opencode_sessions (
                opencode_session_id TEXT PRIMARY KEY,
                source TEXT NOT NULL DEFAULT 'opencode',
                stream_id TEXT NOT NULL DEFAULT '',
                session_id INTEGER,
                created_at TEXT NOT NULL
            );

            CREATE TABLE memory_items (
                id INTEGER PRIMARY KEY,
                session_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                body_text TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                user_prompt_id INTEGER
            );

            CREATE TABLE user_prompts (
                id INTEGER PRIMARY KEY
            );
            """
        )
        conn.execute(
            "INSERT INTO raw_event_sessions(opencode_session_id, updated_at) VALUES (?, ?)",
            ("sess-collide", "2026-01-01T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO raw_event_sessions(opencode_session_id, updated_at) VALUES (?, ?)",
            ("opencode:sess-collide", "2026-01-01T00:00:00Z"),
        )
        conn.commit()

        try:
            db.initialize_schema(conn)
            raise AssertionError("expected initialize_schema to fail on identity collision")
        except RuntimeError as exc:
            assert "collision" in str(exc).lower()
    finally:
        conn.close()
