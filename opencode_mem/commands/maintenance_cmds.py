from __future__ import annotations

import os
from pathlib import Path

from rich import print


def init_db_cmd(*, store_from_path, db_path: str | None) -> None:
    """Create the SQLite database (no-op if it already exists)."""

    store = store_from_path(db_path)
    print(f"Initialized database at {store.db_path}")


def _format_bytes(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    if size < 1024 * 1024 * 1024:
        return f"{size / 1024 / 1024:.1f} MB"
    return f"{size / 1024 / 1024 / 1024:.1f} GB"


def _format_tokens(count: int) -> str:
    return f"{count:,}"


def stats_cmd(*, store_from_path, db_path: str | None) -> None:
    store = store_from_path(db_path)
    try:
        stats_data = store.stats()
    finally:
        store.close()

    db_stats = stats_data["database"]
    usage = stats_data["usage"]

    print("[bold]Database[/bold]")
    print(f"- Path: {db_stats['path']}")
    print(f"- Size: {_format_bytes(int(db_stats['size_bytes']))}")
    print(f"- Sessions: {db_stats['sessions']}")
    print(f"- Memory items: {db_stats['memory_items']} (active {db_stats['active_memory_items']})")
    print(
        f"- Tags: {db_stats['tags_filled']} filled "
        f"(~{db_stats['tags_coverage'] * 100:.0f}% of active)"
    )
    print(f"- Artifacts: {db_stats['artifacts']}")
    print(f"- Raw events: {db_stats['raw_events']}")

    print("\n[bold]Usage[/bold]")
    if not usage["events"]:
        print("- No usage events recorded yet")
        return
    for event in usage["events"]:
        print(
            f"- {event['event']}: {event['count']} "
            f"(read ~{_format_tokens(event['tokens_read'])} tokens, "
            f"est. saved ~{_format_tokens(event['tokens_saved'])} tokens)"
        )
    totals = usage["totals"]
    print(
        f"\n- Total events: {totals['events']} "
        f"(read ~{_format_tokens(totals['tokens_read'])} tokens, "
        f"est. saved ~{_format_tokens(totals['tokens_saved'])} tokens)"
    )


def embed_cmd(
    *,
    store_from_path,
    resolve_project,
    db_path: str | None,
    limit: int | None,
    since: str | None,
    project: str | None,
    all_projects: bool,
    inactive: bool,
    dry_run: bool,
) -> None:
    store = store_from_path(db_path)
    try:
        resolved_project = resolve_project(os.getcwd(), project, all_projects=all_projects)
        result = store.backfill_vectors(
            limit=limit,
            since=since,
            project=resolved_project,
            active_only=not inactive,
            dry_run=dry_run,
        )
    finally:
        store.close()

    action = "Would embed" if dry_run else "Embedded"
    print(
        f"{action} {result['embedded']} vectors "
        f"({result['inserted']} inserted, {result['skipped']} skipped)"
    )
    print(f"Checked {result['checked']} memories")


def backfill_tags_cmd(
    *,
    store_from_path,
    resolve_project,
    db_path: str | None,
    limit: int | None,
    since: str | None,
    project: str | None,
    all_projects: bool,
    inactive: bool,
    dry_run: bool,
) -> None:
    store = store_from_path(db_path)
    try:
        resolved_project = resolve_project(os.getcwd(), project, all_projects=all_projects)
        result = store.backfill_tags_text(
            limit=limit,
            since=since,
            project=resolved_project,
            active_only=not inactive,
            dry_run=dry_run,
        )
    finally:
        store.close()
    action = "Would update" if dry_run else "Updated"
    print(f"{action} {result['updated']} memories (skipped {result['skipped']})")
    print(f"Checked {result['checked']} memories")


def backfill_discovery_tokens_cmd(
    *, store_from_path, db_path: str | None, limit_sessions: int
) -> None:
    store = store_from_path(db_path)
    try:
        updated = store.backfill_discovery_tokens(limit_sessions=limit_sessions)
    finally:
        store.close()
    print(f"Updated {updated} memories")


def pack_benchmark_cmd(
    *,
    store_from_path,
    resolve_project,
    load_config,
    db_path: str | None,
    queries_path: Path,
    limit: int | None,
    token_budget: int | None,
    project: str | None,
    all_projects: bool,
    json_out: Path | None,
) -> None:
    from opencode_mem.pack_benchmark import (
        format_benchmark_report,
        read_queries,
        run_pack_benchmark,
        to_json,
    )

    store = store_from_path(db_path)
    try:
        resolved_project = resolve_project(os.getcwd(), project, all_projects=all_projects)
        config = load_config()
        filters = {"project": resolved_project} if resolved_project else None
        queries = read_queries(queries_path.read_text())
        result = run_pack_benchmark(
            store,
            queries=queries,
            limit=limit or config.pack_observation_limit,
            token_budget=token_budget,
            filters=filters,
        )
    finally:
        store.close()
    print(format_benchmark_report(result))
    if json_out:
        json_out.write_text(to_json(result) + "\n")


def mcp_cmd() -> None:
    """Run the MCP server for OpenCode."""

    from opencode_mem.mcp_server import run as mcp_run

    mcp_run()


def ingest_cmd() -> None:
    """Ingest plugin events from stdin."""

    from opencode_mem.plugin_ingest import main as ingest_main

    ingest_main()
