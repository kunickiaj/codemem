from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from opencode_mem.raw_event_flush import EXTRACTOR_VERSION, flush_raw_events
from opencode_mem.store import MemoryStore
from opencode_mem.xml_parser import ParsedSummary


def test_flush_raw_events_is_idempotent(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    store.record_raw_event(
        opencode_session_id="sess",
        event_seq=0,
        event_type="user_prompt",
        payload={"type": "user_prompt", "prompt_text": "Hello"},
        ts_wall_ms=100,
        ts_mono_ms=1.0,
    )
    store.record_raw_event(
        opencode_session_id="sess",
        event_seq=1,
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
        patch("opencode_mem.plugin_ingest.OBSERVER") as observer,
        patch("opencode_mem.plugin_ingest.capture_pre_context") as pre,
        patch("opencode_mem.plugin_ingest.capture_post_context") as post,
    ):
        observer.observe.return_value = mock_response
        pre.return_value = {"project": "test"}
        post.return_value = {"git_diff": "", "recent_files": ""}

        with patch.dict("os.environ", {"OPENCODE_MEM_DB": str(tmp_path / "mem.sqlite")}):
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
