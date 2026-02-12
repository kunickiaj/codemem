from __future__ import annotations

import io
import json
from typing import Any

from codemem.viewer_routes import raw_events


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

    def raw_event_backlog(self, *, limit: int = 25) -> list[dict[str, Any]]:
        _ = limit
        return []

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


def test_handle_post_accepts_session_lifecycle_event_types() -> None:
    events = [
        {
            "opencode_session_id": "sess-lifecycle",
            "event_id": "evt-created",
            "event_type": "session.created",
            "payload": {"type": "session.created"},
            "ts_wall_ms": 100,
        },
        {
            "opencode_session_id": "sess-lifecycle",
            "event_id": "evt-idle",
            "event_type": "session.idle",
            "payload": {"type": "session.idle"},
            "ts_wall_ms": 200,
        },
        {
            "opencode_session_id": "sess-lifecycle",
            "event_id": "evt-error",
            "event_type": "session.error",
            "payload": {"type": "session.error"},
            "ts_wall_ms": 300,
        },
    ]
    body_payload = {
        "events": events,
        "cwd": "/tmp/project",
        "project": "proj",
        "started_at": "2026-01-01T00:00:00Z",
    }
    body = json.dumps(body_payload).encode("utf-8")
    handler = DummyHandler(body=body, content_length=len(body))
    flusher = DummyFlusher()
    store = DummyStore()

    handled = raw_events.handle_post(
        handler,
        path="/api/raw-events",
        store_factory=lambda _db_path: store,
        default_db_path="/tmp/mem.sqlite",
        flusher=flusher,
        strip_private_obj=lambda value: value,
    )

    assert handled is True
    assert handler.status == 200
    assert handler.response == {"inserted": 3, "received": 3}
    assert [event["event_type"] for event in store.recorded_batches[0][1]] == [
        "session.created",
        "session.idle",
        "session.error",
    ]
    assert store.meta_updates[0]["started_at"] == "2026-01-01T00:00:00Z"
    assert store.meta_updates[0]["last_seen_ts_wall_ms"] == 300
    assert flusher.noted == ["sess-lifecycle"]


def test_handle_post_rejects_invalid_content_length() -> None:
    payload = {
        "opencode_session_id": "sess-1",
        "event_type": "tool.execute.after",
        "payload": {"tool": "read"},
    }
    body = json.dumps(payload).encode("utf-8")
    handler = DummyHandler(body=body, content_length=len(body))
    handler.headers["Content-Length"] = "not-an-int"
    flusher = DummyFlusher()
    store = DummyStore()

    handled = raw_events.handle_post(
        handler,
        path="/api/raw-events",
        store_factory=lambda _db_path: store,
        default_db_path="/tmp/mem.sqlite",
        flusher=flusher,
        strip_private_obj=lambda value: value,
    )

    assert handled is True
    assert handler.status == 400
    assert handler.response == {"error": "invalid content-length"}


def test_handle_post_rejects_negative_content_length() -> None:
    handler = DummyHandler(body=b"", content_length=-1)
    flusher = DummyFlusher()
    store = DummyStore()

    handled = raw_events.handle_post(
        handler,
        path="/api/raw-events",
        store_factory=lambda _db_path: store,
        default_db_path="/tmp/mem.sqlite",
        flusher=flusher,
        strip_private_obj=lambda value: value,
    )

    assert handled is True
    assert handler.status == 400
    assert handler.response == {"error": "invalid content-length"}


def test_handle_post_flusher_failure_does_not_fail_ingest() -> None:
    payload = {
        "opencode_session_id": "sess-1",
        "event_type": "tool.execute.after",
        "payload": {"tool": "read"},
        "ts_wall_ms": 123,
    }
    body = json.dumps(payload).encode("utf-8")
    handler = DummyHandler(body=body, content_length=len(body))
    store = DummyStore()

    class FailingFlusher:
        def note_activity(self, opencode_session_id: str) -> None:
            _ = opencode_session_id
            raise RuntimeError("flush failed")

    handled = raw_events.handle_post(
        handler,
        path="/api/raw-events",
        store_factory=lambda _db_path: store,
        default_db_path="/tmp/mem.sqlite",
        flusher=FailingFlusher(),
        strip_private_obj=lambda value: value,
    )

    assert handled is True
    assert handler.status == 200
    assert handler.response == {"inserted": 1, "received": 1}


def test_handle_get_raw_events_status_returns_items_and_totals() -> None:
    class StatusStore(DummyStore):
        def raw_event_backlog(self, *, limit: int = 25) -> list[dict[str, Any]]:
            return [{"opencode_session_id": "sess", "pending": limit}]

        def raw_event_backlog_totals(self) -> dict[str, int]:
            return {"sessions": 1, "pending": 7}

    handler = DummyHandler(body=b"", content_length=0)
    store = StatusStore()

    handled = raw_events.handle_get(
        handler,
        store,
        "/api/raw-events/status",
        "limit=7",
    )

    assert handled is True
    assert handler.status == 200
    assert handler.response == {
        "items": [{"opencode_session_id": "sess", "pending": 7}],
        "totals": {"sessions": 1, "pending": 7},
        "ingest": {
            "available": True,
            "mode": "stream_queue",
            "max_body_bytes": raw_events.MAX_RAW_EVENTS_BODY_BYTES,
        },
    }


def test_handle_get_raw_events_status_rejects_bad_limit() -> None:
    handler = DummyHandler(body=b"", content_length=0)
    store = DummyStore()

    handled = raw_events.handle_get(
        handler,
        store,
        "/api/raw-events/status",
        "limit=nope",
    )

    assert handled is True
    assert handler.status == 400
    assert handler.response == {"error": "limit must be int"}
