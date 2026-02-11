from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
from typing import Any

import typer
from rich import print


def export_memories_cmd(
    *,
    store_from_path,
    resolve_project,
    from_json,
    db_path: str | None,
    output: str,
    project: str | None,
    all_projects: bool,
    include_inactive: bool,
    since: str | None,
) -> None:
    """Export memories to a JSON file for sharing or backup."""

    store = store_from_path(db_path)
    try:
        resolved_project = resolve_project(os.getcwd(), project, all_projects=all_projects)

        filters: dict[str, Any] = {}
        if resolved_project:
            filters["project"] = resolved_project
        if since:
            filters["since"] = since

        sessions_query = "SELECT * FROM sessions"
        params: list[Any] = []
        if resolved_project:
            sessions_query += " WHERE project = ? OR project LIKE ? OR project LIKE ?"
            if "/" in resolved_project or "\\" in resolved_project:
                params.extend([resolved_project, resolved_project, resolved_project])
            else:
                params.extend([resolved_project, f"%/{resolved_project}", f"%\\{resolved_project}"])
        if since:
            if params:
                sessions_query += " AND started_at >= ?"
            else:
                sessions_query += " WHERE started_at >= ?"
            params.append(since)
        sessions_query += " ORDER BY started_at ASC"

        sessions_rows = store.conn.execute(sessions_query, params).fetchall()
        sessions: list[dict[str, Any]] = []
        session_ids: list[int] = []
        for row in sessions_rows:
            session_data = dict(row)
            session_data["metadata_json"] = from_json(session_data.get("metadata_json"))
            sessions.append(session_data)
            session_ids.append(int(row["id"]))

        if not session_ids:
            print("[yellow]No sessions found matching filters[/yellow]")
            raise typer.Exit(code=0)

        active_clause = "" if include_inactive else " AND active = 1"
        mem_placeholders = ",".join("?" for _ in session_ids)
        memories_rows = store.conn.execute(
            f"SELECT * FROM memory_items WHERE session_id IN ({mem_placeholders}){active_clause} ORDER BY created_at ASC",
            session_ids,
        ).fetchall()
        memories: list[dict[str, Any]] = []
        for row in memories_rows:
            mem_data = dict(row)
            mem_data["metadata_json"] = from_json(mem_data.get("metadata_json"))
            mem_data["facts"] = from_json(mem_data.get("facts"))
            mem_data["concepts"] = from_json(mem_data.get("concepts"))
            mem_data["files_read"] = from_json(mem_data.get("files_read"))
            mem_data["files_modified"] = from_json(mem_data.get("files_modified"))
            memories.append(mem_data)

        summaries_rows = store.conn.execute(
            f"SELECT * FROM session_summaries WHERE session_id IN ({mem_placeholders}) ORDER BY created_at_epoch ASC",
            session_ids,
        ).fetchall()
        summaries: list[dict[str, Any]] = []
        for row in summaries_rows:
            summary_data = dict(row)
            summary_data["metadata_json"] = from_json(summary_data.get("metadata_json"))
            summary_data["files_read"] = from_json(summary_data.get("files_read"))
            summary_data["files_edited"] = from_json(summary_data.get("files_edited"))
            summaries.append(summary_data)

        prompts_rows = store.conn.execute(
            f"SELECT * FROM user_prompts WHERE session_id IN ({mem_placeholders}) ORDER BY created_at_epoch ASC",
            session_ids,
        ).fetchall()
        prompts: list[dict[str, Any]] = []
        for row in prompts_rows:
            prompt_data = dict(row)
            prompt_data["metadata_json"] = from_json(prompt_data.get("metadata_json"))
            prompts.append(prompt_data)

        export_data = {
            "version": "1.0",
            "exported_at": dt.datetime.now(dt.UTC).isoformat(),
            "export_metadata": {
                "tool_version": "codemem",
                "projects": list(set(s["project"] for s in sessions if s.get("project"))),
                "total_memories": len(memories),
                "total_sessions": len(sessions),
                "include_inactive": include_inactive,
                "filters": filters,
            },
            "sessions": sessions,
            "memory_items": memories,
            "session_summaries": summaries,
            "user_prompts": prompts,
        }

        output_json = json.dumps(export_data, ensure_ascii=False, indent=2)
        if output == "-":
            print(output_json)
            return
        output_path = Path(output).expanduser()
        output_path.write_text(output_json, encoding="utf-8")
        size_mb = len(output_json) / 1024 / 1024
        print(f"[green]✓ Exported to {output_path}[/green]")
        print(f"  Size: {size_mb:.1f} MB")
        print(f"  Sessions: {len(sessions)}")
        print(f"  Memories: {len(memories)}")
        print(f"  Summaries: {len(summaries)}")
        print(f"  Prompts: {len(prompts)}")
    finally:
        store.close()


