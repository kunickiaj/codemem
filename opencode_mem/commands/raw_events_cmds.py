from __future__ import annotations

from rich import print

from opencode_mem.store import MemoryStore


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

    from opencode_mem.raw_event_flush import flush_raw_events as flush

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

    from opencode_mem.raw_event_flush import flush_raw_events as flush

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
