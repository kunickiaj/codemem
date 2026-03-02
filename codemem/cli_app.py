from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

import typer
from rich import print

from . import __version__, db
from .commands.common import (
    compact_lines,
    compact_list,
    mdns_runtime_status,
    normalize_local_check_host,
    read_config_or_exit,
    resolve_project_for_cli,
    write_config_or_exit,
)
from .commands.db_cmds import (
    normalize_projects_cmd,
    prune_memories_cmd,
    prune_observations_cmd,
    rename_project_cmd,
)
from .commands.import_export_cmds import export_memories_cmd, import_memories_cmd
from .commands.maintenance_cmds import (
    backfill_discovery_tokens_cmd,
    backfill_tags_cmd,
    embed_cmd,
    hybrid_eval_cmd,
    ingest_cmd,
    init_db_cmd,
    mcp_cmd,
    pack_benchmark_cmd,
    pack_stats_cmd,
    stats_cmd,
)
from .commands.memory_cmds import (
    compact_cmd,
    forget_cmd,
    inject_cmd,
    normalize_imported_metadata_cmd,
    pack_cmd,
    recent_cmd,
    remember_cmd,
    search_cmd,
    show_cmd,
)
from .commands.opencode_integration_cmds import install_mcp_cmd, install_plugin_cmd
from .commands.raw_events_cmds import (
    flush_raw_events_cmd,
    raw_events_gate_cmd,
    raw_events_retry_cmd,
    raw_events_status_cmd,
)
from .commands.sync_cmds import (
    sync_attempts_cmd,
    sync_daemon_cmd,
    sync_disable_cmd,
    sync_doctor_cmd,
    sync_enable_cmd,
    sync_install_cmd,
    sync_once_cmd,
    sync_pair_cmd,
    sync_peers_list_cmd,
    sync_peers_remove_cmd,
    sync_peers_rename_cmd,
    sync_repair_legacy_keys_cmd,
    sync_status_cmd,
    sync_uninstall_cmd,
)
from .commands.sync_service_cmds import install_autostart_quiet as _install_autostart_quiet
from .commands.sync_service_cmds import run_service_action as _run_service_action
from .commands.sync_service_cmds import run_service_action_quiet as _run_service_action_quiet
from .commands.sync_service_cmds import (
    sync_service_restart_cmd,
    sync_service_start_cmd,
    sync_service_status_cmd,
    sync_service_stop_cmd,
)
from .commands.sync_service_cmds import sync_uninstall_impl as _sync_uninstall_impl
from .commands.viewer_cmds import _port_open
from .commands.viewer_cmds import serve as _serve
from .config import get_config_path, load_config
from .db import DEFAULT_DB_PATH
from .net import pick_advertise_host, pick_advertise_hosts
from .store import MemoryStore
from .summarizer import Summarizer
from .sync.daemon import run_sync_daemon
from .sync.discovery import (
    discover_peers_via_mdns,
    mdns_enabled,
    set_peer_project_filter,
    update_peer_addresses,
)
from .sync.sync_pass import run_sync_pass, sync_pass_preflight
from .sync_identity import ensure_device_identity, fingerprint_public_key, load_public_key
from .sync_runtime import effective_status, spawn_daemon, stop_pidfile_with_reason
from .viewer import DEFAULT_VIEWER_HOST, DEFAULT_VIEWER_PORT

app = typer.Typer(help="codemem: persistent memory for OpenCode CLI")
sync_app = typer.Typer(help="Sync codemem between devices")
sync_peers_app = typer.Typer(help="Manage sync peers")
db_app = typer.Typer(help="Database maintenance")
app.add_typer(sync_app, name="sync")
sync_app.add_typer(sync_peers_app, name="peers")
app.add_typer(db_app, name="db")


@sync_app.command("attempts")
def sync_attempts(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    limit: int = typer.Option(10, help="Number of attempts to show"),
) -> None:
    """Show recent sync attempts."""

    sync_attempts_cmd(store_from_path=_store, db_path=db_path, limit=limit)


@sync_app.command("start")
def sync_start(
    user: bool = typer.Option(True, help="Use user-level service"),
    system: bool = typer.Option(False, help="Use system-level service"),
) -> None:
    """Start sync daemon (autostart if installed, else pidfile)."""

    sync_service_start(user=user, system=system)