def import_memories_cmd(
    *,
    store_from_path,
    build_import_key,
    merge_summary_metadata,
    db_path: str | None,
    input_file: str,
    remap_project: str | None,
    dry_run: bool,
) -> None:
    """Import memories from an exported JSON file."""

    if input_file == "-":
        import sys

        input_json = sys.stdin.read()
    else:
        input_path = Path(input_file).expanduser()
        if not input_path.exists():
            print(f"[red]Input file not found: {input_path}[/red]")
            raise typer.Exit(code=1)
        input_json = input_path.read_text(encoding="utf-8")

    try:
        import_data = json.loads(input_json)
    except json.JSONDecodeError as e:
        print(f"[red]Invalid JSON: {e}[/red]")
        raise typer.Exit(code=1) from None

    if import_data.get("version") != "1.0":
        print(f"[red]Unsupported export version: {import_data.get('version')}[/red]")
        raise typer.Exit(code=1)

    sessions_data = import_data.get("sessions", [])
    memories_data = import_data.get("memory_items", [])
    summaries_data = import_data.get("session_summaries", [])
    prompts_data = import_data.get("user_prompts", [])

    print("[bold]Import Preview[/bold]")
    print(f"- Export version: {import_data.get('version')}")
    print(f"- Exported at: {import_data.get('exported_at')}")
    if import_data.get("export_metadata"):
        meta = import_data["export_metadata"]
        print(f"- Source projects: {', '.join(meta.get('projects', []))}")
    print(f"- Sessions: {len(sessions_data)}")
    print(f"- Memories: {len(memories_data)}")
    print(f"- Summaries: {len(summaries_data)}")
    print(f"- Prompts: {len(prompts_data)}")

    if dry_run:
        print("\n[yellow]Dry run - no data will be imported[/yellow]")
        return

    import getpass

    store = store_from_path(db_path)
    try:
        session_mapping: dict[int, int] = {}
        imported_sessions = 0
        created_session_ids: list[int] = []

        print("\n[bold]Importing sessions...[/bold]")
        for sess_data in sessions_data:
            old_session_id = int(sess_data["id"])
            project = remap_project if remap_project else sess_data.get("project")
            if (
                (not remap_project)
                and isinstance(project, str)
                and ("/" in project or "\\" in project)
            ):
                project = project.replace("\\", "/").rstrip("/").split("/")[-1]

            import_key = build_import_key(
                "export",
                "session",
                old_session_id,
                project=project,
                created_at=sess_data.get("started_at"),
            )
            existing_session_id = store.find_imported_id("sessions", import_key)
            if existing_session_id:
                session_mapping[old_session_id] = int(existing_session_id)
                continue

            new_session_id = store.start_session(
                cwd=sess_data.get("cwd", os.getcwd()),
                project=project,
                git_remote=sess_data.get("git_remote"),
                git_branch=sess_data.get("git_branch"),
                user=sess_data.get("user", getpass.getuser()),
                tool_version=sess_data.get("tool_version", "import"),
                metadata={
                    "source": "export",
                    "original_session_id": old_session_id,
                    "original_started_at": sess_data.get("started_at"),
                    "original_ended_at": sess_data.get("ended_at"),
                    "import_metadata": sess_data.get("metadata_json"),
                    "import_key": import_key,
                },
            )
            session_mapping[old_session_id] = int(new_session_id)
            imported_sessions += 1
            created_session_ids.append(int(new_session_id))
            if imported_sessions % 10 == 0:
                print(f"  Imported {imported_sessions}/{len(sessions_data)} sessions...")

        print(f"[green]✓ Imported {imported_sessions} sessions[/green]")

        print("\n[bold]Importing memory items...[/bold]")
        imported_memories = 0
        for mem_data in memories_data:
            old_session_id = mem_data.get("session_id")
            if old_session_id is None:
                continue
            new_session_id = session_mapping.get(int(old_session_id))
            if not new_session_id:
                continue
            import_key = build_import_key(
                "export",
                "memory",
                mem_data.get("id"),
                project=remap_project or mem_data.get("project"),
                created_at=mem_data.get("created_at"),
            )
            if store.find_imported_id("memory_items", import_key):
                continue

            import_metadata = mem_data.get("metadata_json")
            base_metadata = {
                "source": "export",
                "original_memory_id": mem_data.get("id"),
                "original_created_at": mem_data.get("created_at"),
                "import_metadata": import_metadata,
                "import_key": import_key,
            }
            metadata = base_metadata
            if mem_data.get("kind") == "session_summary":
                metadata = merge_summary_metadata(base_metadata, import_metadata)

            if mem_data.get("narrative") or mem_data.get("facts") or mem_data.get("concepts"):
                store.remember_observation(
                    new_session_id,
                    kind=mem_data.get("kind", "observation"),
                    title=mem_data.get("title", "Untitled"),
                    narrative=mem_data.get("narrative") or mem_data.get("body_text") or "",
                    subtitle=mem_data.get("subtitle"),
                    facts=mem_data.get("facts"),
                    concepts=mem_data.get("concepts"),
                    files_read=mem_data.get("files_read"),
                    files_modified=mem_data.get("files_modified"),
                    prompt_number=mem_data.get("prompt_number"),
                    confidence=mem_data.get("confidence", 0.5),
                    metadata=metadata,
                )
            else:
                store.remember(
                    new_session_id,
                    kind=mem_data.get("kind", "observation"),
                    title=mem_data.get("title", "Untitled"),
                    body_text=mem_data.get("body_text", ""),
                    confidence=mem_data.get("confidence", 0.5),
                    tags=mem_data.get("tags_text", "").split()
                    if mem_data.get("tags_text")
                    else None,
                    metadata=metadata,
                )
            imported_memories += 1
            if imported_memories % 100 == 0:
                print(f"  Imported {imported_memories}/{len(memories_data)} memories...")

        print(f"[green]✓ Imported {imported_memories} memory items[/green]")

        print("\n[bold]Importing session summaries...[/bold]")
        imported_summaries = 0
        for summ_data in summaries_data:
            old_session_id = summ_data.get("session_id")
            if old_session_id is None:
                continue
            new_session_id = session_mapping.get(int(old_session_id))
            if not new_session_id:
                continue

            project = remap_project if remap_project else summ_data.get("project")
            if (
                (not remap_project)
                and isinstance(project, str)
                and ("/" in project or "\\" in project)
            ):
                project = project.replace("\\", "/").rstrip("/").split("/")[-1]
            import_key = build_import_key(
                "export",
                "summary",
                summ_data.get("id"),
                project=project,
                created_at=summ_data.get("created_at"),
            )
            if store.find_imported_id("session_summaries", import_key):
                continue
            store.add_session_summary(
                new_session_id,
                project=project,
                request=summ_data.get("request", ""),
                investigated=summ_data.get("investigated", ""),
                learned=summ_data.get("learned", ""),
                completed=summ_data.get("completed", ""),
                next_steps=summ_data.get("next_steps", ""),
                notes=summ_data.get("notes", ""),
                files_read=summ_data.get("files_read"),
                files_edited=summ_data.get("files_edited"),
                prompt_number=summ_data.get("prompt_number"),
                metadata={
                    "source": "export",
                    "original_summary_id": summ_data.get("id"),
                    "original_created_at": summ_data.get("created_at"),
                    "import_metadata": summ_data.get("metadata_json"),
                    "import_key": import_key,
                },
            )
            imported_summaries += 1
            if imported_summaries % 50 == 0:
                print(f"  Imported {imported_summaries}/{len(summaries_data)} summaries...")

        print(f"[green]✓ Imported {imported_summaries} session summaries[/green]")

        print("\n[bold]Importing user prompts...[/bold]")
        imported_prompts = 0
        for prompt_data in prompts_data:
            old_session_id = prompt_data.get("session_id")
            if old_session_id is None:
                continue
            new_session_id = session_mapping.get(int(old_session_id))
            if not new_session_id:
                continue

            project = remap_project if remap_project else prompt_data.get("project")
            import_key = build_import_key(
                "export",
                "prompt",
                prompt_data.get("id"),
                project=project,
                created_at=prompt_data.get("created_at"),
            )
            if store.find_imported_id("user_prompts", import_key):
                continue
            store.add_user_prompt(
                new_session_id,
                project=project,
                prompt_text=prompt_data.get("prompt_text", ""),
                prompt_number=prompt_data.get("prompt_number"),
                metadata={
                    "source": "export",
                    "original_prompt_id": prompt_data.get("id"),
                    "original_created_at": prompt_data.get("created_at"),
                    "import_metadata": prompt_data.get("metadata_json"),
                    "import_key": import_key,
                },
            )
            imported_prompts += 1
            if imported_prompts % 100 == 0:
                print(f"  Imported {imported_prompts}/{len(prompts_data)} prompts...")

        print(f"[green]✓ Imported {imported_prompts} user prompts[/green]")
    finally:
        store.close()
