from __future__ import annotations

import datetime as dt
import os
from typing import Any

from .plugin_ingest import ingest
from .store import MemoryStore
from .store.raw_events import RAW_EVENT_QUEUE_FAILED

EXTRACTOR_VERSION = "raw_events_v1"


def build_session_context(events: list[dict[str, Any]]) -> dict[str, Any]:
    prompt_count = sum(1 for e in events if e.get("type") == "user_prompt")
    tool_count = sum(1 for e in events if e.get("type") == "tool.execute.after")

    ts_values = []
    for e in events:
        ts = e.get("timestamp_wall_ms")
        if ts is None:
            continue
        try:
            ts_values.append(int(ts))
        except (TypeError, ValueError):
            continue
    duration_ms = 0
    if ts_values:
        duration_ms = max(0, max(ts_values) - min(ts_values))

    files_modified: set[str] = set()
    files_read: set[str] = set()
    for e in events:
        if e.get("type") != "tool.execute.after":
            continue
        tool = str(e.get("tool") or "").lower()
        args = e.get("args") or {}
        if not isinstance(args, dict):
            continue
        file_path = args.get("filePath") or args.get("path")
        if not isinstance(file_path, str) or not file_path:
            continue
        if tool in {"write", "edit"}:
            files_modified.add(file_path)
        if tool == "read":
            files_read.add(file_path)

    first_prompt = None
    for e in events:
        if e.get("type") != "user_prompt":
            continue
        text = e.get("prompt_text")
        if isinstance(text, str) and text.strip():
            first_prompt = text.strip()
            break

    return {
        "first_prompt": first_prompt,
        "prompt_count": prompt_count,
        "tool_count": tool_count,
        "duration_ms": duration_ms,
        "files_modified": sorted(files_modified),
        "files_read": sorted(files_read),
    }


def flush_raw_events(
    store: MemoryStore,
    *,
    opencode_session_id: str,
    cwd: str | None,
    project: str | None,
    started_at: str | None,
    max_events: int | None = None,
) -> dict[str, int]:
    def _event_seq(value: Any, fallback: int) -> int:
        if value is None:
            return fallback
        try:
            return int(value)
        except (TypeError, ValueError):
            return fallback

    def _event_seq_opt(value: Any) -> int | None:
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    meta = store.raw_event_session_meta(opencode_session_id)
    if cwd is None:
        cwd = meta.get("cwd") or os.getcwd()
    if project is None:
        project = meta.get("project")
    if started_at is None:
        started_at = meta.get("started_at")

    last_flushed = store.raw_event_flush_state(opencode_session_id)
    events = store.raw_events_since_by_seq(
        opencode_session_id=opencode_session_id,
        after_event_seq=last_flushed,
        limit=max_events,
    )
    if not events:
        return {"flushed": 0, "updated_state": 0}

    event_seqs = [_event_seq_opt(e.get("event_seq")) for e in events]
    event_seqs = [seq for seq in event_seqs if seq is not None]
    if not event_seqs:
        return {"flushed": 0, "updated_state": 0}

    start_event_seq = min(event_seqs)
    last_event_seq = max(event_seqs)
    if last_event_seq < start_event_seq:
        return {"flushed": 0, "updated_state": 0}

    batch_id, status = store.get_or_create_raw_event_flush_batch(
        opencode_session_id=opencode_session_id,
        start_event_seq=start_event_seq,
        end_event_seq=last_event_seq,
        extractor_version=EXTRACTOR_VERSION,
    )
    if status == "completed":
        store.update_raw_event_flush_state(opencode_session_id, last_event_seq)
        return {"flushed": 0, "updated_state": 1}

    if not store.claim_raw_event_flush_batch(batch_id):
        return {"flushed": 0, "updated_state": 0}
    session_context = build_session_context(events)
    session_context["opencode_session_id"] = opencode_session_id
    session_context["start_event_seq"] = start_event_seq
    session_context["end_event_seq"] = last_event_seq
    session_context["flusher"] = "raw_events"
    session_context["extractor_version"] = EXTRACTOR_VERSION
    session_context["flush_batch"] = {
        "batch_id": batch_id,
        "start_event_seq": start_event_seq,
        "end_event_seq": last_event_seq,
    }

    payload = {
        "cwd": cwd,
        "project": project,
        "started_at": started_at or dt.datetime.now(dt.UTC).isoformat(),
        "events": events,
        "session_context": session_context,
    }
    try:
        ingest(payload)
    except Exception:
        store.update_raw_event_flush_batch_status(batch_id, RAW_EVENT_QUEUE_FAILED)
        raise
    store.update_raw_event_flush_batch_status(batch_id, "completed")
    store.update_raw_event_flush_state(opencode_session_id, last_event_seq)
    return {"flushed": len(events), "updated_state": 1}