@sync_app.command("stop")
def sync_stop(
    user: bool = typer.Option(True, help="Use user-level service"),
    system: bool = typer.Option(False, help="Use system-level service"),
) -> None:
    """Stop sync daemon."""

    sync_service_stop(user=user, system=system)


@sync_app.command("restart")
def sync_restart(
    user: bool = typer.Option(True, help="Use user-level service"),
    system: bool = typer.Option(False, help="Use system-level service"),
) -> None:
    """Restart sync daemon."""

    sync_service_restart(user=user, system=system)


def _store(db_path: str | None) -> MemoryStore:
    return MemoryStore(db_path or DEFAULT_DB_PATH)


def _mdns_runtime_status(enabled: bool) -> tuple[bool, str]:
    return mdns_runtime_status(enabled)


def _resolve_project(cwd: str, project: str | None, all_projects: bool = False) -> str | None:
    return resolve_project_for_cli(cwd, project, all_projects=all_projects)


def _compact_lines(text: str, limit: int) -> str:
    return compact_lines(text, limit)


def _compact_list(text: str, limit: int) -> str:
    return compact_list(text, limit)


def _read_config_or_exit() -> dict[str, Any]:
    return read_config_or_exit()


def _write_config_or_exit(data: dict[str, Any]) -> None:
    write_config_or_exit(data)


def _normalize_local_check_host(host: str) -> str:
    return normalize_local_check_host(host)


def _sync_daemon_running(host: str, port: int) -> bool:
    return effective_status(host, port).running


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


SUMMARY_METADATA_KEYS = (
    "request",
    "investigated",
    "learned",
    "completed",
    "next_steps",
    "notes",
    "files_read",
    "files_modified",
    "prompt_number",
    "request_original",
    "discovery_tokens",
    "discovery_source",
)


def _coerce_import_metadata(import_metadata: Any) -> dict[str, Any] | None:
    if import_metadata is None:
        return None
    if isinstance(import_metadata, dict):
        return import_metadata
    if isinstance(import_metadata, str):
        try:
            parsed = json.loads(import_metadata)
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, dict):
            return parsed
    return None


def _merge_summary_metadata(metadata: dict[str, Any], import_metadata: Any) -> dict[str, Any]:
    parsed_import_metadata = _coerce_import_metadata(import_metadata)
    if not parsed_import_metadata:
        return metadata
    merged = dict(metadata)
    for key in SUMMARY_METADATA_KEYS:
        if key not in parsed_import_metadata:
            continue
        current = merged.get(key)
        should_fill = key not in merged
        if not should_fill:
            if key in {"discovery_tokens", "prompt_number"}:
                should_fill = current is None
            elif isinstance(current, str):
                should_fill = not current.strip()
            elif isinstance(current, list):
                should_fill = len(current) == 0
            else:
                should_fill = current is None
        if should_fill:
            merged[key] = parsed_import_metadata[key]
    merged["import_metadata"] = import_metadata
    return merged


@app.command()
def init_db(db_path: str = typer.Option(None, help="Path to SQLite database")) -> None:
    """Create the SQLite database (no-op if it already exists)."""
    init_db_cmd(store_from_path=_store, db_path=db_path)


