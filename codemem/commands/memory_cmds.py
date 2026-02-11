from __future__ import annotations

import datetime as dt
import getpass
import json
import os

import typer
from rich import print

from ..memory_kinds import validate_memory_kind


def search_cmd(
    *,
    store_from_path,
    resolve_project,
    db_path: str | None,
    query: str,
    limit: int,
    project: str | None,
    all_projects: bool,
) -> None:
    """Search memories by keyword or semantic recall."""

    store = store_from_path(db_path)
    try:
        resolved_project = resolve_project(os.getcwd(), project, all_projects=all_projects)
        filters = {"project": resolved_project} if resolved_project else None
        results = store.search(query, limit=limit, filters=filters)
        for item in results:
            print(
                f"[{item.id}] ({item.kind}) {item.title}\n{item.body_text}\nscore={item.score:.2f}\n"
            )
    finally:
        store.close()


def recent_cmd(
    *,
    store_from_path,
    resolve_project,
    db_path: str | None,
    limit: int,
    kind: str | None,
    project: str | None,
    all_projects: bool,
) -> None:
    """Show recent memories."""

    store = store_from_path(db_path)
    try:
        resolved_project = resolve_project(os.getcwd(), project, all_projects=all_projects)
        filters: dict[str, object] = {"kind": kind} if kind else {}
        if resolved_project:
            filters["project"] = resolved_project
        results = store.recent(limit=limit, filters=filters or None)
        for item in results:
            print(f"[{item['id']}] ({item['kind']}) {item['title']}\n{item['body_text']}\n")
    finally:
        store.close()


def show_cmd(*, store_from_path, db_path: str | None, memory_id: int) -> None:
    """Print a memory item as JSON."""

    store = store_from_path(db_path)
    try:
        item = store.get(memory_id)
        if not item:
            print(f"[red]Memory {memory_id} not found[/red]")
            raise typer.Exit(code=1)
        print(json.dumps(item, indent=2))
    finally:
        store.close()


def remember_cmd(
    *,
    store_from_path,
    resolve_project,
    db_path: str | None,
    kind: str,
    title: str,
    body: str,
    tags: list[str] | None,
    project: str | None,
) -> None:
    """Manually add a memory item."""

    store = store_from_path(db_path)
    try:
        kind = validate_memory_kind(kind)
        resolved_project = resolve_project(os.getcwd(), project, all_projects=False)
        session_id = store.start_session(
            cwd=os.getcwd(),
            project=resolved_project,
            git_remote=None,
            git_branch=None,
            user=getpass.getuser(),
            tool_version="manual",
            metadata={"manual": True},
        )
        mem_id = store.remember(session_id, kind=kind, title=title, body_text=body, tags=tags)
        store.end_session(session_id, metadata={"manual": True})
        print(f"Stored memory {mem_id}")
    finally:
        store.close()


def forget_cmd(*, store_from_path, db_path: str | None, memory_id: int) -> None:
    """Deactivate a memory item by id."""

    store = store_from_path(db_path)
    try:
        store.forget(memory_id)
    finally:
        store.close()
    print(f"Memory {memory_id} marked inactive")


def pack_cmd(
    *,
    store_from_path,
    resolve_project,
    load_config,
    db_path: str | None,
    context: str,
    limit: int | None,
    token_budget: int | None,
    project: str | None,
    all_projects: bool,
) -> None:
    """Build a JSON memory pack for a query/context string."""

    store = store_from_path(db_path)
    try:
        resolved_project = resolve_project(os.getcwd(), project, all_projects=all_projects)
        config = load_config()
        filters = {"project": resolved_project} if resolved_project else None
        pack = store.build_memory_pack(
            context=context,
            limit=limit or config.pack_observation_limit,
            token_budget=token_budget,
            filters=filters,
        )
        print(json.dumps(pack, indent=2))
    finally:
        store.close()


def inject_cmd(
    *,
    store_from_path,
    resolve_project,
    load_config,
    db_path: str | None,
    context: str,
    limit: int | None,
    token_budget: int | None,
    project: str | None,
    all_projects: bool,
) -> None:
    """Build a context block from memories for manual injection into prompts."""

    store = store_from_path(db_path)
    try:
        resolved_project = resolve_project(os.getcwd(), project, all_projects=all_projects)
        config = load_config()
        filters = {"project": resolved_project} if resolved_project else None
        pack = store.build_memory_pack(
            context=context,
            limit=limit or config.pack_observation_limit,
            token_budget=token_budget,
            filters=filters,
        )
        print(pack.get("pack_text", ""))
    finally:
        store.close()


def compact_cmd(
    *,
    store_from_path,
    summarizer_factory,
    db_path: str | None,
    session_id: int | None,
    limit: int,
) -> None:
    """Re-run summarization for past sessions (uses model if configured)."""

    store = store_from_path(db_path)
    try:
        summarizer = summarizer_factory()
        sessions = store.all_sessions()
        sessions = (
            [s for s in sessions if s["id"] == session_id] if session_id else sessions[:limit]
        )
        if not sessions:
            print("[yellow]No sessions found to compact[/yellow]")
            return
        for sess in sessions:
            transcript = store.latest_transcript(sess["id"])
            if not transcript:
                print(f"[yellow]Skipping session {sess['id']}: no transcript artifact[/yellow]")
                continue
            summary = summarizer.summarize(transcript=transcript, diff_summary="", recent_files="")
            store.replace_session_summary(sess["id"], summary)
            transcript_tokens = store.estimate_tokens(transcript)
            summary_tokens = store.estimate_tokens(summary.session_summary)
            summary_tokens += sum(store.estimate_tokens(obs) for obs in summary.observations)
            summary_tokens += sum(store.estimate_tokens(entity) for entity in summary.entities)
            tokens_saved = max(0, transcript_tokens - summary_tokens)
            store.record_usage(
                "compact",
                session_id=sess["id"],
                tokens_read=transcript_tokens,
                tokens_written=summary_tokens,
                tokens_saved=tokens_saved,
                metadata={"mode": "manual"},
            )
            print(f"[green]Compacted session {sess['id']}[/green]")
    finally:
        store.close()


def normalize_imported_metadata_cmd(
    *,
    store_from_path,
    from_json,
    to_json,
    merge_summary_metadata,
    db_path: str | None,
    dry_run: bool,
) -> None:
    """Normalize imported session summary metadata for viewer rendering."""

    store = store_from_path(db_path)
    try:
        rows = store.conn.execute(
            "SELECT id, metadata_json FROM memory_items WHERE kind = 'session_summary'"
        ).fetchall()
        updated = 0
        now = dt.datetime.now(dt.UTC).isoformat()
        for row in rows:
            metadata = from_json(row["metadata_json"])
            if not isinstance(metadata, dict):
                metadata = {}
            import_metadata = metadata.get("import_metadata")
            merged = merge_summary_metadata(metadata, import_metadata)
            if merged == metadata:
                continue
            updated += 1
            if dry_run:
                continue
            store.conn.execute(
                "UPDATE memory_items SET metadata_json = ?, updated_at = ? WHERE id = ?",
                (to_json(merged), now, row["id"]),
            )
        if not dry_run:
            store.conn.commit()
    finally:
        store.close()
    print(f"[green]✓ Updated {updated} session summaries[/green]")
    if dry_run:
        print("[yellow]Dry run - no data was updated[/yellow]")
