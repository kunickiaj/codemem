from __future__ import annotations

from rich import print


def prune_observations_cmd(
    *, store_from_path, db_path: str | None, limit: int | None, dry_run: bool
) -> None:
    """Deactivate low-signal observations (does not delete rows)."""

    store = store_from_path(db_path)
    try:
        result = store.deactivate_low_signal_observations(limit=limit, dry_run=dry_run)
    finally:
        store.close()
    action = "Would deactivate" if dry_run else "Deactivated"
    print(f"{action} {result['deactivated']} of {result['checked']} observations")


def prune_memories_cmd(
    *,
    store_from_path,
    db_path: str | None,
    limit: int | None,
    dry_run: bool,
    kinds: list[str] | None,
) -> None:
    """Deactivate low-signal memories across multiple kinds (does not delete rows)."""

    store = store_from_path(db_path)
    try:
        result = store.deactivate_low_signal_memories(kinds=kinds, limit=limit, dry_run=dry_run)
    finally:
        store.close()
    action = "Would deactivate" if dry_run else "Deactivated"
    print(f"{action} {result['deactivated']} of {result['checked']} memories")


def normalize_projects_cmd(*, store_from_path, db_path: str | None, apply: bool) -> None:
    """Normalize project identifiers in the DB."""

    store = store_from_path(db_path)
    try:
        preview = store.normalize_projects(dry_run=not apply)
    finally:
        store.close()
    mapping = preview.get("rewritten_paths") or {}
    print("[bold]Project normalization[/bold]")
    print(f"- Dry run: {preview.get('dry_run')}")
    print(f"- Sessions to update: {preview.get('sessions_to_update')}")
    print(f"- Raw event sessions to update: {preview.get('raw_event_sessions_to_update')}")
    print(f"- Usage events to update: {preview.get('usage_events_to_update')}")
    if mapping:
        print("- Rewritten paths:")
        for source in sorted(mapping):
            print(f"  - {source} -> {mapping[source]}")


def rename_project_cmd(
    *, store_from_path, db_path: str | None, old_name: str, new_name: str, apply: bool
) -> None:
    """Rename a project across sessions, raw_event_sessions, and usage_events."""

    store = store_from_path(db_path)
    try:
        result = store.rename_project(old_name, new_name, dry_run=not apply)
    finally:
        store.close()

    error = result.get("error")
    if error:
        print(f"[red]Error:[/red] {error}")
        raise SystemExit(2)

    action = "Will rename" if result.get("dry_run") else "Renamed"
    print(
        f"[bold]{action}[/bold] [cyan]{result.get('old_name')}[/cyan] → [green]{result.get('new_name')}[/green]"
    )
    print(f"- Sessions: {result.get('sessions_to_update')}")
    print(f"- Raw event sessions: {result.get('raw_event_sessions_to_update')}")
    print(f"- Usage events: {result.get('usage_events_to_update')}")
    if result.get("dry_run"):
        print("\n[dim]Pass --apply to execute.[/dim]")
