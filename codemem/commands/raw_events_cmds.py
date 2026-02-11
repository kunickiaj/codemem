from __future__ import annotations

import typer
from rich import print

from codemem.store import MemoryStore


def flush_raw_events_cmd(
    store: MemoryStore,
    *,
    opencode_session_id: str,
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
        counts = store.raw_event_batch_status_counts(item["opencode_session_id"])
        print(
            f"- {item['opencode_session_id']} pending={item['pending']} "
            f"max_seq={item['max_seq']} last_flushed={item['last_flushed_event_seq']} "
            f"batches=started:{counts['started']} running:{counts['running']} error:{counts['error']} completed:{counts['completed']} "
            f"project={item.get('project') or ''}"
        )


def raw_events_retry_cmd(
    store: MemoryStore,
    *,
    opencode_session_id: str,
    limit: int,
) -> None:
    """Retry error raw-event flush batches for a session."""

    from codemem.raw_event_flush import flush_raw_events as flush

    errors = store.raw_event_error_batches(opencode_session_id, limit=limit)
    if not errors:
        print("No error batches")
        return
    for batch in errors:
        # Re-run extraction by forcing last_flushed back to the batch start-1.
        start_seq = int(batch["start_event_seq"])
        store.update_raw_event_flush_state(opencode_session_id, start_seq - 1)
        result = flush(
            store,
            opencode_session_id=opencode_session_id,
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
