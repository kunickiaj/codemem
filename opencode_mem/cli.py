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
from typing import List, Optional

import typer
from rich import print

from .capture import (
    build_artifact_bundle,
    capture_post_context,
    capture_pre_context,
    run_command_with_capture,
)
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


def _resolve_project(
    cwd: str, project: str | None, all_projects: bool = False
) -> str | None:
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


def _build_inject_query(pre: dict[str, str], cwd: str, project: str | None) -> str:
    project_label = project or pre.get("project") or ""
    project_name = Path(project_label).name if project_label else Path(cwd).name
    branch = pre.get("git_branch") or ""
    diff_summary = _compact_lines(pre.get("git_diff") or "", limit=6)
    recent_files = _compact_list(pre.get("recent_files") or "", limit=6)
    parts = [project_name]
    if branch:
        parts.append(f"branch {branch}")
    if recent_files:
        parts.append(f"files {recent_files}")
    if diff_summary:
        parts.append(f"diff {diff_summary}")
    return " | ".join(parts).strip()


def _inject_into_opencode_exec(
    args: list[str], injected_text: str
) -> tuple[list[str], bool]:
    if not args:
        return args, False
    if args[0] != "opencode":
        return args, False
    if "exec" not in args:
        return args, False
    if len(args) < 2:
        return args, False
    updated = list(args)
    updated[-1] = f"{injected_text}\n\n{updated[-1]}"
    return updated, True


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


@app.command()
def init_db(db_path: str = typer.Option(None, help="Path to SQLite database")) -> None:
    store = _store(db_path)
    print(f"Initialized database at {store.db_path}")


