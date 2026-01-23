from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from opencode_mem.store import MemoryStore
from opencode_mem.viewer import RawEventSweeper


def test_raw_event_sweeper_flushes_idle_sessions(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    monkeypatch.setenv("OPENCODE_MEM_RAW_EVENTS_SWEEPER", "1")
    monkeypatch.setenv("OPENCODE_MEM_RAW_EVENTS_SWEEPER_IDLE_MS", "0")
    monkeypatch.setenv("OPENCODE_MEM_RAW_EVENTS_SWEEPER_LIMIT", "10")
    monkeypatch.setenv("OPENCODE_MEM_RAW_EVENTS_RETENTION_MS", "0")

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
    with patch("opencode_mem.viewer.flush_raw_events") as flush:
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
    removed = store.purge_raw_events_before(150)
    assert removed == 1
    remaining = store.conn.execute("SELECT COUNT(*) AS n FROM raw_events").fetchone()[0]
    assert int(remaining) == 1
