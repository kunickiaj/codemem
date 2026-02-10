from __future__ import annotations

import io
import json
from typing import Any

from opencode_mem.viewer_routes import raw_events


class DummyHandler:
    def __init__(self, body: bytes, content_length: int) -> None:
        self.headers = {"Content-Length": str(content_length)}
        self.rfile = io.BytesIO(body)
        self.response: dict[str, Any] | None = None
        self.status: int | None = None

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        self.response = payload
        self.status = status


class DummyFlusher:
    def __init__(self) -> None:
        self.noted: list[str] = []

    def note_activity(self, opencode_session_id: str) -> None:
        self.noted.append(opencode_session_id)


class DummyStore:
    def __init__(self) -> None:
        self.conn: Any = None
        self.closed = False
        self.recorded_batches: list[tuple[str, list[dict[str, Any]]]] = []
        self.meta_updates: list[dict[str, Any]] = []

    def raw_event_backlog_totals(self) -> dict[str, int]:
        return {}

    def record_raw_events_batch(
        self, *, opencode_session_id: str, events: list[dict[str, Any]]
    ) -> dict[str, int]:
        self.recorded_batches.append((opencode_session_id, events))
        return {"inserted": len(events)}

    def update_raw_event_session_meta(
        self,
        *,
        opencode_session_id: str,
        cwd: str | None,
        project: str | None,
        started_at: str | None,
        last_seen_ts_wall_ms: int | None,
    ) -> None:
        self.meta_updates.append(
            {
                "opencode_session_id": opencode_session_id,
                "cwd": cwd,
                "project": project,
                "started_at": started_at,
                "last_seen_ts_wall_ms": last_seen_ts_wall_ms,
            }
        )

    def close(self) -> None:
        self.closed = True


def test_handle_post_rejects_oversized_payload(monkeypatch) -> None:
    payload = {
        "opencode_session_id": "sess-1",
        "event_type": "tool.execute.after",
        "payload": {"tool": "read"},
    }
    body = json.dumps(payload).encode("utf-8")
    handler = DummyHandler(body=body, content_length=len(body))
    flusher = DummyFlusher()
    store = DummyStore()
    store_factory_called = False

    def store_factory(_db_path: str) -> DummyStore:
        nonlocal store_factory_called
        store_factory_called = True
        return store

    monkeypatch.setattr(raw_events, "MAX_RAW_EVENTS_BODY_BYTES", len(body) - 1)

    handled = raw_events.handle_post(
        handler,
        path="/api/raw-events",
        store_factory=store_factory,
        default_db_path="/tmp/mem.sqlite",
        flusher=flusher,
        strip_private_obj=lambda value: value,
    )

    assert handled is True
    assert handler.status == 413
    assert handler.response == {
        "error": "payload too large",
        "max_bytes": len(body) - 1,
    }
    assert store_factory_called is False
    assert store.closed is False
    assert flusher.noted == []


def test_handle_post_accepts_payload_within_size_limit(monkeypatch) -> None:
    payload = {
        "opencode_session_id": "sess-1",
        "event_type": "tool.execute.after",
        "payload": {"tool": "read"},
        "ts_wall_ms": 123,
    }
    body = json.dumps(payload).encode("utf-8")
    handler = DummyHandler(body=body, content_length=len(body))
    flusher = DummyFlusher()
    store = DummyStore()

    def store_factory(_db_path: str) -> DummyStore:
        return store

    monkeypatch.setattr(raw_events, "MAX_RAW_EVENTS_BODY_BYTES", len(body))

    handled = raw_events.handle_post(
        handler,
        path="/api/raw-events",
        store_factory=store_factory,
        default_db_path="/tmp/mem.sqlite",
        flusher=flusher,
        strip_private_obj=lambda value: value,
    )

    assert handled is True
    assert handler.status == 200
    assert handler.response == {"inserted": 1, "received": 1}
    assert store.recorded_batches[0][0] == "sess-1"
    assert store.recorded_batches[0][1][0]["event_type"] == "tool.execute.after"
    assert store.meta_updates[0]["last_seen_ts_wall_ms"] == 123
    assert store.closed is True
    assert flusher.noted == ["sess-1"]
