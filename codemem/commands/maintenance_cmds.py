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


def pack_stats_cmd(
    *,
    store_from_path,
    resolve_project,
    db_path: str | None,
    project: str | None,
    all_projects: bool,
    limit: int = 50,
) -> None:
    """Analyze pack generation statistics (semantic usage, token savings)."""
    import json
    import statistics
    from collections import defaultdict

    store = store_from_path(db_path)
    try:
        resolved_project = resolve_project(os.getcwd(), project, all_projects=all_projects)

        print(f"[bold]Pack Stats[/bold] (limit {limit} recent packs)")
        if resolved_project:
            print(f"Project: {resolved_project}")

        # Fetch usage events
        query = "SELECT metadata_json, created_at FROM usage_events WHERE event = 'pack' ORDER BY created_at DESC LIMIT ?"
        rows = store.conn.execute(query, (limit,)).fetchall()

        if not rows:
            print("[yellow]No pack events found.[/yellow]")
            return

        stats = {
            "total_packs": 0,
            "semantic_candidates_total": 0,
            "semantic_hits_total": 0,
            "semantic_zero_count": 0,
            "tokens_saved": [],
            "pack_tokens": [],
            "fallback_counts": defaultdict(int),
        }

        for row in rows:
            try:
                meta = json.loads(row["metadata_json"])
            except (ValueError, TypeError):
                continue

            # Filter by project if needed
            pack_project = meta.get("project")
            print(f"DEBUG: pack_project={repr(pack_project)} resolved={repr(resolved_project)}")
            if resolved_project and pack_project != resolved_project:
                continue

            stats["total_packs"] += 1
            cand = meta.get("semantic_candidates", 0)
            hits = meta.get("semantic_hits", 0)

            stats["semantic_candidates_total"] += cand
            stats["semantic_hits_total"] += hits
            if cand == 0:
                stats["semantic_zero_count"] += 1

            stats["tokens_saved"].append(meta.get("tokens_saved", 0))
            stats["pack_tokens"].append(
                meta.get("token_budget", 0) or 0
            )  # Use budget or pack_tokens

            fallback = meta.get("fallback")
            if fallback:
                stats["fallback_counts"][fallback] += 1

        if stats["total_packs"] == 0:
            print(f"[yellow]No packs found for project {resolved_project}[/yellow]")
            return

        avg_candidates = stats["semantic_candidates_total"] / stats["total_packs"]
        avg_hits = stats["semantic_hits_total"] / stats["total_packs"]
        avg_saved = statistics.mean(stats["tokens_saved"]) if stats["tokens_saved"] else 0

        print("\n[bold]Semantic Retrieval[/bold]")
        print(f"- Avg Candidates: {avg_candidates:.1f}")
        print(f"- Avg Hits (included): {avg_hits:.1f}")
        print(
            f"- Zero-candidate packs: {stats['semantic_zero_count']} ({stats['semantic_zero_count'] / stats['total_packs'] * 100:.1f}%)"
        )

        print("\n[bold]Fallbacks[/bold]")
        if stats["fallback_counts"]:
            for k, v in stats["fallback_counts"].items():
                print(f"- {k}: {v}")
        else:
            print("- None")

        print("\n[bold]Tokens[/bold]")
        print(f"- Avg Saved: {avg_saved:,.0f}")

    finally:
        store.close()


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
    from codemem.pack_benchmark import (
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

    from codemem.mcp_server import run as mcp_run

    mcp_run()


def ingest_cmd() -> None:
    """Ingest plugin events from stdin."""

    from codemem.plugin_ingest import main as ingest_main

    ingest_main()