@app.command()
def search(
    query: str,
    limit: int = typer.Option(5, help="Max results"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
) -> None:
    """Search memories by keyword or semantic recall."""
    search_cmd(
        store_from_path=_store,
        resolve_project=_resolve_project,
        db_path=db_path,
        query=query,
        limit=limit,
        project=project,
        all_projects=all_projects,
    )


@app.command()
def recent(
    limit: int = typer.Option(5, help="Max results"),
    kind: str | None = typer.Option(None, help="Filter by kind"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
) -> None:
    """Show recent memories."""
    recent_cmd(
        store_from_path=_store,
        resolve_project=_resolve_project,
        db_path=db_path,
        limit=limit,
        kind=kind,
        project=project,
        all_projects=all_projects,
    )


@app.command()
def show(memory_id: int, db_path: str = typer.Option(None, help="Path to SQLite database")) -> None:
    """Print a memory item as JSON."""
    show_cmd(store_from_path=_store, db_path=db_path, memory_id=memory_id)


@app.command()
def remember(
    kind: str,
    title: str,
    body: str,
    tags: list[str] = typer.Option(None, help="Repeat for multiple tags"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
) -> None:
    """Manually add a memory item."""
    remember_cmd(
        store_from_path=_store,
        resolve_project=_resolve_project,
        db_path=db_path,
        kind=kind,
        title=title,
        body=body,
        tags=tags,
        project=project,
    )


@app.command()
def forget(
    memory_id: int, db_path: str = typer.Option(None, help="Path to SQLite database")
) -> None:
    """Deactivate a memory item by id."""
    forget_cmd(store_from_path=_store, db_path=db_path, memory_id=memory_id)


@db_app.command("prune-observations")
def db_prune_observations(
    limit: int | None = typer.Option(None, help="Max observations to scan (defaults to all)"),
    dry_run: bool = typer.Option(False, help="Report without deactivating"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
) -> None:
    """Deactivate low-signal observations (does not delete rows)."""
    prune_observations_cmd(store_from_path=_store, db_path=db_path, limit=limit, dry_run=dry_run)


@db_app.command("prune-memories")
def db_prune_memories(
    limit: int | None = typer.Option(None, help="Max memories to scan (defaults to all)"),
    dry_run: bool = typer.Option(False, help="Report without deactivating"),
    kinds: list[str] | None = typer.Option(
        None, help="Memory kinds to prune (defaults to common low-signal kinds)"
    ),
    db_path: str = typer.Option(None),
) -> None:
    """Deactivate low-signal memories across multiple kinds (does not delete rows)."""
    prune_memories_cmd(
        store_from_path=_store, db_path=db_path, limit=limit, dry_run=dry_run, kinds=kinds
    )


@app.command()
def pack(
    context: str,
    limit: int = typer.Option(None, help="Max memory items in the pack"),
    token_budget: int = typer.Option(None, help="Approx token budget for pack"),
    working_set_files: list[str] = typer.Option(
        None,
        "--working-set-file",
        help="Recently modified file path used as ranking hint (repeat option for multiple files)",
    ),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
) -> None:
    """Build a JSON memory pack for a query/context string."""
    pack_cmd(
        store_from_path=_store,
        resolve_project=_resolve_project,
        load_config=load_config,
        db_path=db_path,
        context=context,
        limit=limit,
        token_budget=token_budget,
        working_set_files=working_set_files,
        project=project,
        all_projects=all_projects,
    )


@app.command()
def inject(
    context: str,
    limit: int = typer.Option(None, help="Max memory items in the pack"),
    token_budget: int = typer.Option(None, help="Approx token budget for injection"),
    working_set_files: list[str] = typer.Option(
        None,
        "--working-set-file",
        help="Recently modified file path used as ranking hint (repeat option for multiple files)",
    ),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
) -> None:
    """Build a context block from memories for manual injection into prompts."""
    inject_cmd(
        store_from_path=_store,
        resolve_project=_resolve_project,
        load_config=load_config,
        db_path=db_path,
        context=context,
        limit=limit,
        token_budget=token_budget,
        working_set_files=working_set_files,
        project=project,
        all_projects=all_projects,
    )


@app.command()
def compact(
    session_id: int | None = typer.Option(None, help="Specific session id to compact"),
    limit: int = typer.Option(3, help="Number of recent sessions to compact when no id is given"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
) -> None:
    """Re-run summarization for past sessions (uses model if configured)."""
    compact_cmd(
        store_from_path=_store,
        summarizer_factory=Summarizer,
        db_path=db_path,
        session_id=session_id,
        limit=limit,
    )


@app.command()
def stats(db_path: str = typer.Option(None, help="Path to SQLite database")) -> None:
    """Show database statistics."""
    stats_cmd(store_from_path=_store, db_path=db_path)


@app.command("pack-stats")
def pack_stats(
    project: str | None = typer.Option(None, help="Filter by project"),
    all_projects: bool = typer.Option(False, "--all-projects", help="Include all projects"),
    limit: int = typer.Option(50, help="Number of recent packs to analyze"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
) -> None:
    """Analyze pack generation statistics."""
    pack_stats_cmd(
        store_from_path=_store,
        resolve_project=_resolve_project,
        db_path=db_path,
        project=project,
        all_projects=all_projects,
        limit=limit,
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
    embed_cmd(
        store_from_path=_store,
        resolve_project=_resolve_project,
        db_path=db_path,
        limit=limit,
        since=since,
        project=project,
        all_projects=all_projects,
        inactive=inactive,
        dry_run=dry_run,
    )


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

    backfill_tags_cmd(
        store_from_path=_store,
        resolve_project=_resolve_project,
        db_path=db_path,
        limit=limit,
        since=since,
        project=project,
        all_projects=all_projects,
        inactive=inactive,
        dry_run=dry_run,
    )


@app.command("backfill-discovery-tokens")
def backfill_discovery_tokens(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    limit_sessions: int = typer.Option(50, help="Max sessions to backfill"),
) -> None:
    """Populate discovery_group/discovery_tokens for existing observer memories."""

    backfill_discovery_tokens_cmd(
        store_from_path=_store, db_path=db_path, limit_sessions=limit_sessions
    )


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

    store = _store(db_path)
    try:
        flush_raw_events_cmd(
            store,
            opencode_session_id=opencode_session_id,
            cwd=cwd,
            project=project,
            started_at=started_at,
            max_events=max_events,
        )
    finally:
        store.close()


@app.command("raw-events-status")
def raw_events_status(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    limit: int = typer.Option(25, help="Max sessions to show"),
) -> None:
    """Show pending raw-event backlog by OpenCode session."""

    store = _store(db_path)
    try:
        raw_events_status_cmd(store, limit=limit)
    finally:
        store.close()


@app.command("raw-events-retry")
def raw_events_retry(
    opencode_session_id: str = typer.Argument(..., help="OpenCode session id"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    limit: int = typer.Option(5, help="Max error batches to retry"),
) -> None:
    """Retry error raw-event flush batches for a session."""

    store = _store(db_path)
    try:
        raw_events_retry_cmd(store, opencode_session_id=opencode_session_id, limit=limit)
    finally:
        store.close()


@app.command("raw-events-gate")
def raw_events_gate(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    min_flush_success_rate: float = typer.Option(
        0.99, min=0.0, max=1.0, help="Minimum flush success rate"
    ),
    max_dropped_event_rate: float = typer.Option(
        0.05, min=0.0, max=1.0, help="Maximum dropped event rate"
    ),
    min_session_boundary_accuracy: float = typer.Option(
        0.99, min=0.0, max=1.0, help="Minimum session boundary accuracy"
    ),
    max_retry_depth: int = typer.Option(3, min=0, help="Maximum observed retry depth"),
    min_events: int = typer.Option(1, min=0, help="Minimum processed events sample size"),
    min_batches: int = typer.Option(1, min=0, help="Minimum flush batch sample size"),
    min_sessions: int = typer.Option(1, min=0, help="Minimum session sample size"),
    window_hours: float = typer.Option(
        24.0, min=0.001, help="Rolling window in hours used for gate metrics"
    ),
) -> None:
    """Validate raw-event reliability metrics against baseline thresholds."""

    store = _store(db_path)
    try:
        raw_events_gate_cmd(
            store,
            min_flush_success_rate=min_flush_success_rate,
            max_dropped_event_rate=max_dropped_event_rate,
            min_session_boundary_accuracy=min_session_boundary_accuracy,
            max_retry_depth=max_retry_depth,
            min_events=min_events,
            min_batches=min_batches,
            min_sessions=min_sessions,
            window_hours=window_hours,
        )
    finally:
        store.close()


@app.command("pack-benchmark")
def pack_benchmark(
    queries_path: Path = typer.Argument(..., exists=True, readable=True),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    limit: int = typer.Option(None, help="Max items per pack"),
    token_budget: int = typer.Option(None, help="Approx token budget for each pack"),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
    json_out: Path | None = typer.Option(None, help="Write full benchmark JSON to file"),
) -> None:
    """Run pack generation for a query set and report token metrics."""

    pack_benchmark_cmd(
        store_from_path=_store,
        resolve_project=_resolve_project,
        load_config=load_config,
        db_path=db_path,
        queries_path=queries_path,
        limit=limit,
        token_budget=token_budget,
        project=project,
        all_projects=all_projects,
        json_out=json_out,
    )


@app.command("hybrid-eval")
def hybrid_eval(
    judged_queries_path: Path = typer.Argument(
        ...,
        exists=True,
        dir_okay=False,
        file_okay=True,
        readable=True,
        resolve_path=True,
        help="Path to judged query JSONL file",
    ),
    limit: int = typer.Option(8, help="Top-k results to evaluate"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    json_out: Path | None = typer.Option(None, help="Optional JSON output file"),
    min_delta_precision: float | None = typer.Option(
        None, help="Fail if precision delta is below this threshold"
    ),
    min_delta_recall: float | None = typer.Option(
        None, help="Fail if recall delta is below this threshold"
    ),
) -> None:
    """Evaluate baseline vs hybrid retrieval precision/recall deltas."""
    hybrid_eval_cmd(
        store_from_path=_store,
        db_path=db_path,
        judged_queries_path=judged_queries_path,
        limit=limit,
        json_out=json_out,
        min_delta_precision=min_delta_precision,
        min_delta_recall=min_delta_recall,
    )


@app.command()
def mcp() -> None:
    """Run the MCP server for OpenCode."""
    mcp_cmd()


@app.command()
def ingest() -> None:
    """Ingest plugin events from stdin."""
    ingest_cmd()


@app.command()
def import_from_claude_mem(
    claude_db: str = typer.Argument(..., help="Path to claude-mem database"),
    db_path: str = typer.Option(None, help="Path to codemem SQLite database"),
    project_filter: str = typer.Option(None, help="Only import memories from specific project"),
    update_existing: bool = typer.Option(False, help="Update previously imported rows"),
    dry_run: bool = typer.Option(False, help="Preview import without writing"),
) -> None:
    """Import memories from claude-mem database."""
    from .commands.import_from_claude_mem import run_import_from_claude_mem

    claude_db_path = Path(claude_db).expanduser()
    store = _store(db_path)
    try:
        run_import_from_claude_mem(
            claude_db_path=claude_db_path,
            store=store,
            project_filter=project_filter,
            update_existing=update_existing,
            dry_run=dry_run,
            build_import_key=_build_import_key,
        )
    finally:
        store.close()


@app.command()
def serve(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    host: str = typer.Option(DEFAULT_VIEWER_HOST, help="Host to bind viewer"),
    port: int = typer.Option(DEFAULT_VIEWER_PORT, help="Port to bind viewer"),
    background: bool = typer.Option(False, help="Run viewer in background"),
    stop: bool = typer.Option(False, help="Stop background viewer"),
    restart: bool = typer.Option(False, help="Restart background viewer"),
) -> None:
    _serve(
        db_path=db_path,
        host=host,
        port=port,
        background=background,
        stop=stop,
        restart=restart,
    )


@app.command()
def dev(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    host: str = typer.Option(DEFAULT_VIEWER_HOST, help="Host to bind viewer"),
    port: int = typer.Option(DEFAULT_VIEWER_PORT, help="Port to bind viewer"),
    ui: bool = typer.Option(True, "--ui/--no-ui", help="Run viewer_ui build watcher"),
) -> None:
    """Developer mode: watch the UI bundle and run the viewer."""

    os.environ["CODEMEM_VIEWER_NO_CACHE"] = "1"

    watcher: subprocess.Popen[Any] | None = None
    try:
        if ui:
            repo_root = Path(__file__).resolve().parent.parent
            viewer_ui = repo_root / "viewer_ui"
            if viewer_ui.exists():
                if not (viewer_ui / "node_modules").exists():
                    subprocess.run(["bun", "install"], cwd=viewer_ui, check=False)
                watcher = subprocess.Popen(
                    ["bun", "run", "build:watch"],
                    cwd=viewer_ui,
                    text=True,
                )

        _serve(
            db_path=db_path,
            host=host,
            port=port,
            background=False,
            stop=False,
            restart=False,
        )
    finally:
        if watcher is not None:
            try:
                watcher.terminate()
            except Exception:
                return


@sync_app.command("enable")
def sync_enable(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    host: str | None = typer.Option(None, help="Host to bind sync server"),
    port: int | None = typer.Option(None, help="Port to bind sync server"),
    interval_s: int | None = typer.Option(None, help="Sync interval in seconds"),
    start: bool = typer.Option(True, "--start/--no-start", help="Start daemon after enabling"),
    advertise: str | None = typer.Option(
        None,
        help="Advertised host for pairing payload ('auto' prefers LAN, then Tailscale)",
    ),
    install: bool | None = typer.Option(
        None,
        "--install/--no-install",
        help="Install autostart (systemd/launchd). On macOS dev, default is no-install.",
    ),
) -> None:
    """Enable sync and initialize device identity."""
    sync_enable_cmd(
        store_from_path=_store,
        read_config_or_exit=_read_config_or_exit,
        write_config_or_exit=_write_config_or_exit,
        get_config_path=get_config_path,
        load_config=load_config,
        ensure_device_identity=ensure_device_identity,
        effective_status=effective_status,
        spawn_daemon=spawn_daemon,
        run_service_action_quiet=_run_service_action_quiet,
        install_autostart_quiet=_install_autostart_quiet,
        db_path=db_path,
        host=host,
        port=port,
        interval_s=interval_s,
        start=start,
        advertise=advertise,
        install=install,
    )


@sync_app.command("disable")
def sync_disable(
    stop: bool = typer.Option(True, "--stop/--no-stop", help="Stop daemon/service after disabling"),
    uninstall: bool = typer.Option(False, help="Remove autostart service configuration"),
) -> None:
    """Disable sync without deleting keys or peers."""
    sync_disable_cmd(
        read_config_or_exit=_read_config_or_exit,
        write_config_or_exit=_write_config_or_exit,
        run_service_action=_run_service_action,
        stop_pidfile_with_reason=stop_pidfile_with_reason,
        sync_uninstall_impl=_sync_uninstall_impl,
        stop=stop,
        uninstall=uninstall,
    )


@sync_app.command("status")
def sync_status(db_path: str = typer.Option(None, help="Path to SQLite database")) -> None:
    """Show sync configuration and peer summary."""
    sync_status_cmd(
        store_from_path=_store,
        load_config=load_config,
        get_config_path=get_config_path,
        effective_status=effective_status,
        db_path=db_path,
    )


@sync_app.command("pair")
def sync_pair(
    accept: str | None = typer.Option(None, help="Accept pairing payload JSON from another device"),
    accept_file: str | None = typer.Option(
        None,
        help="Accept pairing payload from file path, or '-' for stdin (shell-friendly)",
    ),
    payload_only: bool = typer.Option(
        False,
        "--payload-only",
        help="When generating pairing payload, print JSON only (no instructions)",
    ),
    name: str | None = typer.Option(None, help="Label for the peer"),
    address: str | None = typer.Option(None, help="Override peer address (host:port)"),
    include: str | None = typer.Option(
        None,
        help="With --accept, outbound-only allowlist: projects this device may push to that peer",
    ),
    exclude: str | None = typer.Option(
        None,
        help="With --accept, outbound-only blocklist: projects this device will not push to that peer",
    ),
    all_projects: bool = typer.Option(
        False,
        "--all",
        help="With --accept, outbound-only: this device pushes all projects to that peer",
    ),
    default_projects: bool = typer.Option(
        False,
        "--default",
        help="With --accept, outbound-only: use this device's global push filters for that peer",
    ),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
) -> None:
    """Print pairing payload or accept a peer payload."""
    sync_pair_cmd(
        store_from_path=_store,
        ensure_device_identity=ensure_device_identity,
        load_public_key=load_public_key,
        fingerprint_public_key=fingerprint_public_key,
        update_peer_addresses=update_peer_addresses,
        set_peer_project_filter=set_peer_project_filter,
        pick_advertise_hosts=pick_advertise_hosts,
        pick_advertise_host=pick_advertise_host,
        load_config=load_config,
        accept=accept,
        accept_file=accept_file,
        payload_only=payload_only,
        name=name,
        address=address,
        include=include,
        exclude=exclude,
        all_projects=all_projects,
        default_projects=default_projects,
        db_path=db_path,
    )


@sync_peers_app.command("list")
def sync_peers_list(db_path: str = typer.Option(None, help="Path to SQLite database")) -> None:
    """List known sync peers."""
    sync_peers_list_cmd(store_from_path=_store, from_json=db.from_json, db_path=db_path)


@sync_peers_app.command("remove")
def sync_peers_remove(
    peer: str = typer.Argument(..., help="Peer device_id or name"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
) -> None:
    """Remove a peer."""
    sync_peers_remove_cmd(store_from_path=_store, peer=peer, db_path=db_path)


@sync_peers_app.command("rename")
def sync_peers_rename(
    peer_device_id: str = typer.Argument(..., help="Peer device_id"),
    name: str = typer.Argument(..., help="New name"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
) -> None:
    """Rename a peer."""
    sync_peers_rename_cmd(
        store_from_path=_store, peer_device_id=peer_device_id, name=name, db_path=db_path
    )


@sync_app.command("once")
def sync_once_command(
    peer: str | None = typer.Option(None, help="Peer name or device_id"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
) -> None:
    """Run a single sync pass."""
    sync_once_cmd(
        store_from_path=_store,
        sync_pass_preflight=sync_pass_preflight,
        mdns_enabled=mdns_enabled,
        discover_peers_via_mdns=discover_peers_via_mdns,
        run_sync_pass=run_sync_pass,
        peer=peer,
        db_path=db_path,
    )


@sync_app.command("doctor")
def sync_doctor(db_path: str = typer.Option(None, help="Path to SQLite database")) -> None:
    """Diagnose common sync setup and connectivity issues."""
    sync_doctor_cmd(
        store_from_path=_store,
        load_config=load_config,
        mdns_runtime_status=_mdns_runtime_status,
        sync_daemon_running=_sync_daemon_running,
        port_open=_port_open,
        from_json=db.from_json,
        db_path=db_path,
    )


@sync_app.command("repair-legacy-keys")
def sync_repair_legacy_keys(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    limit: int = typer.Option(10000, help="Max rows to inspect"),
    dry_run: bool = typer.Option(False, help="Report changes without writing"),
) -> None:
    """Repair legacy import_key duplication after Phase 2 sync hardening.

    This merges old-format legacy keys (legacy:memory_item:<n>) into the canonical
    device-prefixed form (legacy:<device_id>:memory_item:<n>) and tombstones the old key.
    """

    sync_repair_legacy_keys_cmd(
        store_from_path=_store, db_path=db_path, limit=limit, dry_run=dry_run
    )


@sync_app.command("daemon")
def sync_daemon(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    host: str | None = typer.Option(None, help="Host to bind sync server"),
    port: int | None = typer.Option(None, help="Port to bind sync server"),
    interval_s: int | None = typer.Option(None, help="Sync interval in seconds"),
) -> None:
    """Run the sync daemon loop."""
    sync_daemon_cmd(
        load_config=load_config,
        run_sync_daemon=run_sync_daemon,
        db_path=db_path,
        host=host,
        port=port,
        interval_s=interval_s,
    )


def sync_service_status(
    user: bool = typer.Option(True, help="Use user-level service"),
    system: bool = typer.Option(False, help="Use system-level service"),
    verbose: bool = typer.Option(False, help="Show raw service output"),
) -> None:
    """Show service status for sync daemon."""
    sync_service_status_cmd(
        load_config=load_config,
        effective_status=effective_status,
        verbose=verbose,
        user=user,
        system=system,
    )


def sync_service_start(
    user: bool = typer.Option(True, help="Use user-level service"),
    system: bool = typer.Option(False, help="Use system-level service"),
) -> None:
    """Start sync daemon."""
    sync_service_start_cmd(
        load_config=load_config,
        effective_status=effective_status,
        spawn_daemon=spawn_daemon,
        user=user,
        system=system,
    )


def sync_service_stop(
    user: bool = typer.Option(True, help="Use user-level service"),
    system: bool = typer.Option(False, help="Use system-level service"),
) -> None:
    """Stop sync daemon."""
    sync_service_stop_cmd(
        load_config=load_config,
        effective_status=effective_status,
        stop_pidfile_with_reason=stop_pidfile_with_reason,
        user=user,
        system=system,
    )


def sync_service_restart(
    user: bool = typer.Option(True, help="Use user-level service"),
    system: bool = typer.Option(False, help="Use system-level service"),
) -> None:
    """Restart sync daemon."""
    sync_service_restart_cmd(
        load_config=load_config,
        effective_status=effective_status,
        spawn_daemon=spawn_daemon,
        stop_pidfile_with_reason=stop_pidfile_with_reason,
        user=user,
        system=system,
    )


@sync_app.command("install")
def sync_install(
    user: bool = typer.Option(True, help="Install user-level service (systemd only)"),
    system: bool = typer.Option(False, help="Install system-level service (requires root)"),
) -> None:
    """Install autostart service for sync daemon."""
    sync_install_cmd(user=user, system=system)


@sync_app.command("uninstall")
def sync_uninstall() -> None:
    """Uninstall autostart service configuration."""
    sync_uninstall_cmd(sync_uninstall_impl=_sync_uninstall_impl)


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
    export_memories_cmd(
        store_from_path=_store,
        resolve_project=_resolve_project,
        from_json=db.from_json,
        db_path=db_path,
        output=output,
        project=project,
        all_projects=all_projects,
        include_inactive=include_inactive,
        since=since,
    )


@app.command()
def import_memories(
    input_file: str = typer.Argument(..., help="Input JSON file (use '-' for stdin)"),
    db_path: str = typer.Option(None, help="Path to codemem SQLite database"),
    remap_project: str = typer.Option(None, help="Remap all projects to this path on import"),
    dry_run: bool = typer.Option(False, help="Preview import without writing"),
) -> None:
    """Import memories from an exported JSON file."""
    import_memories_cmd(
        store_from_path=_store,
        build_import_key=_build_import_key,
        merge_summary_metadata=_merge_summary_metadata,
        db_path=db_path,
        input_file=input_file,
        remap_project=remap_project,
        dry_run=dry_run,
    )


@db_app.command("normalize-projects")
def db_normalize_projects(
    db_path: str = typer.Option(None, help="Path to codemem SQLite database"),
    apply: bool = typer.Option(False, help="Apply changes (default is dry-run)"),
) -> None:
    """Normalize project identifiers in the DB.

    This rewrites path-like projects (e.g. "/Users/.../codemem") to their
    basename ("codemem") to avoid machine-specific anchoring.
    """

    normalize_projects_cmd(store_from_path=_store, db_path=db_path, apply=apply)


@db_app.command("rename-project")
def db_rename_project(
    old_name: str = typer.Argument(help="Current project name to rename"),
    new_name: str = typer.Argument(help="New project name"),
    db_path: str = typer.Option(None, help="Path to codemem SQLite database"),
    apply: bool = typer.Option(False, help="Apply changes (default is dry-run)"),
) -> None:
    """Rename a project across all sessions and related tables.

    Matches both exact project names and path-like values whose basename
    matches OLD_NAME (e.g. "/Users/.../product-context" matches "product-context").
    """

    rename_project_cmd(
        store_from_path=_store, db_path=db_path, old_name=old_name, new_name=new_name, apply=apply
    )


@app.command()
def normalize_imported_metadata(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    dry_run: bool = typer.Option(False, help="Preview changes without writing"),
) -> None:
    """Normalize imported session summary metadata for viewer rendering."""
    normalize_imported_metadata_cmd(
        store_from_path=_store,
        from_json=db.from_json,
        to_json=db.to_json,
        merge_summary_metadata=_merge_summary_metadata,
        db_path=db_path,
        dry_run=dry_run,
    )


@app.command()
def install_plugin(
    force: bool = typer.Option(False, "--force", "-f", help="Overwrite existing plugin file"),
) -> None:
    """Install the codemem plugin to OpenCode's plugin directory."""
    install_plugin_cmd(force=force)


@app.command()
def install_mcp(
    force: bool = typer.Option(False, "--force", "-f", help="Overwrite existing MCP config"),
) -> None:
    """Install the codemem MCP entry into OpenCode's config."""
    install_mcp_cmd(force=force)


def main() -> None:
    app()


@app.command("version")
def version() -> None:
    """Print version."""

    print(__version__)
