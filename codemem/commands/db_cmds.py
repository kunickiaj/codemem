from __future__ import annotations

import sqlite3
from pathlib import Path

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


def size_report_cmd(*, store_from_path, db_path: str | None, limit: int) -> None:
    """Report SQLite file size and major storage consumers."""

    store = store_from_path(db_path)
    try:
        conn = store.conn
        db_file = Path(store.db_path)

        page_size = int(conn.execute("PRAGMA page_size").fetchone()[0])
        page_count = int(conn.execute("PRAGMA page_count").fetchone()[0])
        freelist_count = int(conn.execute("PRAGMA freelist_count").fetchone()[0])
        used_pages = max(0, page_count - freelist_count)

        print("[bold]Database size report[/bold]")
        print(f"- Path: {db_file}")
        print(f"- File size: {_format_bytes(db_file.stat().st_size if db_file.exists() else 0)}")
        print(f"- Page size: {page_size:,} B")
        print(f"- Pages: total {page_count:,} used {used_pages:,} free {freelist_count:,}")
        print(f"- Approx used bytes: {_format_bytes(used_pages * page_size)}")
        print(f"- Approx free bytes: {_format_bytes(freelist_count * page_size)}")

        objects = _dbstat_objects(conn, limit=limit)
        if objects:
            print("\n[bold]Largest tables / indexes[/bold]")
            for item in objects:
                print(
                    f"- {item['name']} ({item['kind']}): {_format_bytes(int(item['bytes']))}"
                    f" [{item['pages']:,} pages]"
                )

        counts = _selected_table_counts(conn)
        if counts:
            print("\n[bold]Selected row counts[/bold]")
            for name, count in counts:
                print(f"- {name}: {count:,}")
    finally:
        store.close()


def compress_artifacts_cmd(
    *,
    store_from_path,
    db_path: str | None,
    min_bytes: int,
    limit: int | None,
    dry_run: bool,
) -> None:
    """Compress large artifact text payloads."""

    store = store_from_path(db_path)
    try:
        result = store.compress_artifacts(min_bytes=min_bytes, limit=limit, dry_run=dry_run)
    finally:
        store.close()

    action = "Would compress" if dry_run else "Compressed"
    print(
        f"[bold]{action}[/bold] {result['compressed']} of {result['checked']} candidate artifacts"
    )
    print(f"- Raw bytes: {_format_bytes(result['raw_bytes'])}")
    print(f"- Compressed bytes: {_format_bytes(result['compressed_bytes'])}")
    print(f"- Saved bytes: {_format_bytes(result['saved_bytes'])}")


def _format_bytes(num_bytes: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    value = float(num_bytes)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024.0
    return f"{num_bytes} B"


def _dbstat_objects(conn: sqlite3.Connection, *, limit: int) -> list[dict[str, int | str]]:
    try:
        rows = conn.execute(
            """
            SELECT name, SUM(pgsize) AS total_bytes, COUNT(*) AS pages
            FROM dbstat
            WHERE name NOT LIKE 'sqlite_%'
            GROUP BY name
            ORDER BY total_bytes DESC, name ASC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    except sqlite3.OperationalError:
        return []

    table_names = {
        str(row[0])
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    return [
        {
            "name": str(row[0]),
            "bytes": int(row[1] or 0),
            "pages": int(row[2] or 0),
            "kind": "table" if str(row[0]) in table_names else "index",
        }
        for row in rows
    ]


def _selected_table_counts(conn: sqlite3.Connection) -> list[tuple[str, int]]:
    selected = [
        "memory_items",
        "artifacts",
        "raw_events",
        "raw_event_sessions",
        "raw_event_flush_batches",
        "usage_events",
        "sessions",
        "tags",
    ]
    existing = {
        str(row[0])
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    counts: list[tuple[str, int]] = []
    for table in selected:
        if table not in existing:
            continue
        count = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        counts.append((table, count))
    return counts
