from __future__ import annotations

import datetime as dt
import json
import os
import sys
from typing import Any

from codemem.claude_hooks import MAPPABLE_CLAUDE_HOOK_EVENTS, map_claude_hook_payload
from codemem.db import DEFAULT_DB_PATH
from codemem.ingest_sanitize import _strip_private
from codemem.raw_event_flush import flush_raw_events
from codemem.store import MemoryStore

ALLOWED_HOOK_EVENTS = frozenset(
    hook_event for hook_event in MAPPABLE_CLAUDE_HOOK_EVENTS if hook_event != "PreToolUse"
)


def _env_truthy(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _adapter_stream_id(*, session_id: str) -> str:
    return session_id


def _hook_stream_id(hook_payload: dict[str, Any]) -> str | None:
    session_id = str(hook_payload.get("session_id") or "").strip()
    if not session_id:
        return None
    return _adapter_stream_id(
        session_id=session_id,
    )


def _iso_to_wall_ms(ts: str | None) -> int:
    if isinstance(ts, str) and ts.strip():
        try:
            parsed = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=dt.UTC)
            return int(parsed.timestamp() * 1000)
        except ValueError:
            pass
    return int(dt.datetime.now(dt.UTC).timestamp() * 1000)


def _strip_private_obj(value: Any) -> Any:
    if isinstance(value, str):
        return _strip_private(value)
    if isinstance(value, list):
        return [_strip_private_obj(item) for item in value]
    if isinstance(value, dict):
        return {key: _strip_private_obj(item) for key, item in value.items()}
    return value


def _queue_adapter_event(hook_payload: dict[str, Any], *, store: Any) -> tuple[str, bool] | None:
    adapter_event = map_claude_hook_payload(hook_payload)
    if adapter_event is None:
        return None
    source = str(adapter_event.get("source") or "claude")
    session_id = str(adapter_event.get("session_id") or "").strip()
    if not session_id:
        return None
    stream_id = _adapter_stream_id(
        session_id=session_id,
    )
    ts = str(adapter_event.get("ts") or "")
    payload = {
        "type": "claude.hook",
        "timestamp": ts,
        "_adapter": adapter_event,
    }
    payload = _strip_private_obj(payload)
    inserted = store.record_raw_event(
        opencode_session_id=stream_id,
        source=source,
        event_id=str(adapter_event.get("event_id") or ""),
        event_type="claude.hook",
        payload=payload,
        ts_wall_ms=_iso_to_wall_ms(ts),
    )
    store.update_raw_event_session_meta(
        opencode_session_id=stream_id,
        source=source,
        cwd=hook_payload.get("cwd") if isinstance(hook_payload.get("cwd"), str) else None,
        project=hook_payload.get("project")
        if isinstance(hook_payload.get("project"), str)
        else None,
        started_at=ts if str(hook_payload.get("hook_event_name") or "") == "SessionStart" else None,
        last_seen_ts_wall_ms=_iso_to_wall_ms(ts),
    )
    return stream_id, inserted


def _should_flush(hook_event_name: str) -> bool:
    if hook_event_name not in {"Stop", "SessionEnd"}:
        return False
    if not _env_truthy("CODEMEM_CLAUDE_HOOK_FLUSH", True):
        return False
    if hook_event_name == "SessionEnd":
        return True
    return _env_truthy("CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP", False)


def ingest_claude_hook_cmd() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        return
    try:
        hook_payload = json.loads(raw)
    except json.JSONDecodeError:
        return
    if not isinstance(hook_payload, dict):
        return
    hook_event_name = str(hook_payload.get("hook_event_name") or "").strip()
    if hook_event_name not in ALLOWED_HOOK_EVENTS:
        return
    should_flush = _should_flush(hook_event_name)
    db_path = os.environ.get("CODEMEM_DB") or DEFAULT_DB_PATH
    store = MemoryStore(db_path)
    try:
        queued = _queue_adapter_event(hook_payload, store=store)
        if queued is None:
            if should_flush:
                stream_id = _hook_stream_id(hook_payload)
                if not stream_id:
                    return
                flush_raw_events(
                    store,
                    opencode_session_id=stream_id,
                    source="claude",
                    cwd=hook_payload.get("cwd")
                    if isinstance(hook_payload.get("cwd"), str)
                    else None,
                    project=hook_payload.get("project")
                    if isinstance(hook_payload.get("project"), str)
                    else None,
                    started_at=None,
                    max_events=None,
                )
            return
        stream_id, _ = queued
        if not should_flush:
            return
        flush_raw_events(
            store,
            opencode_session_id=stream_id,
            source="claude",
            cwd=hook_payload.get("cwd") if isinstance(hook_payload.get("cwd"), str) else None,
            project=hook_payload.get("project")
            if isinstance(hook_payload.get("project"), str)
            else None,
            started_at=None,
            max_events=None,
        )
    finally:
        store.close()
