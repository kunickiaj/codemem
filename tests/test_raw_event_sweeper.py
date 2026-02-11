from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from codemem.store import MemoryStore
from codemem.viewer import RawEventSweeper


def test_raw_event_sweeper_flushes_idle_sessions(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    monkeypatch.setenv("CODEMEM_RAW_EVENTS_SWEEPER", "1")
    monkeypatch.setenv("CODEMEM_RAW_EVENTS_SWEEPER_IDLE_MS", "0")
    monkeypatch.setenv("CODEMEM_RAW_EVENTS_SWEEPER_LIMIT", "10")
    monkeypatch.setenv("CODEMEM_RAW_EVENTS_RETENTION_MS", "0")

    store = MemoryStore(db_path)
    try:
        store.record_raw_event(
            opencode_session_id="sess-sweep",
            event_id="evt-0",
            event_type="user_prompt",
            payload={"type": "user_prompt", "prompt_text": "Hello"},
            ts_wall_ms=100,
            ts_mono_ms=1.0,
        )
        store.record_raw_event(
            opencode_session_id="sess-sweep",
            event_id="evt-1",
            event_type="tool.execute.after",
            payload={
                "type": "tool.execute.after",
                "tool": "read",
                "args": {"filePath": "x"},
            },
            ts_wall_ms=200,
            ts_mono_ms=2.0,
        )
        store.update_raw_event_session_meta(
            opencode_session_id="sess-sweep",
            cwd=str(tmp_path),
            project="test-project",
            started_at="2026-01-01T00:00:00Z",
            last_seen_ts_wall_ms=0,
        )
        assert store.raw_event_flush_state("sess-sweep") == -1
    finally:
        store.close()

    sweeper = RawEventSweeper()
    with patch("codemem.viewer.flush_raw_events") as flush:
        sweeper.tick()
        flush.assert_called_once()


def test_purge_raw_events_before(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    store.record_raw_event(
        opencode_session_id="sess",
        event_id="evt-0",
        event_type="user_prompt",
        payload={"type": "user_prompt", "prompt_text": "A"},
        ts_wall_ms=100,
        ts_mono_ms=1.0,
    )
    store.record_raw_event(
        opencode_session_id="sess",
        event_id="evt-1",
        event_type="user_prompt",
        payload={"type": "user_prompt", "prompt_text": "B"},
        ts_wall_ms=200,
        ts_mono_ms=2.0,
    )
    store.conn.execute(
        """
        INSERT INTO raw_event_ingest_samples(
            created_at,
            inserted_events,
            skipped_invalid,
            skipped_duplicate,
            skipped_conflict
        ) VALUES (?, ?, ?, ?, ?)
        """,
        ("1970-01-01T00:00:00+00:00", 1, 0, 0, 0),
    )
    store.conn.execute(
        """
        INSERT INTO raw_event_ingest_samples(
            created_at,
            inserted_events,
            skipped_invalid,
            skipped_duplicate,
            skipped_conflict
        ) VALUES (?, ?, ?, ?, ?)
        """,
        ("2100-01-01T00:00:00+00:00", 1, 0, 0, 0),
    )
    store.conn.commit()
    removed = store.purge_raw_events_before(150)
    assert removed == 1
    remaining = store.conn.execute("SELECT COUNT(*) AS n FROM raw_events").fetchone()[0]
    assert int(remaining) == 1
    old_sample_count = store.conn.execute(
        "SELECT COUNT(*) AS n FROM raw_event_ingest_samples WHERE created_at = ?",
        ("1970-01-01T00:00:00+00:00",),
    ).fetchone()[0]
    assert int(old_sample_count) == 0
    future_sample_count = store.conn.execute(
        "SELECT COUNT(*) AS n FROM raw_event_ingest_samples WHERE created_at = ?",
        ("2100-01-01T00:00:00+00:00",),
    ).fetchone()[0]
    assert int(future_sample_count) == 1
