from __future__ import annotations

import datetime as dt
import logging
import os
from typing import Any

from . import plugin_ingest
from .observer import ObserverAuthError
from .store import MemoryStore

EXTRACTOR_VERSION = "raw_events_v1"
logger = logging.getLogger(__name__)
ingest = plugin_ingest.ingest


def _truncate_error_message(message: str, *, limit: int = 280) -> str:
    text = " ".join(message.split())
    if len(text) <= limit:
        return text
    return f"{text[: limit - 3].rstrip()}..."


def _provider_display_name(provider: str | None) -> str:
    normalized = (provider or "").strip().lower()
    if normalized == "openai":
        return "OpenAI"
    if normalized == "anthropic":
        return "Anthropic"
    if normalized:
        return normalized.capitalize()
    return "Observer"


def _summarize_flush_failure(exc: Exception, *, provider: str | None) -> str:
    provider_title = _provider_display_name(provider)
    raw_message = str(exc).strip().lower()
    if isinstance(exc, ObserverAuthError):
        return f"{provider_title} authentication failed. Refresh credentials and retry."
    if isinstance(exc, TimeoutError):
        return f"{provider_title} request timed out during raw-event processing."
    if raw_message == "observer failed during raw-event flush":
        return f"{provider_title} returned no usable output for raw-event processing."
    if "parse" in raw_message or "xml" in raw_message or "json" in raw_message:
        return f"{provider_title} response could not be processed."
    return f"{provider_title} processing failed during raw-event ingestion."


def _flush_failure_details(exc: Exception) -> dict[str, str | None]:
    observer = plugin_ingest.OBSERVER
    active = observer.get_status() if observer is not None else None
    provider = (
        str(active.get("provider") or "").strip() or None if isinstance(active, dict) else None
    )
    model = str(active.get("model") or "").strip() or None if isinstance(active, dict) else None
    runtime = str(active.get("runtime") or "").strip() or None if isinstance(active, dict) else None
    last_error = active.get("last_error") if isinstance(active, dict) else None
    last_error_message = None
    last_error_code = None
    if isinstance(last_error, dict):
        last_error_message = str(last_error.get("message") or "").strip() or None
        last_error_code = str(last_error.get("code") or "").strip() or None
    logger.warning(
        "raw event flush failed",
        extra={
            "observer_provider": provider or "unknown",
            "observer_model": model or "unknown",
            "observer_runtime": runtime or "unknown",
            "error_type": exc.__class__.__name__,
        },
        exc_info=exc,
    )
    return {
        "message": _truncate_error_message(
            last_error_message or _summarize_flush_failure(exc, provider=provider)
        ),
        "error_type": last_error_code or exc.__class__.__name__,
        "observer_provider": provider,
        "observer_model": model,
        "observer_runtime": runtime,
    }


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
    source: str = "opencode",
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

    source = source.strip().lower() or "opencode"
    meta = store.raw_event_session_meta(opencode_session_id, source=source)
    if cwd is None:
        cwd = meta.get("cwd") or os.getcwd()
    if project is None:
        project = meta.get("project")
    if started_at is None:
        started_at = meta.get("started_at")

    last_flushed = store.raw_event_flush_state(opencode_session_id, source=source)
    events = store.raw_events_since_by_seq(
        opencode_session_id=opencode_session_id,
        source=source,
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
        source=source,
        start_event_seq=start_event_seq,
        end_event_seq=last_event_seq,
        extractor_version=EXTRACTOR_VERSION,
    )
    if status == "completed":
        store.update_raw_event_flush_state(opencode_session_id, last_event_seq, source=source)
        return {"flushed": 0, "updated_state": 1}

    if not store.claim_raw_event_flush_batch(batch_id):
        return {"flushed": 0, "updated_state": 0}
    session_context = build_session_context(events)
    session_context["opencode_session_id"] = opencode_session_id
    session_context["source"] = source
    session_context["stream_id"] = opencode_session_id
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
    except Exception as exc:
        details = _flush_failure_details(exc)
        store.record_raw_event_flush_batch_failure(
            batch_id,
            message=str(details["message"] or exc.__class__.__name__),
            error_type=str(details["error_type"] or exc.__class__.__name__),
            observer_provider=details["observer_provider"],
            observer_model=details["observer_model"],
            observer_runtime=details["observer_runtime"],
        )
        raise
    store.update_raw_event_flush_batch_status(batch_id, "completed")
    store.update_raw_event_flush_state(opencode_session_id, last_event_seq, source=source)
    return {"flushed": len(events), "updated_state": 1}
