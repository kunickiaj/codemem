from __future__ import annotations

import datetime as dt
import getpass
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import typer
from rich import print

from . import db
from .config import load_config
from .db import DEFAULT_DB_PATH
from .store import MemoryStore
from .summarizer import Summarizer
from .utils import resolve_project
from .viewer import DEFAULT_VIEWER_HOST, DEFAULT_VIEWER_PORT, start_viewer

app = typer.Typer(help="opencode-mem: persistent memory for OpenCode CLI")


def _store(db_path: str | None) -> MemoryStore:
    return MemoryStore(db_path or DEFAULT_DB_PATH)


def _format_bytes(size: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{int(size)} B"


def _format_tokens(count: int) -> str:
    return f"{count:,}"


def _resolve_project(cwd: str, project: str | None, all_projects: bool = False) -> str | None:
    if all_projects:
        return None
    if project:
        return project
    env_project = os.environ.get("OPENCODE_MEM_PROJECT")
    if env_project:
        return env_project
    return resolve_project(cwd)


def _compact_lines(text: str, limit: int) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return ""
    if len(lines) > limit:
        lines = lines[:limit] + [f"... (+{len(lines) - limit} more)"]
    return "; ".join(lines)


def _compact_list(text: str, limit: int) -> str:
    items = [line.strip() for line in text.splitlines() if line.strip()]
    if not items:
        return ""
    if len(items) > limit:
        items = items[:limit] + [f"... (+{len(items) - limit} more)"]
    return ", ".join(items)


def _build_import_key(
    source: str,
    record_type: str,
    original_id: str | int | None,
    *,
    project: str | None = None,
    created_at: str | None = None,
    source_db: str | None = None,
) -> str:
    parts = [source, record_type, str(original_id or "unknown")]
    if project:
        parts.append(project)
    if created_at:
        parts.append(created_at)
    if source_db:
        parts.append(source_db)
    return "|".join(parts)


def _viewer_pid_path() -> Path:
    pid_path = os.environ.get("OPENCODE_MEM_VIEWER_PID", "~/.opencode-mem-viewer.pid")
    return Path(os.path.expanduser(pid_path))


def _read_pid(pid_path: Path) -> int | None:
    try:
        raw = pid_path.read_text().strip()
    except FileNotFoundError:
        return None
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _pid_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _write_pid(pid_path: Path, pid: int) -> None:
    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text(f"{pid}\n")


def _clear_pid(pid_path: Path) -> None:
    try:
        pid_path.unlink()
    except FileNotFoundError:
        return


def _port_open(host: str, port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        try:
            return sock.connect_ex((host, port)) == 0
        except OSError:
            return False


def _pid_for_port(port: int) -> int | None:
    try:
        result = subprocess.run(
            ["lsof", "-ti", f"tcp:{port}"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return None
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            return int(line)
        except ValueError:
            continue
    return None


def _strip_json_comments(text: str) -> str:
    lines: list[str] = []
    for line in text.splitlines():
        result: list[str] = []
        in_string = False
        escape_next = False
        i = 0
        while i < len(line):
            char = line[i]
            if escape_next:
                result.append(char)
                escape_next = False
                i += 1
                continue
            if char == "\\" and in_string:
                result.append(char)
                escape_next = True
                i += 1
                continue
            if char == '"':
                in_string = not in_string
                result.append(char)
                i += 1
                continue
            if not in_string and char == "/" and i + 1 < len(line) and line[i + 1] == "/":
                break
            result.append(char)
            i += 1
        lines.append("".join(result))
    return "\n".join(lines)


def _load_opencode_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    raw = path.read_text()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return json.loads(_strip_json_comments(raw))


def _write_opencode_config(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


@app.command()
def init_db(db_path: str = typer.Option(None, help="Path to SQLite database")) -> None:
    store = _store(db_path)
    print(f"Initialized database at {store.db_path}")


@app.command()
def search(
    query: str,
    limit: int = typer.Option(5),
    db_path: str = typer.Option(None),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
) -> None:
    store = _store(db_path)
    resolved_project = _resolve_project(os.getcwd(), project, all_projects=all_projects)
    filters = {"project": resolved_project} if resolved_project else None
    results = store.search(query, limit=limit, filters=filters)
    for item in results:
        print(f"[{item.id}] ({item.kind}) {item.title}\n{item.body_text}\nscore={item.score:.2f}\n")


@app.command()
def recent(
    limit: int = typer.Option(5),
    kind: str | None = typer.Option(None),
    db_path: str = typer.Option(None),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
) -> None:
    store = _store(db_path)
    resolved_project = _resolve_project(os.getcwd(), project, all_projects=all_projects)
    filters = {"kind": kind} if kind else {}
    if resolved_project:
        filters["project"] = resolved_project
    results = store.recent(limit=limit, filters=filters or None)
    for item in results:
        print(f"[{item['id']}] ({item['kind']}) {item['title']}\n{item['body_text']}\n")


@app.command()
def show(memory_id: int, db_path: str = typer.Option(None)) -> None:
    store = _store(db_path)
    item = store.get(memory_id)
    if not item:
        print(f"[red]Memory {memory_id} not found[/red]")
        raise typer.Exit(code=1)
    print(json.dumps(item, indent=2))


@app.command()
def remember(
    kind: str,
    title: str,
    body: str,
    tags: list[str] = typer.Option(None),
    db_path: str = typer.Option(None),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
) -> None:
    store = _store(db_path)
    resolved_project = _resolve_project(os.getcwd(), project, all_projects=False)
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


@app.command()
def forget(memory_id: int, db_path: str = typer.Option(None)) -> None:
    store = _store(db_path)
    store.forget(memory_id)
    print(f"Memory {memory_id} marked inactive")


@app.command()
def prune_observations(
    limit: int | None = typer.Option(None, help="Max observations to scan (defaults to all)"),
    dry_run: bool = typer.Option(False, help="Report without deactivating"),
    db_path: str = typer.Option(None),
) -> None:
    store = _store(db_path)
    result = store.deactivate_low_signal_observations(limit=limit, dry_run=dry_run)
    action = "Would deactivate" if dry_run else "Deactivated"
    print(f"{action} {result['deactivated']} of {result['checked']} observations")


@app.command()
def purge(
    limit: int | None = typer.Option(None, help="Max memories to scan (defaults to all)"),
    dry_run: bool = typer.Option(False, help="Report without deactivating"),
    kinds: list[str] | None = typer.Option(
        None, help="Memory kinds to purge (defaults to common low-signal kinds)"
    ),
    db_path: str = typer.Option(None),
) -> None:
    """Deactivate low-signal memories across multiple kinds."""
    store = _store(db_path)
    result = store.deactivate_low_signal_memories(kinds=kinds, limit=limit, dry_run=dry_run)
    action = "Would deactivate" if dry_run else "Deactivated"
    print(f"{action} {result['deactivated']} of {result['checked']} memories")


@app.command()
def pack(
    context: str,
    limit: int = typer.Option(None),
    token_budget: int = typer.Option(None, help="Approx token budget for pack"),
    db_path: str = typer.Option(None),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
) -> None:
    store = _store(db_path)
    resolved_project = _resolve_project(os.getcwd(), project, all_projects=all_projects)
    config = load_config()
    filters = {"project": resolved_project} if resolved_project else None
    pack = store.build_memory_pack(
        context=context,
        limit=limit or config.pack_observation_limit,
        token_budget=token_budget,
        filters=filters,
    )
    print(json.dumps(pack, indent=2))


@app.command()
def inject(
    context: str,
    limit: int = typer.Option(None),
    token_budget: int = typer.Option(None, help="Approx token budget for injection"),
    db_path: str = typer.Option(None),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
) -> None:
    """Build a context block from memories for manual injection into prompts."""
    store = _store(db_path)
    resolved_project = _resolve_project(os.getcwd(), project, all_projects=all_projects)
    config = load_config()
    filters = {"project": resolved_project} if resolved_project else None
    pack = store.build_memory_pack(
        context=context,
        limit=limit or config.pack_observation_limit,
        token_budget=token_budget,
        filters=filters,
    )
    print(pack.get("pack_text", ""))


@app.command()
def compact(
    session_id: int | None = typer.Option(None, help="Specific session id to compact"),
    limit: int = typer.Option(3, help="Number of recent sessions to compact when no id is given"),
    db_path: str = typer.Option(None),
) -> None:
    """Re-run summarization for past sessions (uses model if configured)."""
    store = _store(db_path)
    summarizer = Summarizer()
    sessions = store.all_sessions()
    sessions = [s for s in sessions if s["id"] == session_id] if session_id else sessions[:limit]
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


@app.command()
def stats(db_path: str = typer.Option(None, help="Path to SQLite database")) -> None:
    store = _store(db_path)
    stats_data = store.stats()
    db_stats = stats_data["database"]
    usage = stats_data["usage"]

    print("[bold]Database[/bold]")
    print(f"- Path: {db_stats['path']}")
    print(f"- Size: {_format_bytes(db_stats['size_bytes'])}")
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


@app.command()
def embed(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    limit: int | None = typer.Option(None, help="Max memories to embed"),
    since: str | None = typer.Option(None, help="Only embed memories since this date"),
    project: str | None = typer.Option(None, help="Project identifier (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Embed across all projects"),
    inactive: bool = typer.Option(False, help="Include inactive memories"),
    dry_run: bool = typer.Option(False, help="Report without writing"),
) -> None:
    store = _store(db_path)
    resolved_project = _resolve_project(os.getcwd(), project, all_projects=all_projects)
    result = store.backfill_vectors(
        limit=limit,
        since=since,
        project=resolved_project,
        active_only=not inactive,
        dry_run=dry_run,
    )
    action = "Would embed" if dry_run else "Embedded"
    print(
        f"{action} {result['embedded']} vectors "
        f"({result['inserted']} inserted, {result['skipped']} skipped)"
    )
    print(f"Checked {result['checked']} memories")


@app.command("backfill-tags")
def backfill_tags(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    limit: int | None = typer.Option(None, help="Max memories to update"),
    since: str | None = typer.Option(None, help="Only update memories since this date"),
    project: str | None = typer.Option(None, help="Project identifier (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Update across all projects"),
    inactive: bool = typer.Option(False, help="Include inactive memories"),
    dry_run: bool = typer.Option(False, help="Report without writing"),
) -> None:
    """Populate tags_text for memories missing tags."""

    store = _store(db_path)
    resolved_project = _resolve_project(os.getcwd(), project, all_projects=all_projects)
    result = store.backfill_tags_text(
        limit=limit,
        since=since,
        project=resolved_project,
        active_only=not inactive,
        dry_run=dry_run,
    )
    action = "Would update" if dry_run else "Updated"
    print(f"{action} {result['updated']} memories (skipped {result['skipped']})")
    print(f"Checked {result['checked']} memories")


@app.command("flush-raw-events")
def flush_raw_events(
    opencode_session_id: str = typer.Argument(..., help="OpenCode session id"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    cwd: str | None = typer.Option(None, help="Working directory for capture context"),
    project: str | None = typer.Option(None, help="Project identifier"),
    started_at: str | None = typer.Option(None, help="ISO timestamp for session start"),
    max_events: int | None = typer.Option(None, help="Max events to flush"),
) -> None:
    """Flush spooled raw events into the normal ingest pipeline."""

    from .raw_event_flush import flush_raw_events as flush

    store = _store(db_path)
    result = flush(
        store,
        opencode_session_id=opencode_session_id,
        cwd=cwd,
        project=project,
        started_at=started_at,
        max_events=max_events,
    )
    print(f"Flushed {result['flushed']} events")


@app.command("raw-events-status")
def raw_events_status(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    limit: int = typer.Option(25, help="Max sessions to show"),
) -> None:
    """Show pending raw-event backlog by OpenCode session."""

    store = _store(db_path)
    items = store.raw_event_backlog(limit=limit)
    if not items:
        print("No pending raw events")
        return
    for item in items:
        counts = store.raw_event_batch_status_counts(item["opencode_session_id"])
        print(
            f"- {item['opencode_session_id']} pending={item['pending']} "
            f"max_seq={item['max_seq']} last_flushed={item['last_flushed_event_seq']} "
            f"batches=started:{counts['started']} error:{counts['error']} completed:{counts['completed']} "
            f"project={item.get('project') or ''}"
        )


@app.command("raw-events-retry")
def raw_events_retry(
    opencode_session_id: str = typer.Argument(..., help="OpenCode session id"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    limit: int = typer.Option(5, help="Max error batches to retry"),
) -> None:
    """Retry error raw-event flush batches for a session."""

    from .raw_event_flush import flush_raw_events as flush

    store = _store(db_path)
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


@app.command()
def mcp() -> None:
    """Run the MCP server for OpenCode."""
    from .mcp_server import run as mcp_run

    mcp_run()


@app.command()
def ingest() -> None:
    """Ingest plugin events from stdin."""
    from .plugin_ingest import main as ingest_main

    ingest_main()


@app.command()
def import_from_claude_mem(
    claude_db: str = typer.Argument(..., help="Path to claude-mem database"),
    db_path: str = typer.Option(None, help="Path to opencode-mem SQLite database"),
    project_filter: str = typer.Option(None, help="Only import memories from specific project"),
    dry_run: bool = typer.Option(False, help="Preview import without writing"),
) -> None:
    """Import memories from claude-mem database."""
    import sqlite3

    claude_db_path = Path(claude_db).expanduser()
    if not claude_db_path.exists():
        print(f"[red]Claude-mem database not found: {claude_db_path}[/red]")
        raise typer.Exit(code=1)

    store = _store(db_path)

    # Connect to claude-mem database (read-only)
    try:
        claude_conn = sqlite3.connect(f"file:{claude_db_path}?mode=ro", uri=True)
        claude_conn.row_factory = sqlite3.Row
    except Exception as e:
        print(f"[red]Failed to open claude-mem database: {e}[/red]")
        raise typer.Exit(code=1) from None

    # Count records
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

    prompts_where = ""
    prompts_params: list[str] = []
    if project_filter:
        prompts_where = """
        WHERE content_session_id IN (
            SELECT content_session_id FROM sdk_sessions WHERE project = ?
        )
        """
        prompts_params = [project_filter]

    prompts_count = claude_conn.execute(
        f"SELECT COUNT(*) as count FROM user_prompts {prompts_where}", prompts_params
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

    # Get all unique projects to create sessions
    project_sessions = {}  # project -> session_id mapping
    created_session_ids: list[int] = []
    source_db = str(claude_db_path)

    def get_project_session(project: str) -> int:
        existing = project_sessions.get(project)
        if existing:
            return existing
        import_key = _build_import_key(
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

    # Import observations
    print("\n[bold]Importing observations...[/bold]")
    obs_query = f"""
        SELECT * FROM observations
        {where_clause}
        ORDER BY created_at_epoch ASC
    """
    for row in claude_conn.execute(obs_query, params):
        project = row["project"]
        session_id = get_project_session(project)
        import_key = _build_import_key(
            "claude-mem",
            "observation",
            row["id"],
            project=project,
            created_at=row["created_at"],
            source_db=source_db,
        )
        if store.find_imported_id("memory_items", import_key):
            continue

        store.remember_observation(
            session_id,
            kind=row["type"],
            title=row["title"] or "Untitled",
            narrative=row["narrative"] or row["text"] or "",
            subtitle=row["subtitle"],
            facts=json.loads(row["facts"]) if row["facts"] else None,
            concepts=json.loads(row["concepts"]) if row["concepts"] else None,
            files_read=json.loads(row["files_read"]) if row["files_read"] else None,
            files_modified=json.loads(row["files_modified"]) if row["files_modified"] else None,
            prompt_number=row["prompt_number"],
            confidence=0.7,
            metadata={
                "source": "claude-mem",
                "original_session_id": row["memory_session_id"],
                "original_observation_id": row["id"],
                "created_at": row["created_at"],
                "created_at_epoch": row["created_at_epoch"],
                "source_db": source_db,
                "import_key": import_key,
            },
        )
        imported_obs += 1
        if imported_obs % 100 == 0:
            print(f"  Imported {imported_obs}/{obs_count} observations...")

    print(f"[green]✓ Imported {imported_obs} observations[/green]")

    # Import session summaries
    print("\n[bold]Importing session summaries...[/bold]")
    summaries_query = f"""
        SELECT * FROM session_summaries
        {where_clause}
        ORDER BY created_at_epoch ASC
    """
    for row in claude_conn.execute(summaries_query, params):
        project = row["project"]
        session_id = get_project_session(project)
        import_key = _build_import_key(
            "claude-mem",
            "summary",
            row["id"],
            project=project,
            created_at=row["created_at"],
            source_db=source_db,
        )
        if store.find_imported_id("session_summaries", import_key):
            continue

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
            files_edited=json.loads(row["files_edited"]) if row["files_edited"] else None,
            prompt_number=row["prompt_number"],
            metadata={
                "source": "claude-mem",
                "original_session_id": row["memory_session_id"],
                "original_summary_id": row["id"],
                "created_at": row["created_at"],
                "created_at_epoch": row["created_at_epoch"],
                "source_db": source_db,
                "import_key": import_key,
            },
        )
        # Also add as memory item for searchability
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
            summary_memory_key = _build_import_key(
                "claude-mem",
                "summary-memory",
                row["id"],
                project=project,
                created_at=row["created_at"],
                source_db=source_db,
            )
            if not store.find_imported_id("memory_items", summary_memory_key):
                store.remember(
                    session_id,
                    kind="session_summary",
                    title=row["request"][:80] if row["request"] else "Session summary",
                    body_text=summary_text,
                    confidence=0.7,
                    metadata={
                        "source": "claude-mem",
                        "original_session_id": row["memory_session_id"],
                        "original_summary_id": row["id"],
                        "created_at": row["created_at"],
                        "source_db": source_db,
                        "import_key": summary_memory_key,
                    },
                )
        imported_summaries += 1
        if imported_summaries % 50 == 0:
            print(f"  Imported {imported_summaries}/{summaries_count} summaries...")

    print(f"[green]✓ Imported {imported_summaries} session summaries[/green]")

    # Import user prompts
    print("\n[bold]Importing user prompts...[/bold]")
    prompts_query = f"""
        SELECT p.*, s.project
        FROM user_prompts p
        LEFT JOIN sdk_sessions s ON s.content_session_id = p.content_session_id
        {prompts_where}
        ORDER BY p.created_at_epoch ASC
    """
    for row in claude_conn.execute(prompts_query, prompts_params):
        project = row["project"]
        session_id = get_project_session(project) if project else None
        if session_id:
            import_key = _build_import_key(
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

    # Close connections and end all sessions
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


@app.command()
def serve(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    host: str = typer.Option(DEFAULT_VIEWER_HOST, help="Host to bind viewer"),
    port: int = typer.Option(DEFAULT_VIEWER_PORT, help="Port to bind viewer"),
    background: bool = typer.Option(False, help="Run viewer in background"),
    stop: bool = typer.Option(False, help="Stop background viewer"),
    restart: bool = typer.Option(False, help="Restart background viewer"),
) -> None:
    if stop and restart:
        print("[red]Use only one of --stop or --restart[/red]")
        raise typer.Exit(code=1)

    if db_path:
        os.environ["OPENCODE_MEM_DB"] = db_path
    pid_path = _viewer_pid_path()

    if stop or restart:
        pid = _read_pid(pid_path)
        if pid is None and _port_open(host, port):
            pid = _pid_for_port(port)
            if pid is not None:
                print(f"[yellow]Found viewer pid {pid} by port scan[/yellow]")
        if pid is None:
            if _port_open(host, port):
                print("[yellow]Viewer is running but no PID file was found[/yellow]")
            else:
                print("[yellow]No background viewer found[/yellow]")
        elif not _pid_running(pid):
            _clear_pid(pid_path)
            print("[yellow]Removed stale viewer PID file[/yellow]")
        else:
            os.kill(pid, signal.SIGTERM)
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                if not _pid_running(pid):
                    break
                time.sleep(0.05)
            _clear_pid(pid_path)
            print(f"[green]Stopped viewer (pid {pid})[/green]")
        if stop:
            return
        background = True

    if background:
        pid = _read_pid(pid_path)
        if pid is not None and _pid_running(pid):
            print(f"[yellow]Viewer already running (pid {pid})[/yellow]")
            return
        if pid is not None:
            _clear_pid(pid_path)
        if _port_open(host, port):
            print(f"[yellow]Viewer already running at http://{host}:{port}[/yellow]")
            return
        cmd = [
            sys.executable,
            "-m",
            "opencode_mem.cli",
            "serve",
            "--host",
            host,
            "--port",
            str(port),
        ]
        if db_path:
            cmd += ["--db-path", db_path]
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            env=os.environ.copy(),
        )
        _write_pid(pid_path, proc.pid)
        print(
            f"[green]Viewer started in background (pid {proc.pid}) at http://{host}:{port}[/green]"
        )
        return

    if _port_open(host, port):
        print(f"[yellow]Viewer already running at http://{host}:{port}[/yellow]")
        return
    print(f"[green]Viewer running at http://{host}:{port}[/green]")
    start_viewer(host=host, port=port, background=False)


@app.command()
def export_memories(
    output: str = typer.Argument(..., help="Output file path (use '-' for stdout)"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    project: str = typer.Option(None, help="Filter by project (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Export all projects"),
    include_inactive: bool = typer.Option(False, help="Include deactivated memories"),
    since: str = typer.Option(
        None, help="Only export memories created after this date (ISO format)"
    ),
) -> None:
    """Export memories to a JSON file for sharing or backup."""
    store = _store(db_path)
    resolved_project = _resolve_project(os.getcwd(), project, all_projects=all_projects)

    # Build filters
    filters = {}
    if resolved_project:
        filters["project"] = resolved_project
    if since:
        filters["since"] = since

    # Fetch sessions
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
    sessions = []
    session_ids = []
    for row in sessions_rows:
        session_data = dict(row)
        session_data["metadata_json"] = db.from_json(session_data.get("metadata_json"))
        sessions.append(session_data)
        session_ids.append(row["id"])

    if not session_ids:
        print("[yellow]No sessions found matching filters[/yellow]")
        raise typer.Exit(code=0)

    # Fetch memory items for these sessions
    active_clause = "" if include_inactive else " AND active = 1"
    mem_placeholders = ",".join("?" for _ in session_ids)
    memories_rows = store.conn.execute(
        f"SELECT * FROM memory_items WHERE session_id IN ({mem_placeholders}){active_clause} ORDER BY created_at ASC",
        session_ids,
    ).fetchall()
    memories = []
    for row in memories_rows:
        mem_data = dict(row)
        mem_data["metadata_json"] = db.from_json(mem_data.get("metadata_json"))
        mem_data["facts"] = db.from_json(mem_data.get("facts"))
        mem_data["concepts"] = db.from_json(mem_data.get("concepts"))
        mem_data["files_read"] = db.from_json(mem_data.get("files_read"))
        mem_data["files_modified"] = db.from_json(mem_data.get("files_modified"))
        memories.append(mem_data)

    # Fetch session summaries
    summaries_rows = store.conn.execute(
        f"SELECT * FROM session_summaries WHERE session_id IN ({mem_placeholders}) ORDER BY created_at_epoch ASC",
        session_ids,
    ).fetchall()
    summaries = []
    for row in summaries_rows:
        summary_data = dict(row)
        summary_data["metadata_json"] = db.from_json(summary_data.get("metadata_json"))
        summary_data["files_read"] = db.from_json(summary_data.get("files_read"))
        summary_data["files_edited"] = db.from_json(summary_data.get("files_edited"))
        summaries.append(summary_data)

    # Fetch user prompts
    prompts_rows = store.conn.execute(
        f"SELECT * FROM user_prompts WHERE session_id IN ({mem_placeholders}) ORDER BY created_at_epoch ASC",
        session_ids,
    ).fetchall()
    prompts = []
    for row in prompts_rows:
        prompt_data = dict(row)
        prompt_data["metadata_json"] = db.from_json(prompt_data.get("metadata_json"))
        prompts.append(prompt_data)

    # Build export structure
    export_data = {
        "version": "1.0",
        "exported_at": dt.datetime.now(dt.UTC).isoformat(),
        "export_metadata": {
            "tool_version": "opencode-mem",
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

    # Write output
    output_json = json.dumps(export_data, ensure_ascii=False, indent=2)
    if output == "-":
        print(output_json)
    else:
        output_path = Path(output).expanduser()
        output_path.write_text(output_json, encoding="utf-8")
        size_mb = len(output_json) / 1024 / 1024
        print(f"[green]✓ Exported to {output_path}[/green]")
        print(f"  Size: {size_mb:.1f} MB")
        print(f"  Sessions: {len(sessions)}")
        print(f"  Memories: {len(memories)}")
        print(f"  Summaries: {len(summaries)}")
        print(f"  Prompts: {len(prompts)}")


@app.command()
def import_memories(
    input_file: str = typer.Argument(..., help="Input JSON file (use '-' for stdin)"),
    db_path: str = typer.Option(None, help="Path to opencode-mem SQLite database"),
    remap_project: str = typer.Option(None, help="Remap all projects to this path on import"),
    dry_run: bool = typer.Option(False, help="Preview import without writing"),
) -> None:
    """Import memories from an exported JSON file."""
    # Read input
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

    # Validate structure
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

    store = _store(db_path)

    # Create session mapping: old session_id -> new session_id
    session_mapping = {}
    imported_sessions = 0
    created_session_ids: list[int] = []

    print("\n[bold]Importing sessions...[/bold]")
    for sess_data in sessions_data:
        old_session_id = sess_data["id"]
        project = remap_project if remap_project else sess_data.get("project")

        import_key = _build_import_key(
            "export",
            "session",
            old_session_id,
            project=project,
            created_at=sess_data.get("started_at"),
        )
        existing_session_id = store.find_imported_id("sessions", import_key)
        if existing_session_id:
            session_mapping[old_session_id] = existing_session_id
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
        session_mapping[old_session_id] = new_session_id
        imported_sessions += 1
        created_session_ids.append(new_session_id)
        if imported_sessions % 10 == 0:
            print(f"  Imported {imported_sessions}/{len(sessions_data)} sessions...")

    print(f"[green]✓ Imported {imported_sessions} sessions[/green]")

    # Import memory items
    print("\n[bold]Importing memory items...[/bold]")
    imported_memories = 0
    for mem_data in memories_data:
        old_session_id = mem_data.get("session_id")
        new_session_id = session_mapping.get(old_session_id)
        if not new_session_id:
            continue
        import_key = _build_import_key(
            "export",
            "memory",
            mem_data.get("id"),
            project=remap_project or mem_data.get("project"),
            created_at=mem_data.get("created_at"),
        )
        if store.find_imported_id("memory_items", import_key):
            continue

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
                metadata={
                    "source": "export",
                    "original_memory_id": mem_data.get("id"),
                    "original_created_at": mem_data.get("created_at"),
                    "import_metadata": mem_data.get("metadata_json"),
                    "import_key": import_key,
                },
            )
        else:
            store.remember(
                new_session_id,
                kind=mem_data.get("kind", "observation"),
                title=mem_data.get("title", "Untitled"),
                body_text=mem_data.get("body_text", ""),
                confidence=mem_data.get("confidence", 0.5),
                tags=mem_data.get("tags_text", "").split() if mem_data.get("tags_text") else None,
                metadata={
                    "source": "export",
                    "original_memory_id": mem_data.get("id"),
                    "original_created_at": mem_data.get("created_at"),
                    "import_metadata": mem_data.get("metadata_json"),
                    "import_key": import_key,
                },
            )
        imported_memories += 1
        if imported_memories % 100 == 0:
            print(f"  Imported {imported_memories}/{len(memories_data)} memories...")

    print(f"[green]✓ Imported {imported_memories} memory items[/green]")

    # Import session summaries
    print("\n[bold]Importing session summaries...[/bold]")
    imported_summaries = 0
    for summ_data in summaries_data:
        old_session_id = summ_data.get("session_id")
        new_session_id = session_mapping.get(old_session_id)
        if not new_session_id:
            continue

        project = remap_project if remap_project else summ_data.get("project")
        import_key = _build_import_key(
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

    # Import user prompts
    print("\n[bold]Importing user prompts...[/bold]")
    imported_prompts = 0
    for prompt_data in prompts_data:
        old_session_id = prompt_data.get("session_id")
        new_session_id = session_mapping.get(old_session_id)
        if not new_session_id:
            continue

        project = remap_project if remap_project else prompt_data.get("project")
        import_key = _build_import_key(
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

    # End all sessions
    for new_session_id in created_session_ids:
        store.end_session(
            new_session_id,
            metadata={
                "imported_memories": imported_memories,
                "imported_summaries": imported_summaries,
                "imported_prompts": imported_prompts,
            },
        )

    print("\n[bold green]✓ Import complete![/bold green]")
    print(f"- Sessions: {imported_sessions}")
    print(f"- Memories: {imported_memories}")
    print(f"- Summaries: {imported_summaries}")
    print(f"- Prompts: {imported_prompts}")


@app.command()
def install_plugin(
    force: bool = typer.Option(False, "--force", "-f", help="Overwrite existing plugin file"),
) -> None:
    """Install the opencode-mem plugin to OpenCode's plugin directory."""
    import shutil

    # Determine plugin source path (relative to this CLI file)
    # In installed package: opencode_mem/.opencode/plugin/opencode-mem.js
    # In dev mode: .opencode/plugin/opencode-mem.js (relative to repo root)
    cli_dir = Path(__file__).parent
    plugin_source = cli_dir / ".opencode" / "plugin" / "opencode-mem.js"

    # Fallback to repo root location for dev mode
    if not plugin_source.exists():
        plugin_source = cli_dir.parent / ".opencode" / "plugin" / "opencode-mem.js"

    if not plugin_source.exists():
        print("[red]Error: Plugin file not found in package[/red]")
        print(f"[dim]Searched: {cli_dir / '.opencode' / 'plugin'}[/dim]")
        print(f"[dim]Searched: {cli_dir.parent / '.opencode' / 'plugin'}[/dim]")
        raise typer.Exit(code=1)

    # Determine OpenCode plugin directory
    opencode_config_dir = Path.home() / ".config" / "opencode"
    plugin_dir = opencode_config_dir / "plugin"
    plugin_dest = plugin_dir / "opencode-mem.js"

    # Check if already exists
    if plugin_dest.exists() and not force:
        print(f"[yellow]Plugin already installed at {plugin_dest}[/yellow]")
        print("[dim]Use --force to overwrite[/dim]")
        return

    # Create plugin directory if needed
    plugin_dir.mkdir(parents=True, exist_ok=True)

    # Copy plugin file
    shutil.copy2(plugin_source, plugin_dest)
    print(f"[green]✓ Plugin installed to {plugin_dest}[/green]")
    print("\n[bold]Next steps:[/bold]")
    print("1. Restart OpenCode to load the plugin")
    print("2. The plugin will auto-detect installed mode and use SSH git URLs")
    print("3. View logs at: [dim]~/.opencode-mem/plugin.log[/dim]")


@app.command()
def install_mcp(
    force: bool = typer.Option(False, "--force", "-f", help="Overwrite existing MCP config"),
) -> None:
    """Install the opencode-mem MCP entry into OpenCode's config."""
    config_path = Path.home() / ".config" / "opencode" / "opencode.json"
    try:
        config = _load_opencode_config(config_path)
    except Exception as exc:
        print(f"[red]Error: Failed to parse {config_path}: {exc}[/red]")
        raise typer.Exit(code=1) from exc

    if not isinstance(config, dict):
        config = {}

    mcp_config = config.get("mcp")
    if not isinstance(mcp_config, dict):
        mcp_config = {}

    if "opencode_mem" in mcp_config and not force:
        print(f"[yellow]MCP entry already exists in {config_path}[/yellow]")
        print("[dim]Use --force to overwrite[/dim]")
        return

    mcp_config["opencode_mem"] = {
        "type": "local",
        "command": ["uvx", "opencode-mem", "mcp"],
        "enabled": True,
    }
    config["mcp"] = mcp_config

    try:
        _write_opencode_config(config_path, config)
    except Exception as exc:
        print(f"[red]Error: Failed to write {config_path}: {exc}[/red]")
        raise typer.Exit(code=1) from exc

    print(f"[green]✓ MCP entry installed in {config_path}[/green]")
    print("Restart OpenCode to load the MCP tools.")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
