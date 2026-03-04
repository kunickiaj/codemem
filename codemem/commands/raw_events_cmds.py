from __future__ import annotations

import json
import sys
from typing import Any

import typer
from rich import print

from codemem.ingest_sanitize import _strip_private_obj
from codemem.store import MemoryStore


def _coerce_optional_str(payload: dict[str, Any], key: str) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{key} must be string")
    text = value.strip()
    return text or None


def _require_non_empty_str(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str):
        raise ValueError(f"{key} must be string")
    text = value.strip()
    if not text:
        raise ValueError(f"{key} required")
    return text


def _coerce_optional_int(payload: dict[str, Any], key: str) -> int | None:
    value = payload.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{key} must be int")
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} must be int") from exc


def _coerce_optional_float(payload: dict[str, Any], key: str) -> float | None:
    value = payload.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise ValueError(f"{key} must be number")
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} must be number") from exc


def enqueue_raw_event_cmd(store: MemoryStore) -> None:
    """Read one raw event from stdin and enqueue it."""

    raw = sys.stdin.read()
    if not raw.strip():
        raise typer.BadParameter("stdin payload required")

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise typer.BadParameter("stdin must be valid JSON object") from exc
    if not isinstance(payload, dict):
        raise typer.BadParameter("payload must be an object")

    try:
        opencode_session_id = _require_non_empty_str(payload, "opencode_session_id")
        source = _coerce_optional_str(payload, "source") or "opencode"
        event_type = _require_non_empty_str(payload, "event_type")
        event_payload = payload.get("payload")
        if event_payload is None:
            event_payload = {}
        if not isinstance(event_payload, dict):
            raise ValueError("payload must be an object")

        event_id_value = payload.get("event_id")
        if event_id_value is None:
            event_id_value = event_payload.get("_raw_event_id")
        if event_id_value is None:
            raise ValueError("event_id required")
        if not isinstance(event_id_value, str):
            raise ValueError("event_id must be string")
        event_id = event_id_value.strip()
        if not event_id:
            raise ValueError("event_id required")

        ts_wall_ms = _coerce_optional_int(payload, "ts_wall_ms")
        ts_mono_ms = _coerce_optional_float(payload, "ts_mono_ms")
        cwd = _coerce_optional_str(payload, "cwd")
        project = _coerce_optional_str(payload, "project")
        started_at = _coerce_optional_str(payload, "started_at")
    except ValueError as exc:
        raise typer.BadParameter(str(exc)) from exc

    event_payload = _strip_private_obj(event_payload)

    inserted = store.record_raw_event(
        opencode_session_id=opencode_session_id,
        source=source,
        event_id=event_id,
        event_type=event_type,
        payload=event_payload,
        ts_wall_ms=ts_wall_ms,
        ts_mono_ms=ts_mono_ms,
    )
    store.update_raw_event_session_meta(
        opencode_session_id=opencode_session_id,
        source=source,
        cwd=cwd,
        project=project,
        started_at=started_at,
        last_seen_ts_wall_ms=ts_wall_ms,
    )
    print(json.dumps({"inserted": int(inserted)}))


def flush_raw_events_cmd(
    store: MemoryStore,
    *,
    opencode_session_id: str,
    source: str,
    cwd: str | None,
    project: str | None,
    started_at: str | None,
    max_events: int | None,
) -> None:
    """Flush spooled raw events into the normal ingest pipeline."""

    from codemem.raw_event_flush import flush_raw_events as flush

    result = flush(
        store,
        opencode_session_id=opencode_session_id,
        source=source,
        cwd=cwd,
        project=project,
        started_at=started_at,
        max_events=max_events,
    )
    print(f"Flushed {result['flushed']} events")


def raw_events_status_cmd(store: MemoryStore, *, limit: int) -> None:
    """Show pending raw-event backlog by OpenCode session."""

    items = store.raw_event_backlog(limit=limit)
    if not items:
        print("No pending raw events")
        return
    for item in items:
        source = str(item.get("source") or "opencode")
        stream_id = str(item.get("stream_id") or item["opencode_session_id"])
        legacy_counts = store.raw_event_batch_status_counts(stream_id, source=source)
        queue_counts = store.raw_event_queue_status_counts(stream_id, source=source)
        print(
            f"- {source}:{stream_id} pending={item['pending']} "
            f"max_seq={item['max_seq']} last_flushed={item['last_flushed_event_seq']} "
            f"batches=started:{legacy_counts['started']} running:{legacy_counts['running']} error:{legacy_counts['error']} completed:{legacy_counts['completed']} "
            f"queue=pending:{queue_counts['pending']} claimed:{queue_counts['claimed']} failed:{queue_counts['failed']} done:{queue_counts['completed']} "
            f"project={item.get('project') or ''}"
        )