@app.command(
    context_settings={"allow_extra_args": True, "ignore_unknown_options": True}
)
def run(
    ctx: typer.Context,
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    project: str = typer.Option(
        None, help="Project identifier (defaults to git repo root)"
    ),
    inject: bool = typer.Option(
        True, "--inject/--no-inject", help="Auto-inject context from memories"
    ),
    inject_query: str = typer.Option(
        None, help="Override the context query used for auto-inject"
    ),
    tool_version: str = typer.Option("dev", help="Version label to record"),
    auto_compact: bool = typer.Option(
        True, help="Re-summarize session at end using model if configured"
    ),
    max_observations: int = typer.Option(
        5, help="Max observations to store in summaries"
    ),
) -> None:
    """Wrapper command that runs OpenCode (or any command) and writes memories."""
    extra = list(ctx.args)
    if not extra:
        print(
            "[red]No command provided. Usage: opencode-mem run -- opencode chat[/red]"
        )
        raise typer.Exit(code=1)
    cwd = os.getcwd()
    user = getpass.getuser()
    viewer_enabled = os.environ.get("OPENCODE_MEM_VIEWER", "1").lower() not in {
        "0",
        "false",
        "off",
    }
    if viewer_enabled:
        host = os.environ.get("OPENCODE_MEM_VIEWER_HOST", DEFAULT_VIEWER_HOST)
        port = int(os.environ.get("OPENCODE_MEM_VIEWER_PORT", str(DEFAULT_VIEWER_PORT)))
        start_viewer(host=host, port=port, background=True)
        print(f"[green]Viewer running at http://{host}:{port}[/green]")

    store = _store(db_path)
    pre = capture_pre_context(cwd)
    resolved_project = (
        project or os.environ.get("OPENCODE_MEM_PROJECT") or pre.get("project")
    )
    started_at = dt.datetime.now(dt.UTC)

    injected = False
    if inject:
        query = inject_query or _build_inject_query(pre, cwd, resolved_project)
        if query:
            filters = {"project": resolved_project} if resolved_project else None
            pack = store.build_memory_pack(context=query, limit=12, filters=filters)
            pack_text = pack.get("pack_text", "").strip()
            if pack_text:
                injected_text = f"[opencode-mem context]\n{pack_text}"
                extra, injected = _inject_into_opencode_exec(extra, injected_text)
                if not injected:
                    print(
                        "[yellow]opencode-mem context (paste into session if needed):[/yellow]"
                    )
                    print(injected_text)

    session_id = store.start_session(
        cwd=cwd,
        project=resolved_project,
        git_remote=pre.get("git_remote"),
        git_branch=pre.get("git_branch"),
        user=user,
        tool_version=tool_version,
        metadata={"pre": pre},
    )
    print(f"[green]Started session {session_id}[/green]")

    result = run_command_with_capture(extra, cwd=cwd)
    post = capture_post_context(cwd)

    transcript_for_store = result.transcript
    artifacts = build_artifact_bundle(
        pre,
        post,
        transcript_for_store,
    )
    for kind, body, path in artifacts:
        store.add_artifact(session_id, kind=kind, path=path, content_text=body)

    summarizer = Summarizer(max_observations=max_observations, force_heuristic=True)
    summary = summarizer.summarize(
        transcript=transcript_for_store,
        diff_summary=post.get("git_diff") or "",
        recent_files=post.get("recent_files") or "",
    )

    store.remember(
        session_id,
        kind="session_summary",
        title="Session summary",
        body_text=summary.session_summary,
        confidence=0.7,
    )
    for obs in summary.observations:
        store.remember(
            session_id,
            kind="observation",
            title=obs[:80],
            body_text=obs,
            confidence=0.6,
        )
    if summary.entities:
        store.remember(
            session_id,
            kind="entities",
            title="Entities",
            body_text="; ".join(summary.entities),
            confidence=0.4,
        )

    summary_for_stats = summary
    if auto_compact:
        rich_summarizer = Summarizer(max_observations=max_observations)
        rich_summary = rich_summarizer.summarize(
            transcript=transcript_for_store,
            diff_summary=post.get("git_diff") or "",
            recent_files=post.get("recent_files") or "",
        )
        store.replace_session_summary(session_id, rich_summary)
        summary_for_stats = rich_summary
        print(f"[green]Session {session_id} auto-compacted[/green]")

    transcript_tokens = store.estimate_tokens(transcript_for_store)
    summary_tokens = store.estimate_tokens(summary_for_stats.session_summary)
    summary_tokens += sum(
        store.estimate_tokens(obs) for obs in summary_for_stats.observations
    )
    summary_tokens += sum(
        store.estimate_tokens(entity) for entity in summary_for_stats.entities
    )
    tokens_saved = max(0, transcript_tokens - summary_tokens)
    store.record_usage(
        "summarize",
        session_id=session_id,
        tokens_read=transcript_tokens,
        tokens_written=summary_tokens,
        tokens_saved=tokens_saved,
        metadata={"mode": "auto" if auto_compact else "heuristic"},
    )

    store.end_session(
        session_id, metadata={"post": post, "returncode": result.returncode}
    )
    print(
        f"[green]Session {session_id} completed with code {result.returncode}[/green]"
    )


@app.command()
def search(
    query: str,
    limit: int = typer.Option(5),
    db_path: str = typer.Option(None),
    project: str = typer.Option(
        None, help="Project identifier (defaults to git repo root)"
    ),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
) -> None:
    store = _store(db_path)
    resolved_project = _resolve_project(os.getcwd(), project, all_projects=all_projects)
    filters = {"project": resolved_project} if resolved_project else None
    results = store.search(query, limit=limit, filters=filters)
    for item in results:
        print(
            f"[{item.id}] ({item.kind}) {item.title}\n{item.body_text}\nscore={item.score:.2f}\n"
        )


