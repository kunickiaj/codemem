from __future__ import annotations

import contextlib
from pathlib import Path
from unittest.mock import MagicMock, patch

from opencode_mem.raw_event_flush import flush_raw_events
from opencode_mem.store import MemoryStore
from opencode_mem.xml_parser import ParsedSummary


def test_raw_event_retry_from_error_batch(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    store.record_raw_event(
        opencode_session_id="sess-retry",
        event_seq=0,
        event_type="user_prompt",
        payload={"type": "user_prompt", "prompt_text": "Hello"},
        ts_wall_ms=100,
        ts_mono_ms=1.0,
    )
    store.record_raw_event(
        opencode_session_id="sess-retry",
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
        patch.dict("os.environ", {"OPENCODE_MEM_DB": str(tmp_path / "mem.sqlite")}),
    ):
        observer.observe.side_effect = RuntimeError("boom")
        pre.return_value = {"project": "test"}
        post.return_value = {"git_diff": "", "recent_files": ""}

        with contextlib.suppress(RuntimeError):
            flush_raw_events(
                store,
                opencode_session_id="sess-retry",
                cwd=str(tmp_path),
                project="test",
                started_at="2026-01-01T00:00:00Z",
            )

        errors = store.raw_event_error_batches("sess-retry", limit=10)
        assert len(errors) == 1
        assert errors[0]["status"] == "error"

        observer.observe.side_effect = None
        observer.observe.return_value = mock_response
        # Simulate retry behavior by rewinding flush state and calling flush again.
        store.update_raw_event_flush_state("sess-retry", -1)
        result = flush_raw_events(
            store,
            opencode_session_id="sess-retry",
            cwd=str(tmp_path),
            project="test",
            started_at="2026-01-01T00:00:00Z",
        )
        assert result["flushed"] == 2
        assert store.raw_event_error_batches("sess-retry", limit=10) == []
