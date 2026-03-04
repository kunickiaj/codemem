from __future__ import annotations

import json
import logging
import os
import sys
from typing import Any

from codemem.claude_hooks import MAPPABLE_CLAUDE_HOOK_EVENTS, build_raw_event_envelope_from_hook
from codemem.db import DEFAULT_DB_PATH
from codemem.ingest_sanitize import _strip_private_obj
from codemem.raw_event_flush import flush_raw_events
from codemem.store import MemoryStore

ALLOWED_HOOK_EVENTS = frozenset(
    hook_event for hook_event in MAPPABLE_CLAUDE_HOOK_EVENTS if hook_event != "PreToolUse"
)
logger = logging.getLogger(__name__)


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


def _queue_adapter_event(hook_payload: dict[str, Any], *, store: Any) -> tuple[str, bool] | None:
    envelope = build_raw_event_envelope_from_hook(hook_payload)
    if envelope is None:
        logger.info(
            "claude hook payload skipped before enqueue",
            extra={
                "hook_event_name": str(hook_payload.get("hook_event_name") or ""),
                "session_id": str(hook_payload.get("session_id") or ""),
            },
        )
        return None

    stream_id = _adapter_stream_id(session_id=str(envelope["opencode_session_id"]))
    source = str(envelope.get("source") or "claude")
    payload = _strip_private_obj(envelope["payload"])
    inserted = store.record_raw_event(
        opencode_session_id=stream_id,
        source=source,
        event_id=str(envelope.get("event_id") or ""),
        event_type="claude.hook",
        payload=payload,
        ts_wall_ms=int(envelope.get("ts_wall_ms") or 0),
    )
    store.update_raw_event_session_meta(
        opencode_session_id=stream_id,
        source=source,
        cwd=envelope.get("cwd") if isinstance(envelope.get("cwd"), str) else None,
        project=envelope.get("project") if isinstance(envelope.get("project"), str) else None,
        started_at=envelope.get("started_at")
        if isinstance(envelope.get("started_at"), str)
        else None,
        last_seen_ts_wall_ms=int(envelope.get("ts_wall_ms") or 0),
    )
    return stream_id, inserted


def _should_flush(hook_event_name: str, *, default_flush: bool) -> bool:
    if hook_event_name not in {"Stop", "SessionEnd"}:
        return False
    if not _env_truthy("CODEMEM_CLAUDE_HOOK_FLUSH", default_flush):
        return False
    if hook_event_name == "SessionEnd":
        return True
    return _env_truthy("CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP", False)


def ingest_claude_hook_payload(
    hook_payload: dict[str, Any], *, flush_default: bool = False
) -> None:
    hook_event_name = str(hook_payload.get("hook_event_name") or "").strip()
    if hook_event_name not in ALLOWED_HOOK_EVENTS:
        logger.info(
            "claude hook payload ignored: unsupported event",
            extra={"hook_event_name": hook_event_name},
        )
        return
    should_flush = _should_flush(hook_event_name, default_flush=flush_default)
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
    ingest_claude_hook_payload(hook_payload, flush_default=False)