@app.command()
def recent(
    limit: int = typer.Option(5),
    kind: Optional[str] = typer.Option(None),
    db_path: str = typer.Option(None),
    project: str = typer.Option(
        None, help="Project identifier (defaults to git repo root)"
    ),
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
    tags: List[str] = typer.Option(None),
    db_path: str = typer.Option(None),
    project: str = typer.Option(
        None, help="Project identifier (defaults to git repo root)"
    ),
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
    mem_id = store.remember(
        session_id, kind=kind, title=title, body_text=body, tags=tags
    )
    store.end_session(session_id, metadata={"manual": True})
    print(f"Stored memory {mem_id}")


@app.command()
def forget(memory_id: int, db_path: str = typer.Option(None)) -> None:
    store = _store(db_path)
    store.forget(memory_id)
    print(f"Memory {memory_id} marked inactive")


@app.command()
def prune_observations(
    limit: Optional[int] = typer.Option(
        None, help="Max observations to scan (defaults to all)"
    ),
    dry_run: bool = typer.Option(False, help="Report without deactivating"),
    db_path: str = typer.Option(None),
) -> None:
    store = _store(db_path)
    result = store.deactivate_low_signal_observations(limit=limit, dry_run=dry_run)
    action = "Would deactivate" if dry_run else "Deactivated"
    print(f"{action} {result['deactivated']} of {result['checked']} observations")


@app.command()
def pack(
    context: str,
    limit: int = typer.Option(8),
    token_budget: int = typer.Option(None, help="Approx token budget for pack"),
    db_path: str = typer.Option(None),
    project: str = typer.Option(
        None, help="Project identifier (defaults to git repo root)"
    ),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
) -> None:
    store = _store(db_path)
    resolved_project = _resolve_project(os.getcwd(), project, all_projects=all_projects)
    filters = {"project": resolved_project} if resolved_project else None
    pack = store.build_memory_pack(
        context=context, limit=limit, token_budget=token_budget, filters=filters
    )
    print(json.dumps(pack, indent=2))


@app.command()
def inject(
    context: str,
    limit: int = typer.Option(8),
    token_budget: int = typer.Option(None, help="Approx token budget for injection"),
    db_path: str = typer.Option(None),
    project: str = typer.Option(
        None, help="Project identifier (defaults to git repo root)"
    ),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
) -> None:
    """Build a context block from memories for manual injection into prompts."""
    store = _store(db_path)
    resolved_project = _resolve_project(os.getcwd(), project, all_projects=all_projects)
    filters = {"project": resolved_project} if resolved_project else None
    pack = store.build_memory_pack(
        context=context, limit=limit, token_budget=token_budget, filters=filters
    )
    print(pack.get("pack_text", ""))


@app.command()
def compact(
    session_id: Optional[int] = typer.Option(
        None, help="Specific session id to compact"
    ),
    limit: int = typer.Option(
        3, help="Number of recent sessions to compact when no id is given"
    ),
    db_path: str = typer.Option(None),
) -> None:
    """Re-run summarization for past sessions (uses model if configured)."""
    store = _store(db_path)
    summarizer = Summarizer()
    sessions = store.all_sessions()
    if session_id:
        sessions = [s for s in sessions if s["id"] == session_id]
    else:
        sessions = sessions[:limit]
    if not sessions:
        print("[yellow]No sessions found to compact[/yellow]")
        return
    for sess in sessions:
        transcript = store.latest_transcript(sess["id"])
        if not transcript:
            print(
                f"[yellow]Skipping session {sess['id']}: no transcript artifact[/yellow]"
            )
            continue
        summary = summarizer.summarize(
            transcript=transcript, diff_summary="", recent_files=""
        )
        store.replace_session_summary(sess["id"], summary)
        transcript_tokens = store.estimate_tokens(transcript)
        summary_tokens = store.estimate_tokens(summary.session_summary)
        summary_tokens += sum(
            store.estimate_tokens(obs) for obs in summary.observations
        )
        summary_tokens += sum(
            store.estimate_tokens(entity) for entity in summary.entities
        )
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
    print(
        f"- Memory items: {db_stats['memory_items']} (active {db_stats['active_memory_items']})"
    )
    print(f"- Artifacts: {db_stats['artifacts']}")

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


def main() -> None:
    app()


if __name__ == "__main__":
    main()
