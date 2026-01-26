from __future__ import annotations

import getpass
import json
import os
import sqlite3
from collections.abc import Callable
from pathlib import Path

import typer
from rich import print

from opencode_mem import db
from opencode_mem.store import MemoryStore


def run_import_from_claude_mem(
    *,
    claude_db_path: Path,
    store: MemoryStore,
    project_filter: str | None,
    update_existing: bool,
    dry_run: bool,
    build_import_key: Callable[..., str],
) -> None:
    if not claude_db_path.exists():
        print(f"[red]Claude-mem database not found: {claude_db_path}[/red]")
        raise typer.Exit(code=1)

    try:
        claude_conn = sqlite3.connect(f"file:{claude_db_path}?mode=ro", uri=True)
        claude_conn.row_factory = sqlite3.Row
    except Exception as exc:
        print(f"[red]Failed to open claude-mem database: {exc}[/red]")
        raise typer.Exit(code=1) from None

    where_clause = ""
    params: list[str] = []
    if project_filter:
        where_clause = "WHERE project = ?"
        params = [project_filter]

    obs_count = claude_conn.execute(
        f"SELECT COUNT(*) as count FROM observations {where_clause}", params
    ).fetchone()["count"]
    summaries_count = claude_conn.execute(
        f"SELECT COUNT(*) as count FROM session_summaries {where_clause}", params
    ).fetchone()["count"]
    sessions_count = claude_conn.execute(
        f"SELECT COUNT(*) as count FROM sdk_sessions {where_clause}", params
    ).fetchone()["count"]

    prompts_count_where = ""
    prompts_query_where = ""
    prompts_params: list[str] = []
    if project_filter:
        prompts_count_where = """
        WHERE content_session_id IN (
            SELECT content_session_id FROM sdk_sessions WHERE project = ?
        )
        """
        prompts_query_where = """
        WHERE p.content_session_id IN (
            SELECT content_session_id FROM sdk_sessions WHERE project = ?
        )
        """
        prompts_params = [project_filter]

    prompts_count = claude_conn.execute(
        f"SELECT COUNT(*) as count FROM user_prompts {prompts_count_where}",
        prompts_params,
    ).fetchone()["count"]

    print("[bold]Claude-mem Import Preview[/bold]")
    print(f"- Source: {claude_db_path}")
    if project_filter:
        print(f"- Project filter: {project_filter}")
    print(f"- Observations: {obs_count}")
    print(f"- Session summaries: {summaries_count}")
    print(f"- Sessions: {sessions_count}")
    print(f"- User prompts: {prompts_count}")

    if dry_run:
        print("\n[yellow]Dry run - no data will be imported[/yellow]")
        claude_conn.close()
        return

    project_sessions: dict[str, int] = {}
    created_session_ids: list[int] = []
    source_db = str(claude_db_path)

    def get_project_session(project: str) -> int:
        existing = project_sessions.get(project)
        if existing:
            return existing
        import_key = build_import_key(
            "claude-mem",
            "session",
            project,
            project=project,
            source_db=source_db,
        )
        existing_id = store.find_imported_id("sessions", import_key)
        if existing_id:
            project_sessions[project] = existing_id
            return existing_id
        new_session_id = store.start_session(
            cwd=os.getcwd(),
            project=project,
            git_remote=None,
            git_branch=None,
            user=getpass.getuser(),
            tool_version="import-claude-mem",
            metadata={
                "source": "claude-mem",
                "source_db": source_db,
                "project_filter": project_filter,
                "import_key": import_key,
            },
        )
        project_sessions[project] = new_session_id
        created_session_ids.append(new_session_id)
        return new_session_id

    imported_obs = 0
    imported_summaries = 0
    imported_prompts = 0
    updated_obs = 0
    updated_summaries = 0

    print("\n[bold]Importing observations...[/bold]")
    obs_query = f"""
        SELECT * FROM observations
        {where_clause}
        ORDER BY created_at_epoch ASC
    """
    for row in claude_conn.execute(obs_query, params):
        project = row["project"]
        session_id = get_project_session(project)
        import_key = build_import_key(
            "claude-mem",
            "observation",
            row["id"],
            project=project,
            created_at=row["created_at"],
            source_db=source_db,
        )
        existing_obs_id = store.find_imported_id("memory_items", import_key)
        if existing_obs_id and not update_existing:
            continue

        discovery_tokens = 0
        discovery_source = "claude-mem"
        row_keys = set(row.keys())
        if "discovery_tokens" in row_keys:
            discovery_tokens = int(row["discovery_tokens"] or 0)
        else:
            discovery_source = "claude-mem-missing"

        obs_meta = {
            "source": "claude-mem",
            "original_session_id": row["memory_session_id"],
            "original_observation_id": row["id"],
            "created_at": row["created_at"],
            "created_at_epoch": row["created_at_epoch"],
            "source_db": source_db,
            "import_key": import_key,
            "discovery_tokens": discovery_tokens,
            "discovery_source": discovery_source,
        }
        if existing_obs_id:
            store.conn.execute(
                "UPDATE memory_items SET metadata_json = ? WHERE id = ?",
                (db.to_json(obs_meta), existing_obs_id),
            )
            store.conn.commit()
            updated_obs += 1
        else:
            store.remember_observation(
                session_id,
                kind=row["type"],
                title=row["title"] or "Untitled",
                narrative=row["narrative"] or row["text"] or "",
                subtitle=row["subtitle"],
                facts=json.loads(row["facts"]) if row["facts"] else None,
                concepts=json.loads(row["concepts"]) if row["concepts"] else None,
                files_read=json.loads(row["files_read"]) if row["files_read"] else None,
                files_modified=(
                    json.loads(row["files_modified"]) if row["files_modified"] else None
                ),
                prompt_number=row["prompt_number"],
                confidence=0.7,
                metadata=obs_meta,
            )
            imported_obs += 1
        if imported_obs % 100 == 0:
            print(f"  Imported {imported_obs}/{obs_count} observations...")

    print(f"[green]✓ Imported {imported_obs} observations[/green]")

    print("\n[bold]Importing session summaries...[/bold]")
    summaries_query = f"""
        SELECT * FROM session_summaries
        {where_clause}
        ORDER BY created_at_epoch ASC
    """
    for row in claude_conn.execute(summaries_query, params):
        project = row["project"]
        session_id = get_project_session(project)
        import_key = build_import_key(
            "claude-mem",
            "summary",
            row["id"],
            project=project,
            created_at=row["created_at"],
            source_db=source_db,
        )
        if store.find_imported_id("session_summaries", import_key) and not update_existing:
            continue

        summary_discovery_tokens = 0
        summary_discovery_source = "claude-mem"
        row_keys = set(row.keys())
        if "discovery_tokens" in row_keys:
            summary_discovery_tokens = int(row["discovery_tokens"] or 0)
        else:
            summary_discovery_source = "claude-mem-missing"

        summary_meta = {
            "source": "claude-mem",
            "original_session_id": row["memory_session_id"],
            "original_summary_id": row["id"],
            "created_at": row["created_at"],
            "created_at_epoch": row["created_at_epoch"],
            "source_db": source_db,
            "import_key": import_key,
            "discovery_tokens": summary_discovery_tokens,
            "discovery_source": summary_discovery_source,
        }
        existing_summary_id = store.find_imported_id("session_summaries", import_key)
        if existing_summary_id:
            store.conn.execute(
                "UPDATE session_summaries SET metadata_json = ? WHERE id = ?",
                (db.to_json(summary_meta), existing_summary_id),
            )
            store.conn.commit()
            updated_summaries += 1
        else:
            store.add_session_summary(
                session_id,
                project=row["project"],
                request=row["request"] or "",
                investigated=row["investigated"] or "",
                learned=row["learned"] or "",
                completed=row["completed"] or "",
                next_steps=row["next_steps"] or "",
                notes=row["notes"] or "",
                files_read=json.loads(row["files_read"]) if row["files_read"] else None,
                files_edited=(json.loads(row["files_edited"]) if row["files_edited"] else None),
                prompt_number=row["prompt_number"],
                metadata=summary_meta,
            )

        summary_text = " ".join(
            filter(
                None,
                [
                    row["request"],
                    row["investigated"],
                    row["learned"],
                    row["completed"],
                    row["next_steps"],
                ],
            )
        )
        if summary_text.strip():
            summary_memory_key = build_import_key(
                "claude-mem",
                "summary-memory",
                row["id"],
                project=project,
                created_at=row["created_at"],
                source_db=source_db,
            )
            existing_summary_memory_id = store.find_imported_id("memory_items", summary_memory_key)
            summary_memory_meta = {
                "source": "claude-mem",
                "original_session_id": row["memory_session_id"],
                "original_summary_id": row["id"],
                "created_at": row["created_at"],
                "source_db": source_db,
                "import_key": summary_memory_key,
                "discovery_tokens": summary_discovery_tokens,
                "discovery_source": summary_discovery_source,
            }
            if existing_summary_memory_id and update_existing:
                store.conn.execute(
                    "UPDATE memory_items SET metadata_json = ? WHERE id = ?",
                    (db.to_json(summary_memory_meta), existing_summary_memory_id),
                )
                store.conn.commit()
            elif not existing_summary_memory_id:
                store.remember(
                    session_id,
                    kind="session_summary",
                    title=row["request"][:80] if row["request"] else "Session summary",
                    body_text=summary_text,
                    confidence=0.7,
                    metadata=summary_memory_meta,
                )
        imported_summaries += 0 if existing_summary_id else 1
        if imported_summaries % 50 == 0:
            print(f"  Imported {imported_summaries}/{summaries_count} summaries...")

    print(f"[green]✓ Imported {imported_summaries} session summaries[/green]")

    print("\n[bold]Importing user prompts...[/bold]")
    prompts_query = f"""
        SELECT p.*, s.project
        FROM user_prompts p
        LEFT JOIN sdk_sessions s ON s.content_session_id = p.content_session_id
        {prompts_query_where}
        ORDER BY p.created_at_epoch ASC
    """
    for row in claude_conn.execute(prompts_query, prompts_params):
        project = row["project"]
        session_id = get_project_session(project) if project else None
        if session_id:
            import_key = build_import_key(
                "claude-mem",
                "prompt",
                row["id"],
                project=project,
                created_at=row["created_at"],
                source_db=source_db,
            )
            if store.find_imported_id("user_prompts", import_key):
                continue
            store.add_user_prompt(
                session_id,
                project=row["project"],
                prompt_text=row["prompt_text"],
                prompt_number=row["prompt_number"],
                metadata={
                    "source": "claude-mem",
                    "original_session_id": row["content_session_id"],
                    "original_prompt_id": row["id"],
                    "created_at": row["created_at"],
                    "created_at_epoch": row["created_at_epoch"],
                    "source_db": source_db,
                    "import_key": import_key,
                },
            )
        imported_prompts += 1
        if imported_prompts % 100 == 0:
            print(f"  Imported {imported_prompts}/{prompts_count} prompts...")

    print(f"[green]✓ Imported {imported_prompts} user prompts[/green]")

    claude_conn.close()
    for session_id in created_session_ids:
        store.end_session(
            session_id,
            metadata={
                "imported_observations": imported_obs,
                "imported_summaries": imported_summaries,
                "imported_prompts": imported_prompts,
            },
        )

    print("\n[bold green]✓ Import complete![/bold green]")
    print(f"- Projects: {len(project_sessions)}")
    print(f"- Observations: {imported_obs}")
    print(f"- Session summaries: {imported_summaries}")
    print(f"- User prompts: {imported_prompts}")
    if update_existing:
        print(f"- Updated observations: {updated_obs}")
        print(f"- Updated summaries: {updated_summaries}")
