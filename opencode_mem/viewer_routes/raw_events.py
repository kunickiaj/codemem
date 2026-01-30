from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Callable
from typing import Any, Protocol
from urllib.parse import parse_qs


class _ViewerHandler(Protocol):
    headers: Any
    rfile: Any

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None: ...


class _RawEventFlusher(Protocol):
    def note_activity(self, opencode_session_id: str) -> None: ...


class _Store(Protocol):
    conn: Any

    def raw_event_backlog_totals(self) -> dict[str, int]: ...

    def record_raw_events_batch(
        self, *, opencode_session_id: str, events: list[dict[str, Any]]
    ) -> dict: ...

    def update_raw_event_session_meta(
        self,
        *,
        opencode_session_id: str,
        cwd: str | None,
        project: str | None,
        started_at: str | None,
        last_seen_ts_wall_ms: int | None,
    ) -> None: ...

    def close(self) -> None: ...


def handle_get(handler: Any, store: Any, path: str, query: str) -> bool:
    if path != "/api/raw-events":
        return False
    # Compatibility endpoint used by the web UI stats panel.
    _ = parse_qs(query)
    handler._send_json(store.raw_event_backlog_totals())
    return True


def handle_post(
    handler: _ViewerHandler,
    *,
    path: str,
    store_factory: Callable[[str], _Store],
    default_db_path: str,
    flusher: _RawEventFlusher,
    strip_private_obj: Callable[[Any], Any],
) -> bool:
    if path != "/api/raw-events":
        return False

    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length).decode("utf-8") if length else ""
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        handler._send_json({"error": "invalid json"}, status=400)
        return True
    if not isinstance(payload, dict):
        handler._send_json({"error": "payload must be an object"}, status=400)
        return True

    try:
        store: _Store = store_factory(os.environ.get("OPENCODE_MEM_DB") or default_db_path)
    except Exception as exc:  # pragma: no cover
        response: dict[str, Any] = {"error": "internal server error"}
        if os.environ.get("OPENCODE_MEM_VIEWER_DEBUG") == "1":
            response["detail"] = str(exc)
        handler._send_json(response, status=500)
        return True

    try:
        cwd = payload.get("cwd")
        if cwd is not None and not isinstance(cwd, str):
            handler._send_json({"error": "cwd must be string"}, status=400)
            return True
        project = payload.get("project")
        if project is not None and not isinstance(project, str):
            handler._send_json({"error": "project must be string"}, status=400)
            return True
        started_at = payload.get("started_at")
        if started_at is not None and not isinstance(started_at, str):
            handler._send_json({"error": "started_at must be string"}, status=400)
            return True

        items = payload.get("events")
        if items is None:
            items = [payload]
        if not isinstance(items, list):
            handler._send_json({"error": "events must be a list"}, status=400)
            return True

        default_session_id = str(payload.get("opencode_session_id") or "")
        if default_session_id.startswith("msg_"):
            handler._send_json({"error": "invalid opencode_session_id"}, status=400)
            return True

        inserted = 0
        last_seen_by_session: dict[str, int] = {}
        meta_by_session: dict[str, dict[str, str]] = {}
        session_ids: set[str] = set()
        batch: list[dict[str, Any]] = []
        batch_by_session: dict[str, list[dict[str, Any]]] = {}
        for item in items:
            if not isinstance(item, dict):
                handler._send_json({"error": "event must be an object"}, status=400)
                return True
            opencode_session_id = str(item.get("opencode_session_id") or default_session_id or "")
            if not opencode_session_id:
                handler._send_json({"error": "opencode_session_id required"}, status=400)
                return True
            if opencode_session_id.startswith("msg_"):
                handler._send_json({"error": "invalid opencode_session_id"}, status=400)
                return True
            event_id = str(item.get("event_id") or "")
            event_type = str(item.get("event_type") or "")
            if not event_type:
                handler._send_json({"error": "event_type required"}, status=400)
                return True
            event_seq_value = item.get("event_seq")
            if event_seq_value is not None:
                try:
                    int(str(event_seq_value))
                except (TypeError, ValueError):
                    handler._send_json({"error": "event_seq must be int"}, status=400)
                    return True

            ts_wall_ms = item.get("ts_wall_ms")
            if ts_wall_ms is not None:
                try:
                    ts_wall_ms = int(ts_wall_ms)
                except (TypeError, ValueError):
                    handler._send_json({"error": "ts_wall_ms must be int"}, status=400)
                    return True
                last_seen_by_session[opencode_session_id] = max(
                    last_seen_by_session.get(opencode_session_id, ts_wall_ms),
                    ts_wall_ms,
                )
            ts_mono_ms = item.get("ts_mono_ms")
            if ts_mono_ms is not None:
                try:
                    ts_mono_ms = float(ts_mono_ms)
                except (TypeError, ValueError):
                    handler._send_json({"error": "ts_mono_ms must be number"}, status=400)
                    return True
            event_payload = item.get("payload")
            if event_payload is None:
                event_payload = {}
            if not isinstance(event_payload, dict):
                handler._send_json({"error": "payload must be an object"}, status=400)
                return True

            item_cwd = item.get("cwd")
            if item_cwd is not None and not isinstance(item_cwd, str):
                handler._send_json({"error": "cwd must be string"}, status=400)
                return True
            item_project = item.get("project")
            if item_project is not None and not isinstance(item_project, str):
                handler._send_json({"error": "project must be string"}, status=400)
                return True
            item_started_at = item.get("started_at")
            if item_started_at is not None and not isinstance(item_started_at, str):
                handler._send_json({"error": "started_at must be string"}, status=400)
                return True

            event_payload = strip_private_obj(event_payload)

            if not event_id:
                # Backwards-compat: derive a stable id for legacy senders.
                if event_seq_value is not None:
                    raw_id = json.dumps(
                        {"s": event_seq_value, "t": event_type, "p": event_payload},
                        sort_keys=True,
                        ensure_ascii=False,
                    )
                    event_hash = hashlib.sha256(raw_id.encode("utf-8")).hexdigest()[:16]
                    event_id = f"legacy-seq-{event_seq_value}-{event_hash}"
                else:
                    raw_id = json.dumps(
                        {
                            "t": event_type,
                            "p": event_payload,
                            "w": ts_wall_ms,
                            "m": ts_mono_ms,
                        },
                        sort_keys=True,
                        ensure_ascii=False,
                    )
                    event_id = "legacy-" + hashlib.sha256(raw_id.encode("utf-8")).hexdigest()[:16]
            event_entry = {
                "event_id": event_id,
                "event_type": event_type,
                "payload": event_payload,
                "ts_wall_ms": ts_wall_ms,
                "ts_mono_ms": ts_mono_ms,
            }
            batch.append(event_entry)

            session_ids.add(opencode_session_id)
            batch_by_session.setdefault(opencode_session_id, []).append(dict(event_entry))

            if item_cwd or item_project or item_started_at:
                per_session = meta_by_session.setdefault(opencode_session_id, {})
                if item_cwd:
                    per_session["cwd"] = item_cwd
                if item_project:
                    per_session["project"] = item_project
                if item_started_at:
                    per_session["started_at"] = item_started_at

        if len(session_ids) == 1:
            single_session_id = next(iter(session_ids))
            result = store.record_raw_events_batch(
                opencode_session_id=single_session_id, events=batch
            )
            inserted = int(result["inserted"])
        else:
            # Fallback: handle multiple sessions individually.
            for sid, sid_events in batch_by_session.items():
                result = store.record_raw_events_batch(opencode_session_id=sid, events=sid_events)
                inserted += int(result["inserted"])

        for meta_session_id in session_ids:
            session_meta = meta_by_session.get(meta_session_id, {})
            apply_request_meta = len(session_ids) == 1 or meta_session_id == default_session_id
            store.update_raw_event_session_meta(
                opencode_session_id=meta_session_id,
                cwd=session_meta.get("cwd") or (cwd if apply_request_meta else None),
                project=session_meta.get("project") or (project if apply_request_meta else None),
                started_at=session_meta.get("started_at")
                or (started_at if apply_request_meta else None),
                last_seen_ts_wall_ms=last_seen_by_session.get(meta_session_id),
            )
            flusher.note_activity(meta_session_id)

        handler._send_json({"inserted": inserted, "received": len(items)})
        return True
    except Exception as exc:  # pragma: no cover
        response: dict[str, Any] = {"error": "internal server error"}
        if os.environ.get("OPENCODE_MEM_VIEWER_DEBUG") == "1":
            response["detail"] = str(exc)
        handler._send_json(response, status=500)
        return True
    finally:
        store.close()
