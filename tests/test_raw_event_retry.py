from __future__ import annotations

import contextlib
from pathlib import Path
from unittest.mock import MagicMock, patch

from codemem.raw_event_flush import flush_raw_events
from codemem.store import MemoryStore
from codemem.xml_parser import ParsedSummary


def test_raw_event_retry_from_error_batch(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    store.record_raw_event(
        opencode_session_id="sess-retry",
        event_id="evt-0",
        event_type="user_prompt",
        payload={"type": "user_prompt", "prompt_text": "Hello"},
        ts_wall_ms=100,
        ts_mono_ms=1.0,
    )
    store.record_raw_event(
        opencode_session_id="sess-retry",
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
        patch.dict("os.environ", {"CODEMEM_DB": str(tmp_path / "mem.sqlite")}),
    ):
        observer.observe.side_effect = RuntimeError("boom")
        observer.get_status.return_value = {
            "provider": "openai",
            "model": "gpt-5.1-codex-mini",
            "runtime": "api_http",
        }
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
        assert errors[0]["error_type"] == "RuntimeError"
        assert errors[0]["error_message"] == "OpenAI processing failed during raw-event ingestion."

        latest_failure = store.latest_raw_event_flush_failure()
        assert latest_failure is not None
        assert latest_failure["stream_id"] == "sess-retry"
        assert latest_failure["observer_provider"] == "openai"
        assert latest_failure["observer_runtime"] == "api_http"

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
        assert store.latest_raw_event_flush_failure() is None


def test_raw_event_retry_replaces_stale_failure_details_when_batch_gets_stuck(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    batch_id, _ = store.get_or_create_raw_event_flush_batch(
        opencode_session_id="sess-stuck",
        start_event_seq=0,
        end_event_seq=1,
        extractor_version="v1",
    )
    store.record_raw_event_flush_batch_failure(
        batch_id,
        message="Anthropic processing failed during raw-event ingestion.",
        error_type="RuntimeError",
        observer_provider="anthropic",
        observer_model="claude-4.5-haiku",
        observer_runtime="api_http",
    )

    claimed = store.claim_raw_event_flush_batch(batch_id)
    assert claimed is True

    changed = store.mark_stuck_raw_event_batches_as_error(
        older_than_iso="9999-01-01T00:00:00+00:00",
        limit=10,
    )
    assert changed == 1

    latest_failure = store.latest_raw_event_flush_failure()
    assert latest_failure is not None
    assert latest_failure["error_type"] == "RawEventBatchStuck"
    assert latest_failure["error_message"] == "Flush retry timed out."
    assert latest_failure["observer_provider"] is None
    assert latest_failure["observer_model"] is None
    assert latest_failure["observer_runtime"] is None


def test_raw_event_retry_uses_observer_last_error_details(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    store.record_raw_event(
        opencode_session_id="sess-invalid-model",
        event_id="evt-0",
        event_type="user_prompt",
        payload={"type": "user_prompt", "prompt_text": "Hello"},
        ts_wall_ms=100,
        ts_mono_ms=1.0,
    )

    with (
        patch("codemem.plugin_ingest.OBSERVER") as observer,
        patch("codemem.plugin_ingest.capture_pre_context", return_value={"project": "test"}),
        patch(
            "codemem.plugin_ingest.capture_post_context",
            return_value={"git_diff": "", "recent_files": ""},
        ),
        patch.dict("os.environ", {"CODEMEM_DB": str(tmp_path / "mem.sqlite")}),
    ):
        observer.observe.side_effect = RuntimeError("observer failed during raw-event flush")
        observer.get_status.return_value = {
            "provider": "anthropic",
            "model": "claude-4.5-haiku",
            "runtime": "api_http",
            "last_error": {
                "code": "invalid_model_id",
                "message": "Anthropic model ID not found: claude-4.5-haiku.",
            },
        }

        with contextlib.suppress(RuntimeError):
            flush_raw_events(
                store,
                opencode_session_id="sess-invalid-model",
                cwd=str(tmp_path),
                project="test",
                started_at="2026-01-01T00:00:00Z",
            )

    latest_failure = store.latest_raw_event_flush_failure()
    assert latest_failure is not None
    assert latest_failure["error_type"] == "invalid_model_id"
    assert latest_failure["error_message"] == "Anthropic model ID not found: claude-4.5-haiku."