def claude_integration_status_cmd(
    store: MemoryStore,
    *,
    limit: int,
    observer_runtime: str,
    claude_command: list[str],
    sweeper_interval_s: int,
) -> None:
    claude_items = store.raw_event_backlog(limit=limit, source="claude")

    pending_events = 0
    running_streams = 0
    errored_streams = 0
    queue_claimed = 0
    queue_failed = 0
    stream_summaries: list[dict[str, Any]] = []

    for item in claude_items:
        stream_id = str(item.get("stream_id") or item.get("opencode_session_id") or "")
        if not stream_id:
            continue
        pending = int(item.get("pending") or 0)
        pending_events += pending
        legacy_counts = store.raw_event_batch_status_counts(stream_id, source="claude")
        queue_counts = store.raw_event_queue_status_counts(stream_id, source="claude")
        is_running = (
            int(legacy_counts.get("running", 0) or 0) > 0
            or int(queue_counts.get("claimed", 0) or 0) > 0
        )
        is_error = (
            int(legacy_counts.get("error", 0) or 0) > 0
            or int(queue_counts.get("failed", 0) or 0) > 0
        )
        if is_running:
            running_streams += 1
        if is_error:
            errored_streams += 1
        queue_claimed += int(queue_counts.get("claimed", 0) or 0)
        queue_failed += int(queue_counts.get("failed", 0) or 0)
        stream_summaries.append(
            {
                "stream_id": stream_id,
                "pending": pending,
                "batch_running": int(legacy_counts.get("running", 0) or 0),
                "batch_error": int(legacy_counts.get("error", 0) or 0),
                "queue_claimed": int(queue_counts.get("claimed", 0) or 0),
                "queue_failed": int(queue_counts.get("failed", 0) or 0),
                "project": item.get("project") or "",
            }
        )

    top_streams = sorted(stream_summaries, key=lambda entry: int(entry["pending"]), reverse=True)[
        :5
    ]

    health = "green"
    if errored_streams > 0 or queue_failed > 0:
        health = "red"
    elif pending_events > 0 or running_streams > 0:
        health = "yellow"

    payload = {
        "health": health,
        "observer_runtime": observer_runtime,
        "claude_command": claude_command,
        "raw_events_sweeper_interval_s": sweeper_interval_s,
        "claude_streams": len(claude_items),
        "pending_events": pending_events,
        "running_streams": running_streams,
        "errored_streams": errored_streams,
        "queue_claimed": queue_claimed,
        "queue_failed": queue_failed,
        "top_streams": top_streams,
    }
    print(json.dumps(payload, indent=2, sort_keys=True))


def raw_events_retry_cmd(
    store: MemoryStore,
    *,
    opencode_session_id: str,
    source: str,
    limit: int,
) -> None:
    """Retry error raw-event flush batches for a session."""

    from codemem.raw_event_flush import flush_raw_events as flush

    errors = store.raw_event_error_batches(opencode_session_id, source=source, limit=limit)
    if not errors:
        print("No error batches")
        return
    for batch in errors:
        # Re-run extraction by forcing last_flushed back to the batch start-1.
        start_seq = int(batch["start_event_seq"])
        store.update_raw_event_flush_state(opencode_session_id, start_seq - 1, source=source)
        result = flush(
            store,
            opencode_session_id=opencode_session_id,
            source=source,
            cwd=None,
            project=None,
            started_at=None,
            max_events=None,
        )
        print(f"Retried batch {batch['id']} -> flushed {result['flushed']} events")


def raw_events_gate_cmd(
    store: MemoryStore,
    *,
    min_flush_success_rate: float,
    max_dropped_event_rate: float,
    min_session_boundary_accuracy: float,
    max_retry_depth: int,
    min_events: int,
    min_batches: int,
    min_sessions: int,
    window_hours: float,
) -> None:
    """Validate reliability baseline thresholds and fail on violation."""

    metrics = store.raw_event_reliability_metrics(window_hours=window_hours)
    rates = metrics.get("rates", {})
    flush_success_rate = float(rates.get("flush_success_rate", 1.0) or 0.0)
    dropped_event_rate = float(rates.get("dropped_event_rate", 0.0) or 0.0)
    session_boundary_accuracy = float(rates.get("session_boundary_accuracy", 1.0) or 0.0)
    retry_depth_max = int(metrics.get("retry_depth_max", 0) or 0)
    counts = metrics.get("counts", {})
    processed_events = int(
        (counts.get("inserted_events", 0) or 0) + (counts.get("dropped_events", 0) or 0)
    )
    total_batches = int(counts.get("terminal_batches", 0) or 0)
    sessions_with_events = int(counts.get("sessions_with_events", 0) or 0)

    failures: list[str] = []
    if processed_events < min_events:
        failures.append(f"eligible_events={processed_events} < min {min_events}")
    if total_batches < min_batches:
        failures.append(f"terminal_batches={total_batches} < min {min_batches}")
    if sessions_with_events < min_sessions:
        failures.append(f"sessions_with_events={sessions_with_events} < min {min_sessions}")
    if flush_success_rate < min_flush_success_rate:
        failures.append(
            f"flush_success_rate={flush_success_rate:.4f} < min {min_flush_success_rate:.4f}"
        )
    if dropped_event_rate > max_dropped_event_rate:
        failures.append(
            f"dropped_event_rate={dropped_event_rate:.4f} > max {max_dropped_event_rate:.4f}"
        )
    if session_boundary_accuracy < min_session_boundary_accuracy:
        failures.append(
            f"session_boundary_accuracy={session_boundary_accuracy:.4f} < min {min_session_boundary_accuracy:.4f}"
        )
    if retry_depth_max > max_retry_depth:
        failures.append(f"retry_depth_max={retry_depth_max} > max {max_retry_depth}")

    print(
        "reliability gate: "
        f"flush_success_rate={flush_success_rate:.4f}, "
        f"dropped_event_rate={dropped_event_rate:.4f}, "
        f"session_boundary_accuracy={session_boundary_accuracy:.4f}, "
        f"retry_depth_max={retry_depth_max}, "
        f"eligible_events={processed_events}, "
        f"terminal_batches={total_batches}, "
        f"sessions_with_events={sessions_with_events}, "
        f"window_hours={window_hours:.2f}"
    )
    if failures:
        print("[red]reliability gate failed[/red]")
        for failure in failures:
            print(f"- {failure}")
        raise typer.Exit(code=1)
    print("[green]reliability gate passed[/green]")
