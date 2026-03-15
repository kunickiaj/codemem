from __future__ import annotations

from typing import Any
from unittest.mock import patch

from codemem.viewer_routes import observer_status


class DummyHandler:
    def __init__(self) -> None:
        self.response: dict[str, Any] | None = None
        self.status: int | None = None

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        self.response = payload
        self.status = status


class DummyStore:
    def __init__(self, latest_failure: dict[str, Any] | None = None) -> None:
        self._latest_failure = latest_failure

    def raw_event_backlog_totals(self) -> dict[str, int]:
        return {"sessions": 2, "pending": 14}

    def latest_raw_event_flush_failure(self, *, source: str | None = None) -> dict[str, Any] | None:
        _ = source
        return self._latest_failure


def test_handle_get_returns_latest_failure_details() -> None:
    handler = DummyHandler()
    store = DummyStore(
        latest_failure={
            "stream_id": "sess-1",
            "status": "error",
            "updated_at": "2026-03-15T20:00:00Z",
            "attempt_count": 3,
            "error_message": "observer anthropic oauth call failed",
            "error_type": "RuntimeError",
            "observer_provider": "anthropic",
            "observer_model": "claude-4.5-haiku",
            "observer_runtime": "api_http",
        }
    )

    with (
        patch.object(
            observer_status,
            "probe_available_credentials",
            return_value={"anthropic": {"oauth": True}},
        ),
        patch.object(observer_status._plugin_ingest, "OBSERVER", None),
        patch.object(
            observer_status.RAW_EVENT_SWEEPER,
            "auth_backoff_status",
            return_value={"active": False, "remaining_s": 0},
        ),
    ):
        handled = observer_status.handle_get(handler, store, "/api/observer-status")

    assert handled is True
    assert handler.status == 200
    assert handler.response is not None
    assert handler.response["queue"] == {
        "sessions": 2,
        "pending": 14,
        "auth_backoff_active": False,
        "auth_backoff_remaining_s": 0,
    }
    assert handler.response["latest_failure"]["observer_provider"] == "anthropic"
    assert "waiting on a successful flush" in handler.response["latest_failure"]["impact"]


def test_handle_get_reports_auth_backoff_impact() -> None:
    handler = DummyHandler()
    store = DummyStore(
        latest_failure={
            "stream_id": "sess-2",
            "status": "error",
            "updated_at": "2026-03-15T20:00:00Z",
            "attempt_count": 1,
            "error_message": "observer auth error",
            "error_type": "ObserverAuthError",
            "observer_provider": "anthropic",
            "observer_model": "claude-4.5-haiku",
            "observer_runtime": "api_http",
        }
    )

    with (
        patch.object(observer_status, "probe_available_credentials", return_value={}),
        patch.object(observer_status._plugin_ingest, "OBSERVER", None),
        patch.object(
            observer_status.RAW_EVENT_SWEEPER,
            "auth_backoff_status",
            return_value={"active": True, "remaining_s": 287},
        ),
    ):
        observer_status.handle_get(handler, store, "/api/observer-status")

    assert handler.response is not None
    assert handler.response["queue"]["auth_backoff_active"] is True
    assert handler.response["queue"]["auth_backoff_remaining_s"] == 287
    assert "paused for ~287s" in handler.response["latest_failure"]["impact"]
