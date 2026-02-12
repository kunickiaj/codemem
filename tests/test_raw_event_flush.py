from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from codemem.raw_event_flush import EXTRACTOR_VERSION, flush_raw_events
from codemem.store import MemoryStore
from codemem.xml_parser import ParsedSummary


def test_flush_raw_events_is_idempotent(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    store.record_raw_event(
        opencode_session_id="sess",
        event_id="evt-0",
        event_type="user_prompt",
        payload={"type": "user_prompt", "prompt_text": "Hello"},
        ts_wall_ms=100,
        ts_mono_ms=1.0,
    )
    store.record_raw_event(
        opencode_session_id="sess",
        event_id="evt-1",
        event_type="tool.execute.after",
        payload={"type": "tool.execute.after", "tool": "read", "args": {"filePath": "x"}},
        ts_wall_ms=200,
        ts_mono_ms=2.0,
    )

    mock_response = MagicMock()
    mock_response.parsed.observations = []
    mock_response.parsed.summary = ParsedSummary(
        request="Test request",
        investigated="",
        learned="",
        completed="",
        next_steps="",
        notes="",
        files_read=[],
        files_modified=[],
    )
    mock_response.parsed.skip_summary_reason = None

    with (
        patch("codemem.plugin_ingest.OBSERVER") as observer,
        patch("codemem.plugin_ingest.capture_pre_context") as pre,
        patch("codemem.plugin_ingest.capture_post_context") as post,
    ):
        observer.observe.return_value = mock_response
        pre.return_value = {"project": "test"}
        post.return_value = {"git_diff": "", "recent_files": ""}

        with patch.dict("os.environ", {"CODEMEM_DB": str(tmp_path / "mem.sqlite")}):
            result = flush_raw_events(
                store,
                opencode_session_id="sess",
                cwd=str(tmp_path),
                project="test",
                started_at="2026-01-01T00:00:00Z",
                max_events=None,
            )
            assert result["flushed"] == 2
            assert store.raw_event_flush_state("sess") == 1

            session_rows = store.conn.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()[0]
            assert int(session_rows) == 1

            summary_rows = store.conn.execute(
                "SELECT COUNT(*) AS n FROM session_summaries WHERE session_id = ?",
                (
                    store.get_or_create_opencode_session(
                        opencode_session_id="sess", cwd=str(tmp_path), project="test"
                    ),
                ),
            ).fetchone()[0]
            assert int(summary_rows) == 1

            memory_rows = store.conn.execute(
                "SELECT COUNT(*) AS n FROM memory_items WHERE session_id = ?",
                (
                    store.get_or_create_opencode_session(
                        opencode_session_id="sess", cwd=str(tmp_path), project="test"
                    ),
                ),
            ).fetchone()[0]
            assert int(memory_rows) >= 1

            result2 = flush_raw_events(
                store,
                opencode_session_id="sess",
                cwd=str(tmp_path),
                project="test",
                started_at="2026-01-01T00:00:00Z",
                max_events=None,
            )
            assert result2["flushed"] == 0

            artifact_rows = store.conn.execute(
                "SELECT COUNT(*) AS n FROM artifacts WHERE session_id = ?",
                (
                    store.get_or_create_opencode_session(
                        opencode_session_id="sess", cwd=str(tmp_path), project="test"
                    ),
                ),
            ).fetchone()[0]
            assert int(artifact_rows) > 0

    row = store.conn.execute(
        "SELECT status FROM raw_event_flush_batches WHERE opencode_session_id = ? AND extractor_version = ?",
        ("sess", EXTRACTOR_VERSION),
    ).fetchone()
    assert row is not None
    assert row["status"] == "completed"


def test_flush_raw_events_handles_ts_mono_reordering(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    store.record_raw_event(
        opencode_session_id="sess",
        event_id="evt-0",
        event_type="user_prompt",
        payload={"type": "user_prompt", "prompt_text": "Hello"},
        ts_wall_ms=100,
        ts_mono_ms=100.0,
    )
    store.record_raw_event(
        opencode_session_id="sess",
        event_id="evt-1",
        event_type="tool.execute.after",
        payload={"type": "tool.execute.after", "tool": "read", "args": {"filePath": "a"}},
        ts_wall_ms=200,
        ts_mono_ms=10.0,
    )
    store.record_raw_event(
        opencode_session_id="sess",
        event_id="evt-2",
        event_type="tool.execute.after",
        payload={"type": "tool.execute.after", "tool": "read", "args": {"filePath": "b"}},
        ts_wall_ms=300,
        ts_mono_ms=50.0,
    )

    captured: dict[str, object] = {}

    def fake_ingest(payload: dict[str, object]) -> None:
        captured["events"] = payload.get("events")

    with patch("codemem.raw_event_flush.ingest", fake_ingest):
        result = flush_raw_events(
            store,
            opencode_session_id="sess",
            cwd=str(tmp_path),
            project="test",
            started_at="2026-01-01T00:00:00Z",
            max_events=None,
        )

    assert result["flushed"] == 3
    assert store.raw_event_flush_state("sess") == 2

    ingested_events = captured.get("events")
    assert isinstance(ingested_events, list)
    assert [int(e.get("event_seq")) for e in ingested_events] == [0, 1, 2]


def test_flush_raw_events_marks_batch_error_when_observer_fails(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    store.record_raw_event(
        opencode_session_id="sess",
        event_id="evt-0",
        event_type="user_prompt",
        payload={"type": "user_prompt", "prompt_text": "Hello"},
        ts_wall_ms=100,
        ts_mono_ms=1.0,
    )
    store.record_raw_event(
        opencode_session_id="sess",
        event_id="evt-1",
        event_type="tool.execute.after",
        payload={"type": "tool.execute.after", "tool": "read", "args": {"filePath": "x"}},
        ts_wall_ms=200,
        ts_mono_ms=2.0,
    )

    mock_response = MagicMock()
    mock_response.raw = None

    with (
        patch("codemem.plugin_ingest.OBSERVER") as observer,
        patch("codemem.plugin_ingest.capture_pre_context") as pre,
        patch("codemem.plugin_ingest.capture_post_context") as post,
    ):
        observer.observe.return_value = mock_response
        pre.return_value = {"project": "test"}
        post.return_value = {"git_diff": "", "recent_files": ""}

        with patch.dict("os.environ", {"CODEMEM_DB": str(tmp_path / "mem.sqlite")}):
            try:
                flush_raw_events(
                    store,
                    opencode_session_id="sess",
                    cwd=str(tmp_path),
                    project="test",
                    started_at="2026-01-01T00:00:00Z",
                    max_events=None,
                )
            except RuntimeError as exc:
                assert "observer failed" in str(exc)
            else:
                raise AssertionError("Expected flush_raw_events to raise")

    assert store.raw_event_flush_state("sess") == -1
    row = store.conn.execute(
        "SELECT status FROM raw_event_flush_batches WHERE opencode_session_id = ? AND extractor_version = ?",
        ("sess", EXTRACTOR_VERSION),
    ).fetchone()
    assert row is not None
    assert row["status"] == "failed"


def test_flush_raw_events_chunked_resume_uses_checkpoint(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        for i in range(3):
            store.record_raw_event(
                opencode_session_id="sess-chunk",
                event_id=f"evt-{i}",
                event_type="user_prompt",
                payload={"type": "user_prompt", "prompt_text": f"P{i}"},
                ts_wall_ms=100 + i,
                ts_mono_ms=1.0 + i,
            )

        captured: list[int] = []

        def fake_ingest(payload: dict[str, object]) -> None:
            events = payload.get("events")
            assert isinstance(events, list)
            captured.append(len(events))

        with patch("codemem.raw_event_flush.ingest", fake_ingest):
            result1 = flush_raw_events(
                store,
                opencode_session_id="sess-chunk",
                cwd=str(tmp_path),
                project="test",
                started_at="2026-01-01T00:00:00Z",
                max_events=1,
            )
            assert result1 == {"flushed": 1, "updated_state": 1}
            assert store.raw_event_flush_state("sess-chunk") == 0

            result2 = flush_raw_events(
                store,
                opencode_session_id="sess-chunk",
                cwd=str(tmp_path),
                project="test",
                started_at="2026-01-01T00:00:00Z",
                max_events=1,
            )
            assert result2 == {"flushed": 1, "updated_state": 1}
            assert store.raw_event_flush_state("sess-chunk") == 1

            result3 = flush_raw_events(
                store,
                opencode_session_id="sess-chunk",
                cwd=str(tmp_path),
                project="test",
                started_at="2026-01-01T00:00:00Z",
                max_events=1,
            )
            assert result3 == {"flushed": 1, "updated_state": 1}
            assert store.raw_event_flush_state("sess-chunk") == 2

            result4 = flush_raw_events(
                store,
                opencode_session_id="sess-chunk",
                cwd=str(tmp_path),
                project="test",
                started_at="2026-01-01T00:00:00Z",
                max_events=1,
            )
            assert result4 == {"flushed": 0, "updated_state": 0}

        assert captured == [1, 1, 1]
    finally:
        store.close()


def test_flush_raw_events_chunking_does_not_skip_out_of_order_timestamps(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.record_raw_events_batch(
            opencode_session_id="sess-order",
            events=[
                {
                    "event_id": "evt-0",
                    "event_type": "user_prompt",
                    "payload": {"type": "user_prompt", "prompt_text": "A"},
                    "ts_wall_ms": 100,
                    "ts_mono_ms": 3.0,
                },
                {
                    "event_id": "evt-1",
                    "event_type": "tool.execute.after",
                    "payload": {"type": "tool.execute.after", "tool": "read"},
                    "ts_wall_ms": 101,
                    "ts_mono_ms": 1.0,
                },
                {
                    "event_id": "evt-2",
                    "event_type": "assistant_message",
                    "payload": {"type": "assistant_message", "content": "done"},
                    "ts_wall_ms": 102,
                    "ts_mono_ms": 2.0,
                },
            ],
        )

        captured: list[list[int]] = []

        def fake_ingest(payload: dict[str, object]) -> None:
            events = payload.get("events")
            assert isinstance(events, list)
            captured.append(
                [int(event["event_seq"]) for event in events if isinstance(event, dict)]
            )

        with patch("codemem.raw_event_flush.ingest", fake_ingest):
            assert flush_raw_events(
                store,
                opencode_session_id="sess-order",
                cwd=str(tmp_path),
                project="test",
                started_at="2026-01-01T00:00:00Z",
                max_events=1,
            ) == {"flushed": 1, "updated_state": 1}
            assert store.raw_event_flush_state("sess-order") == 0

            assert flush_raw_events(
                store,
                opencode_session_id="sess-order",
                cwd=str(tmp_path),
                project="test",
                started_at="2026-01-01T00:00:00Z",
                max_events=1,
            ) == {"flushed": 1, "updated_state": 1}
            assert store.raw_event_flush_state("sess-order") == 1

            assert flush_raw_events(
                store,
                opencode_session_id="sess-order",
                cwd=str(tmp_path),
                project="test",
                started_at="2026-01-01T00:00:00Z",
                max_events=1,
            ) == {"flushed": 1, "updated_state": 1}
            assert store.raw_event_flush_state("sess-order") == 2

        assert captured == [[0], [1], [2]]
    finally:
        store.close()
