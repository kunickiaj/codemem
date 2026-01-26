from __future__ import annotations

import contextlib
import datetime as dt
import getpass
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import typer
from rich import print

from . import __version__, db
from .config import get_config_path, load_config, read_config_file, write_config_file
from .db import DEFAULT_DB_PATH
from .net import pick_advertise_host, pick_advertise_hosts
from .store import MemoryStore
from .summarizer import Summarizer
from .sync_daemon import run_sync_daemon, run_sync_pass, sync_pass_preflight
from .sync_discovery import (
    discover_peers_via_mdns,
    mdns_enabled,
    update_peer_addresses,
)
from .sync_identity import ensure_device_identity, fingerprint_public_key, load_public_key
from .sync_runtime import effective_status, spawn_daemon, stop_pidfile
from .utils import resolve_project
from .viewer import DEFAULT_VIEWER_HOST, DEFAULT_VIEWER_PORT, start_viewer

app = typer.Typer(help="opencode-mem: persistent memory for OpenCode CLI")
sync_app = typer.Typer(help="Sync opencode-mem between devices")
sync_peers_app = typer.Typer(help="Manage sync peers")
sync_service_app = typer.Typer(help="Manage sync service")
db_app = typer.Typer(help="Database maintenance")
app.add_typer(sync_app, name="sync")
sync_app.add_typer(sync_peers_app, name="peers")
sync_app.add_typer(sync_service_app, name="service", hidden=True)
app.add_typer(db_app, name="db")


@sync_app.command("attempts")
def sync_attempts(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    limit: int = typer.Option(10, help="Number of attempts to show"),
) -> None:
    """Show recent sync attempts."""

    store = _store(db_path)
    try:
        rows = store.conn.execute(
            """
            SELECT peer_device_id, ok, ops_in, ops_out, error, finished_at
            FROM sync_attempts
            ORDER BY finished_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    finally:
        store.close()
    for row in rows:
        status = "ok" if int(row["ok"] or 0) else "error"
        error = str(row["error"] or "")
        suffix = f" | {error}" if error else ""
        print(
            f"{row['peer_device_id']}|{status}|in={int(row['ops_in'] or 0)}|out={int(row['ops_out'] or 0)}|{row['finished_at']}{suffix}"
        )


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


def _mdns_runtime_status(enabled: bool) -> tuple[bool, str]:
    if not enabled:
        return False, "disabled"
    try:
        import zeroconf  # type: ignore[import-not-found]

        version = getattr(zeroconf, "__version__", "unknown")
        return True, f"enabled (zeroconf {version})"
    except Exception:
        return False, "enabled but zeroconf missing"


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


def _read_config_or_exit() -> dict[str, Any]:
    try:
        return read_config_file()
    except ValueError as exc:
        print(f"[red]Invalid config file: {exc}[/red]")
        raise typer.Exit(code=1) from exc


def _write_config_or_exit(data: dict[str, Any]) -> None:
    try:
        write_config_file(data)
    except OSError as exc:
        print(f"[red]Failed to write config: {exc}[/red]")
        raise typer.Exit(code=1) from exc


def _normalize_local_check_host(host: str) -> str:
    if host in {"0.0.0.0", "::", "::0"}:
        return "127.0.0.1"
    return host


def _sync_daemon_running(host: str, port: int) -> bool:
    return effective_status(host, port).running


def _sync_pid_running() -> bool:
    pid = _read_pid(_sync_pid_path())
    return pid is not None and _pid_running(pid)


def _spawn_sync_daemon(host: str, port: int, interval_s: int, db_path: str | None) -> int:
    binary = shutil.which("opencode-mem") or "opencode-mem"
    cmd = [
        binary,
        "sync",
        "daemon",
        "--host",
        host,
        "--port",
        str(port),
        "--interval-s",
        str(interval_s),
    ]
    if db_path:
        cmd.extend(["--db-path", db_path])
    log_path = Path("~/.opencode-mem/sync-daemon.log").expanduser()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("ab") as log:
        proc = subprocess.Popen(
            cmd,
            stdout=log,
            stderr=log,
            start_new_session=True,
            env=os.environ.copy(),
        )
    return int(proc.pid)


def _sync_pid_path() -> Path:
    pid_path = os.environ.get("OPENCODE_MEM_SYNC_PID", "~/.opencode-mem/sync-daemon.pid")
    return Path(os.path.expanduser(pid_path))


def _stop_sync_pid() -> bool:
    pid_path = _sync_pid_path()
    pid = _read_pid(pid_path)
    if pid is None:
        return False
    if not _pid_running(pid):
        _clear_pid(pid_path)
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    for _ in range(30):
        time.sleep(0.1)
        if not _pid_running(pid):
            _clear_pid(pid_path)
            return True
    return False


def _build_service_commands(action: str, install_mode: str) -> list[list[str]]:
    if sys.platform.startswith("darwin"):
        label = "com.opencode-mem.sync"
        if install_mode != "user":
            raise ValueError("system launchctl not supported")
        uid = os.getuid()
        target = f"gui/{uid}/{label}"
        if action == "status":
            return [["launchctl", "print", target]]
        if action == "start":
            return [["launchctl", "kickstart", "-k", target]]
        if action == "stop":
            return [["launchctl", "stop", target]]
        if action == "restart":
            return [["launchctl", "stop", target], ["launchctl", "kickstart", "-k", target]]
        raise ValueError("unknown action")

    if sys.platform.startswith("linux"):
        unit = "opencode-mem-sync.service"
        base = ["systemctl"]
        if install_mode == "user":
            base.append("--user")
        return [[*base, action, unit]]

    raise ValueError("unsupported platform")


def _run_service_action(action: str, *, user: bool, system: bool) -> None:
    if user and system:
        print("[red]Use only one of --user or --system[/red]")
        raise typer.Exit(code=1)
    install_mode = "system" if system else "user"
    try:
        commands = _build_service_commands(action, install_mode)
    except ValueError as exc:
        print(f"[yellow]{exc}[/yellow]")
        raise typer.Exit(code=1) from exc
    for command in commands:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.stdout:
            print(result.stdout.strip())
        if result.stderr:
            print(result.stderr.strip())
        if result.returncode != 0:
            raise typer.Exit(code=result.returncode)


def _service_status_summary(user: bool) -> tuple[bool, str]:
    if sys.platform.startswith("darwin"):
        uid = os.getuid()
        label = "com.opencode-mem.sync"
        target = f"gui/{uid}/{label}"
        result = subprocess.run(
            ["launchctl", "print", target],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return False, "not loaded"
        text = result.stdout
        running = "active count = 1" in text or "state = running" in text
        if "last exit code" in text and "EX_CONFIG" in text:
            return False, "failed (EX_CONFIG; opencode-mem not on PATH for launchd)"
        return running, "running" if running else "loaded (not running)"

    if sys.platform.startswith("linux"):
        base = ["systemctl"]
        if user:
            base.append("--user")
        result = subprocess.run(
            [*base, "is-active", "opencode-mem-sync.service"],
            capture_output=True,
            text=True,
            check=False,
        )
        state = (result.stdout or "").strip() or "unknown"
        if result.returncode != 0:
            if "inactive" in state:
                return False, "inactive"
            if "unknown" in state:
                return False, "not installed"
            return False, state
        return True, state

    return False, "unsupported"


def _effective_sync_status(config: Any) -> tuple[bool, str]:
    service_running, service_summary = _service_status_summary(user=True)
    if service_running:
        return True, f"service ({service_summary})"
    if _sync_pid_running():
        return True, "pidfile"
    if _sync_daemon_running(config.sync_host, config.sync_port):
        return True, "port"
    return False, f"service ({service_summary})"


def _run_service_action_quiet(action: str, *, user: bool, system: bool) -> bool:
    if user and system:
        return False
    install_mode = "system" if system else "user"
    try:
        commands = _build_service_commands(action, install_mode)
    except ValueError:
        return False
    ok = True
    for command in commands:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            ok = False
    return ok


def _install_autostart_quiet(*, user: bool) -> bool:
    if sys.platform.startswith("darwin"):
        if not user:
            return False
        source = Path(__file__).resolve().parent.parent / "docs" / "autostart" / "launchd"
        plist_path = source / "com.opencode-mem.sync.plist"
        dest = Path.home() / "Library" / "LaunchAgents" / "com.opencode-mem.sync.plist"
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(plist_path.read_text())
        except OSError:
            return False
        uid = os.getuid()
        subprocess.run(
            ["launchctl", "load", "-w", str(dest)],
            capture_output=True,
            text=True,
            check=False,
        )
        subprocess.run(
            ["launchctl", "kickstart", "-k", f"gui/{uid}/com.opencode-mem.sync"],
            capture_output=True,
            text=True,
            check=False,
        )
        return True

    if sys.platform.startswith("linux"):
        source = Path(__file__).resolve().parent.parent / "docs" / "autostart" / "systemd"
        unit_path = source / "opencode-mem-sync.service"
        dest = Path.home() / ".config" / "systemd" / "user" / "opencode-mem-sync.service"
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(unit_path.read_text())
        except OSError:
            return False
        subprocess.run(
            ["systemctl", "--user", "daemon-reload"],
            capture_output=True,
            text=True,
            check=False,
        )
        subprocess.run(
            ["systemctl", "--user", "enable", "--now", "opencode-mem-sync.service"],
            capture_output=True,
            text=True,
            check=False,
        )
        return True

    return False


def _sync_uninstall_impl(*, user: bool) -> None:
    if sys.platform.startswith("darwin"):
        if not user:
            return
        dest = Path.home() / "Library" / "LaunchAgents" / "com.opencode-mem.sync.plist"
        uid = os.getuid()
        subprocess.run(
            ["launchctl", "unload", "-w", str(dest)],
            capture_output=True,
            text=True,
            check=False,
        )
        subprocess.run(
            ["launchctl", "remove", f"gui/{uid}/com.opencode-mem.sync"],
            capture_output=True,
            text=True,
            check=False,
        )
        with contextlib.suppress(FileNotFoundError):
            dest.unlink()
        print("[green]Removed launchd sync agent[/green]")
        return

    if sys.platform.startswith("linux"):
        if not user:
            return
        dest = Path.home() / ".config" / "systemd" / "user" / "opencode-mem-sync.service"
        subprocess.run(
            ["systemctl", "--user", "disable", "--now", "opencode-mem-sync.service"],
            capture_output=True,
            text=True,
            check=False,
        )
        subprocess.run(
            ["systemctl", "--user", "daemon-reload"],
            capture_output=True,
            text=True,
            check=False,
        )
        with contextlib.suppress(FileNotFoundError):
            dest.unlink()
        print("[green]Removed systemd user sync service[/green]")


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
    """Create the SQLite database (no-op if it already exists)."""
    store = _store(db_path)
    print(f"Initialized database at {store.db_path}")


@app.command()
def search(
    query: str,
    limit: int = typer.Option(5, help="Max results"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
) -> None:
    """Search memories by keyword or semantic recall."""
    store = _store(db_path)
    resolved_project = _resolve_project(os.getcwd(), project, all_projects=all_projects)
    filters = {"project": resolved_project} if resolved_project else None
    results = store.search(query, limit=limit, filters=filters)
    for item in results:
        print(f"[{item.id}] ({item.kind}) {item.title}\n{item.body_text}\nscore={item.score:.2f}\n")


@app.command()
def recent(
    limit: int = typer.Option(5, help="Max results"),
    kind: str | None = typer.Option(None, help="Filter by kind"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
) -> None:
    """Show recent memories."""
    store = _store(db_path)
    resolved_project = _resolve_project(os.getcwd(), project, all_projects=all_projects)
    filters = {"kind": kind} if kind else {}
    if resolved_project:
        filters["project"] = resolved_project
    results = store.recent(limit=limit, filters=filters or None)
    for item in results:
        print(f"[{item['id']}] ({item['kind']}) {item['title']}\n{item['body_text']}\n")


@app.command()
def show(memory_id: int, db_path: str = typer.Option(None, help="Path to SQLite database")) -> None:
    """Print a memory item as JSON."""
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
    tags: list[str] = typer.Option(None, help="Repeat for multiple tags"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
) -> None:
    """Manually add a memory item."""
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
def forget(
    memory_id: int, db_path: str = typer.Option(None, help="Path to SQLite database")
) -> None:
    """Deactivate a memory item by id."""
    store = _store(db_path)
    store.forget(memory_id)
    print(f"Memory {memory_id} marked inactive")


@db_app.command("prune-observations")
def db_prune_observations(
    limit: int | None = typer.Option(None, help="Max observations to scan (defaults to all)"),
    dry_run: bool = typer.Option(False, help="Report without deactivating"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
) -> None:
    """Deactivate low-signal observations."""
    store = _store(db_path)
    result = store.deactivate_low_signal_observations(limit=limit, dry_run=dry_run)
    action = "Would deactivate" if dry_run else "Deactivated"
    print(f"{action} {result['deactivated']} of {result['checked']} observations")


@app.command("prune-observations", hidden=True)
def prune_observations(
    limit: int | None = typer.Option(None, help="Max observations to scan (defaults to all)"),
    dry_run: bool = typer.Option(False, help="Report without deactivating"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
) -> None:
    db_prune_observations(limit=limit, dry_run=dry_run, db_path=db_path)


@db_app.command("prune-memories")
def db_prune_memories(
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


@app.command("purge", hidden=True)
def purge(
    limit: int | None = typer.Option(None, help="Max memories to scan (defaults to all)"),
    dry_run: bool = typer.Option(False, help="Report without deactivating"),
    kinds: list[str] | None = typer.Option(
        None, help="Memory kinds to purge (defaults to common low-signal kinds)"
    ),
    db_path: str = typer.Option(None),
) -> None:
    db_prune_memories(limit=limit, dry_run=dry_run, kinds=kinds, db_path=db_path)


@app.command()
def pack(
    context: str,
    limit: int = typer.Option(None, help="Max memory items in the pack"),
    token_budget: int = typer.Option(None, help="Approx token budget for pack"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    project: str = typer.Option(None, help="Project identifier (defaults to git repo root)"),
    all_projects: bool = typer.Option(False, help="Search across all projects"),
) -> None:
    """Build a JSON memory pack for a query/context string."""
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
    limit: int = typer.Option(None, help="Max memory items in the pack"),
    token_budget: int = typer.Option(None, help="Approx token budget for injection"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
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
    db_path: str = typer.Option(None, help="Path to SQLite database"),
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


@app.command("backfill-discovery-tokens")
def backfill_discovery_tokens(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    limit_sessions: int = typer.Option(50, help="Max sessions to backfill"),
) -> None:
    """Populate discovery_group/discovery_tokens for existing observer memories."""

    store = _store(db_path)
    updated = store.backfill_discovery_tokens(limit_sessions=limit_sessions)
    print(f"Updated {updated} memories")


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
            f"batches=started:{counts['started']} running:{counts['running']} error:{counts['error']} completed:{counts['completed']} "
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

    from .pack_benchmark import format_benchmark_report, read_queries, run_pack_benchmark, to_json

    store = _store(db_path)
    resolved_project = _resolve_project(os.getcwd(), project, all_projects=all_projects)
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
    print(format_benchmark_report(result))
    if json_out:
        json_out.write_text(to_json(result) + "\n")


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
    update_existing: bool = typer.Option(False, help="Update previously imported rows"),
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
        f"SELECT COUNT(*) as count FROM user_prompts {prompts_count_where}", prompts_params
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
    updated_obs = 0
    updated_summaries = 0

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
                files_modified=json.loads(row["files_modified"]) if row["files_modified"] else None,
                prompt_number=row["prompt_number"],
                confidence=0.7,
                metadata=obs_meta,
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
                files_edited=json.loads(row["files_edited"]) if row["files_edited"] else None,
                prompt_number=row["prompt_number"],
                metadata=summary_meta,
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

    # Import user prompts
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
    if update_existing:
        print(f"- Updated observations: {updated_obs}")
        print(f"- Updated summaries: {updated_summaries}")


@app.command()
def serve(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    host: str = typer.Option(DEFAULT_VIEWER_HOST, help="Host to bind viewer"),
    port: int = typer.Option(DEFAULT_VIEWER_PORT, help="Port to bind viewer"),
    background: bool = typer.Option(False, help="Run viewer in background"),
    stop: bool = typer.Option(False, help="Stop background viewer"),
    restart: bool = typer.Option(False, help="Restart background viewer"),
) -> None:
    """Run the viewer server (foreground or background)."""
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
    store = _store(db_path)
    try:
        device_id, fingerprint = ensure_device_identity(store.conn)
    finally:
        store.close()
    config_data = _read_config_or_exit()
    config = load_config()
    previous_host = str(config_data.get("sync_host") or config.sync_host)
    previous_port = int(config_data.get("sync_port") or config.sync_port)
    previous_interval = int(config_data.get("sync_interval_s") or config.sync_interval_s)

    config_data["sync_enabled"] = True
    config_data["sync_host"] = host or config.sync_host
    config_data["sync_port"] = port or config.sync_port
    config_data["sync_interval_s"] = interval_s or config.sync_interval_s
    if advertise is not None:
        config_data["sync_advertise"] = advertise
    _write_config_or_exit(config_data)
    config_path = get_config_path()
    print("[green]Sync enabled[/green]")
    print(f"- Config: {config_path}")
    print(f"- Device ID: {device_id}")
    print(f"- Fingerprint: {fingerprint}")
    print(f"- Listen: {config_data['sync_host']}:{config_data['sync_port']}")
    if not start:
        print("- Run: opencode-mem sync daemon")
        return

    print("Starting sync daemon...")

    if install is None:
        if sys.platform.startswith("darwin"):
            install = False
        else:
            install = True

    # Prefer service management if available and actually results in a running daemon.
    if install:
        print("- Installing autostart...")
        _install_autostart_quiet(user=True)
        print("- Starting via service...")
        _run_service_action_quiet("restart", user=True, system=False)
        status = effective_status(str(config_data["sync_host"]), int(config_data["sync_port"]))
        if status.running and status.mechanism == "service":
            print("[green]Sync daemon running (service)[/green]")
            return
        if sys.platform.startswith("darwin") and status.detail.startswith("failed (EX_CONFIG"):
            print(
                "[yellow]launchd cannot run opencode-mem in dev mode; using pidfile daemon. Use `sync install` only after installing opencode-mem on PATH.[/yellow]"
            )
        else:
            print("[yellow]Service did not start sync daemon; falling back to pidfile[/yellow]")
    desired_host = str(config_data["sync_host"])
    desired_port = int(config_data["sync_port"])
    desired_interval = int(config_data["sync_interval_s"])
    bind_changed = (previous_host, previous_port, previous_interval) != (
        desired_host,
        desired_port,
        desired_interval,
    )
    status = effective_status(desired_host, desired_port)
    if status.running:
        if bind_changed:
            if _run_service_action_quiet("restart", user=True, system=False):
                status = effective_status(desired_host, desired_port)
                if status.running:
                    print(f"[green]Sync daemon running ({status.mechanism})[/green]")
                    return
            print("[yellow]Sync daemon already running[/yellow]")
            print("Restart required to apply updated bind settings:")
            print("- opencode-mem sync restart")
            print("- or stop/start your foreground daemon")
        else:
            print(f"[yellow]Sync daemon already running ({status.mechanism})[/yellow]")
        return
    pid = spawn_daemon(
        host=desired_host,
        port=desired_port,
        interval_s=desired_interval,
        db_path=db_path,
    )
    status = effective_status(desired_host, desired_port)
    if status.running:
        print(f"[green]Sync daemon running ({status.mechanism})[/green]")
        return
    print(f"[yellow]Started sync daemon (pid {pid}) but it is not running[/yellow]")


@sync_app.command("disable")
def sync_disable(
    stop: bool = typer.Option(True, "--stop/--no-stop", help="Stop daemon/service after disabling"),
    uninstall: bool = typer.Option(False, help="Remove autostart service configuration"),
) -> None:
    """Disable sync without deleting keys or peers."""
    config_data = _read_config_or_exit()
    config_data["sync_enabled"] = False
    _write_config_or_exit(config_data)
    print("[yellow]Sync disabled[/yellow]")
    if not stop:
        if uninstall:
            _sync_uninstall_impl(user=True)
        return
    try:
        _run_service_action("stop", user=True, system=False)
        print("[green]Sync daemon stopped[/green]")
    except typer.Exit:
        if _stop_sync_pid():
            print("[green]Sync daemon stopped[/green]")
            if uninstall:
                _sync_uninstall_impl(user=True)
            return
        print("Stop the daemon to apply disable:")
        print("- opencode-mem sync service stop")
        print("- or stop your foreground `opencode-mem sync daemon`")
        if uninstall:
            _sync_uninstall_impl(user=True)


@sync_app.command("status")
def sync_status(db_path: str = typer.Option(None, help="Path to SQLite database")) -> None:
    """Show sync configuration and peer summary."""
    config = load_config()
    store = _store(db_path)
    try:
        row = store.conn.execute(
            "SELECT device_id, fingerprint FROM sync_device LIMIT 1"
        ).fetchone()
        peers = store.conn.execute(
            "SELECT peer_device_id, name, last_sync_at, last_error FROM sync_peers"
        ).fetchall()
    finally:
        store.close()
    config_path = get_config_path()
    print(f"- Enabled: {config.sync_enabled}")
    print(f"- Config: {config_path}")
    print(f"- Listen: {config.sync_host}:{config.sync_port}")
    print(f"- Interval: {config.sync_interval_s}s")
    running = _sync_daemon_running(config.sync_host, config.sync_port)
    if running:
        print("- Daemon: running")
    else:
        print("- Daemon: not running (run `opencode-mem sync daemon` or `opencode-mem sync start`)")
    if row is None:
        print("- Device ID: (not initialized)")
    else:
        print(f"- Device ID: {row['device_id']}")
        print(f"- Fingerprint: {row['fingerprint']}")
    if not peers:
        print("- Peers: none")
    else:
        print(f"- Peers: {len(peers)}")
        for peer in peers:
            label = peer["name"] or peer["peer_device_id"]
            last_error = peer["last_error"] or "ok"
            last_sync = peer["last_sync_at"] or "never"
            print(f"  - {label}: last_sync={last_sync}, status={last_error}")


@sync_app.command("pair")
def sync_pair(
    accept: str | None = typer.Option(None, help="Accept pairing payload (JSON)"),
    name: str | None = typer.Option(None, help="Label for the peer"),
    address: str | None = typer.Option(None, help="Override peer address (host:port)"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
) -> None:
    """Print pairing payload or accept a peer payload."""
    store = _store(db_path)
    try:
        if accept:
            try:
                payload = json.loads(accept)
            except json.JSONDecodeError as exc:
                print(f"[red]Invalid pairing payload: {exc}[/red]")
                raise typer.Exit(code=1) from exc
            device_id = str(payload.get("device_id") or "")
            fingerprint = str(payload.get("fingerprint") or "")
            public_key = str(payload.get("public_key") or "")
            resolved_addresses: list[str] = []
            if address and address.strip():
                resolved_addresses = [address.strip()]
            else:
                raw_addresses = payload.get("addresses")
                if isinstance(raw_addresses, list):
                    resolved_addresses = [
                        str(item).strip()
                        for item in raw_addresses
                        if isinstance(item, str) and str(item).strip()
                    ]
                if not resolved_addresses:
                    fallback_address = str(payload.get("address") or "").strip()
                    if fallback_address:
                        resolved_addresses = [fallback_address]
            if not device_id or not fingerprint or not public_key or not resolved_addresses:
                print(
                    "[red]Pairing payload missing device_id, fingerprint, public_key, or addresses[/red]"
                )
                raise typer.Exit(code=1)
            if fingerprint_public_key(public_key) != fingerprint:
                print("[red]Pairing payload fingerprint mismatch[/red]")
                raise typer.Exit(code=1)
            update_peer_addresses(
                store.conn,
                device_id,
                resolved_addresses,
                name=name,
                pinned_fingerprint=fingerprint,
                public_key=public_key,
            )
            print(f"[green]Paired with {device_id}[/green]")
            return

        device_id, fingerprint = ensure_device_identity(store.conn)
        public_key = load_public_key()
        if not public_key:
            print("[red]Public key missing[/red]")
            raise typer.Exit(code=1)
        config = load_config()
        if address and address.strip().lower() in {"auto", "default"}:
            address = None
        if address and address.strip():
            addresses = [address.strip()]
        else:
            hosts = pick_advertise_hosts(config.sync_advertise)
            if not hosts:
                advertise_host = pick_advertise_host(config.sync_advertise)
                hosts = [advertise_host] if advertise_host else []
            if not hosts:
                hosts = [config.sync_host]
            addresses = [
                f"{host}:{config.sync_port}"
                for host in hosts
                if host and host.strip() and host != "0.0.0.0"
            ]
            if not addresses and config.sync_host and config.sync_host != "0.0.0.0":
                addresses = [f"{config.sync_host}:{config.sync_port}"]
        primary_address = addresses[0] if addresses else ""
        payload = {
            "device_id": device_id,
            "fingerprint": fingerprint,
            "public_key": public_key,
            "address": primary_address,
            "addresses": addresses,
        }
        payload_text = json.dumps(payload, ensure_ascii=False)
        escaped = payload_text.replace("'", "'\\''")
        print("[bold]Pairing payload[/bold]")
        print(payload_text)
        print("Share this with your other device and run:")
        print(f"  opencode-mem sync pair --accept '{escaped}'")
    finally:
        store.close()


@sync_peers_app.command("list")
def sync_peers_list(db_path: str = typer.Option(None, help="Path to SQLite database")) -> None:
    """List known sync peers."""
    store = _store(db_path)
    try:
        rows = store.conn.execute(
            """
            SELECT peer_device_id, name, last_sync_at, last_error, addresses_json
            FROM sync_peers
            ORDER BY name, peer_device_id
            """
        ).fetchall()
    finally:
        store.close()
    if not rows:
        print("[yellow]No sync peers found[/yellow]")
        return
    for row in rows:
        addresses = db.from_json(row["addresses_json"]) if row["addresses_json"] else []
        label = row["name"] or row["peer_device_id"]
        last_sync = row["last_sync_at"] or "never"
        status = row["last_error"] or "ok"
        address_text = ", ".join(addresses) if addresses else "(no addresses)"
        print(
            f"- {label} ({row['peer_device_id']}): {address_text} | last_sync={last_sync} | {status}"
        )


@sync_peers_app.command("remove")
def sync_peers_remove(
    peer: str = typer.Argument(..., help="Peer device_id or name"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
) -> None:
    """Remove a peer."""
    store = _store(db_path)
    try:
        rows = store.conn.execute(
            "SELECT peer_device_id FROM sync_peers WHERE peer_device_id = ? OR name = ?",
            (peer, peer),
        ).fetchall()
        if not rows:
            print("[yellow]Peer not found[/yellow]")
            raise typer.Exit(code=1)
        for row in rows:
            store.conn.execute(
                "DELETE FROM sync_peers WHERE peer_device_id = ?",
                (row["peer_device_id"],),
            )
        store.conn.commit()
    finally:
        store.close()
    print(f"[green]Removed {len(rows)} peer(s)[/green]")


@sync_peers_app.command("rename")
def sync_peers_rename(
    peer_device_id: str = typer.Argument(..., help="Peer device_id"),
    name: str = typer.Argument(..., help="New name"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
) -> None:
    """Rename a peer."""
    store = _store(db_path)
    try:
        row = store.conn.execute(
            "SELECT 1 FROM sync_peers WHERE peer_device_id = ?",
            (peer_device_id,),
        ).fetchone()
        if row is None:
            print("[yellow]Peer not found[/yellow]")
            raise typer.Exit(code=1)
        store.conn.execute(
            "UPDATE sync_peers SET name = ? WHERE peer_device_id = ?",
            (name, peer_device_id),
        )
        store.conn.commit()
    finally:
        store.close()
    print(f"[green]Renamed peer {peer_device_id}[/green]")


@sync_app.command("once")
def sync_once_command(
    peer: str | None = typer.Option(None, help="Peer name or device_id"),
    db_path: str = typer.Option(None, help="Path to SQLite database"),
) -> None:
    """Run a single sync pass."""
    store = _store(db_path)
    try:
        sync_pass_preflight(store)
        mdns_entries = discover_peers_via_mdns() if mdns_enabled() else []
        if peer:
            rows = store.conn.execute(
                """
                SELECT peer_device_id
                FROM sync_peers
                WHERE peer_device_id = ? OR name = ?
                """,
                (peer, peer),
            ).fetchall()
        else:
            rows = store.conn.execute("SELECT peer_device_id FROM sync_peers").fetchall()
        if not rows:
            print("[yellow]No peers available for sync[/yellow]")
            raise typer.Exit(code=1)
        for row in rows:
            peer_device_id = str(row["peer_device_id"])
            result = run_sync_pass(store, peer_device_id, mdns_entries=mdns_entries)
            if result.get("ok"):
                print(f"- {row['peer_device_id']}: ok")
            else:
                error = result.get("error")
                suffix = f": {error}" if isinstance(error, str) and error else ""
                print(f"- {row['peer_device_id']}: error{suffix}")
    finally:
        store.close()


@sync_app.command("doctor")
def sync_doctor(db_path: str = typer.Option(None, help="Path to SQLite database")) -> None:
    """Diagnose common sync setup and connectivity issues."""
    config = load_config()
    print("[bold]Sync doctor[/bold]")
    print(f"- Enabled: {config.sync_enabled}")
    print(f"- Listen: {config.sync_host}:{config.sync_port}")
    mdns_ok, mdns_detail = _mdns_runtime_status(bool(getattr(config, "sync_mdns", True)))
    print(f"- mDNS: {mdns_detail}")
    include = [p for p in getattr(config, "sync_projects_include", []) if p]
    exclude = [p for p in getattr(config, "sync_projects_exclude", []) if p]
    if include or exclude:
        print(f"- Project filter: include={include or '[]'} exclude={exclude or '[]'}")
    running = _sync_daemon_running(config.sync_host, config.sync_port)
    print(f"- Daemon: {'running' if running else 'not running'}")

    store = _store(db_path)
    try:
        device = store.conn.execute("SELECT device_id FROM sync_device LIMIT 1").fetchone()
        daemon_state = store.get_sync_daemon_state() or {}
        if device is None:
            print("- Identity: missing (run `opencode-mem sync enable`)")
        else:
            print(f"- Identity: {device['device_id']}")

        peers = store.conn.execute(
            "SELECT peer_device_id, addresses_json, pinned_fingerprint, public_key FROM sync_peers"
        ).fetchall()
    finally:
        store.close()

    issues: list[str] = []
    if not config.sync_enabled:
        issues.append("sync is disabled")
    if not running:
        issues.append("daemon not running")
    if daemon_state.get("last_error") and (
        not daemon_state.get("last_ok_at")
        or str(daemon_state.get("last_ok_at")) < str(daemon_state.get("last_error_at"))
    ):
        print(
            f"- Daemon error: {daemon_state.get('last_error')} (at {daemon_state.get('last_error_at')})"
        )
        issues.append("daemon error")
    if getattr(config, "sync_mdns", True) and not mdns_ok:
        issues.append("mDNS enabled but zeroconf missing")
    if device is None:
        issues.append("identity missing")

    if not peers:
        print("- Peers: none (pair a device first)")
        issues.append("no peers")
        if issues:
            print(f"[yellow]WARN: {', '.join(issues)}[/yellow]")
        return
    print(f"- Peers: {len(peers)}")
    for peer in peers:
        addresses = db.from_json(peer["addresses_json"]) if peer["addresses_json"] else []
        addresses = [str(item) for item in addresses if isinstance(item, str)]
        pinned = bool(peer["pinned_fingerprint"])
        has_key = bool(peer["public_key"])
        reach = "unknown"
        if addresses:
            host_port = addresses[0]
            try:
                if "://" in host_port:
                    host_port = host_port.split("://", 1)[1]
                host, port_str = host_port.rsplit(":", 1)
                reach = "ok" if _port_open(host, int(port_str)) else "unreachable"
            except Exception:
                reach = "invalid address"
        print(
            f"  - {peer['peer_device_id']}: addresses={len(addresses)} reach={reach} pinned={pinned} public_key={has_key}"
        )
        if reach != "ok":
            issues.append(f"peer {peer['peer_device_id']} unreachable")
        if not pinned or not has_key:
            issues.append(f"peer {peer['peer_device_id']} not pinned")

    if issues:
        unique = list(dict.fromkeys(issues))
        print(f"[yellow]WARN: {', '.join(unique[:3])}[/yellow]")
    else:
        print("[green]OK: sync looks healthy[/green]")


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

    store = _store(db_path)
    try:
        result = store.repair_legacy_import_keys(limit=limit, dry_run=dry_run)
    finally:
        store.close()
    mode = "dry-run" if dry_run else "applied"
    print(f"Repair legacy keys ({mode})")
    print(
        f"- Checked: {result['checked']} | renamed: {result['renamed']} | merged: {result['merged']} | tombstoned: {result['tombstoned']} | ops: {result['ops']}"
    )


@sync_app.command("daemon")
def sync_daemon(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    host: str | None = typer.Option(None, help="Host to bind sync server"),
    port: int | None = typer.Option(None, help="Port to bind sync server"),
    interval_s: int | None = typer.Option(None, help="Sync interval in seconds"),
) -> None:
    """Run the sync daemon loop."""
    config = load_config()
    if not config.sync_enabled:
        print("[yellow]Sync is disabled (enable via `opencode-mem sync enable`).[/yellow]")
        raise typer.Exit(code=1)
    run_sync_daemon(
        host=host or config.sync_host,
        port=port or config.sync_port,
        interval_s=interval_s or config.sync_interval_s,
        db_path=Path(db_path) if db_path else None,
    )


@sync_service_app.command("status")
def sync_service_status(
    user: bool = typer.Option(True, help="Use user-level service"),
    system: bool = typer.Option(False, help="Use system-level service"),
    verbose: bool = typer.Option(False, help="Show raw service output"),
) -> None:
    """Show service status for sync daemon."""
    config = load_config()
    status = effective_status(config.sync_host, config.sync_port)
    label = "running" if status.running else "not running"
    extra = f" pid={status.pid}" if status.pid else ""
    print(f"- Sync: {label} ({status.mechanism}; {status.detail}{extra})")
    if not verbose:
        return
    _run_service_action("status", user=user, system=system)


@sync_service_app.command("start")
def sync_service_start(
    user: bool = typer.Option(True, help="Use user-level service"),
    system: bool = typer.Option(False, help="Use system-level service"),
) -> None:
    """Start sync daemon service."""
    config = load_config()
    if not config.sync_enabled:
        print("[yellow]Sync is disabled (run `opencode-mem sync enable`).[/yellow]")
        raise typer.Exit(code=1)
    if _run_service_action_quiet("start", user=user, system=system):
        status = effective_status(config.sync_host, config.sync_port)
        if status.running:
            print("[green]Started sync service[/green]")
            return
    status = effective_status(config.sync_host, config.sync_port)
    if status.running:
        print("[yellow]Sync already running[/yellow]")
        return
    pid = spawn_daemon(
        host=config.sync_host,
        port=config.sync_port,
        interval_s=config.sync_interval_s,
        db_path=None,
    )
    print(f"[green]Started sync daemon (pid {pid})[/green]")


@sync_service_app.command("stop")
def sync_service_stop(
    user: bool = typer.Option(True, help="Use user-level service"),
    system: bool = typer.Option(False, help="Use system-level service"),
) -> None:
    """Stop sync daemon service."""
    try:
        _run_service_action("stop", user=user, system=system)
        print("[green]Stopped sync service[/green]")
        return
    except typer.Exit:
        if stop_pidfile():
            print("[green]Stopped sync daemon (pidfile)[/green]")
            return
        status = effective_status(load_config().sync_host, load_config().sync_port)
        if not status.running:
            print("[yellow]Sync already stopped[/yellow]")
            return
        raise


@sync_service_app.command("restart")
def sync_service_restart(
    user: bool = typer.Option(True, help="Use user-level service"),
    system: bool = typer.Option(False, help="Use system-level service"),
) -> None:
    """Restart sync daemon service."""
    if _run_service_action_quiet("restart", user=user, system=system):
        status = effective_status(load_config().sync_host, load_config().sync_port)
        if status.running:
            print("[green]Restarted sync service[/green]")
            return
    sync_service_stop(user=user, system=system)
    sync_service_start(user=user, system=system)


@sync_app.command("install")
def sync_install(
    user: bool = typer.Option(True, help="Install user-level service (systemd only)"),
    system: bool = typer.Option(False, help="Install system-level service (requires root)"),
) -> None:
    """Install autostart service for sync daemon."""
    if system and user:
        print("[red]Use only one of --user or --system[/red]")
        raise typer.Exit(code=1)
    install_mode = "system" if system else "user"
    if sys.platform.startswith("darwin"):
        source = Path(__file__).resolve().parent.parent / "docs" / "autostart" / "launchd"
        plist_path = source / "com.opencode-mem.sync.plist"
        dest = Path.home() / "Library" / "LaunchAgents" / "com.opencode-mem.sync.plist"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(plist_path.read_text())
        print(f"[green]Installed LaunchAgent at {dest}[/green]")
        print("Run: launchctl load -w ~/Library/LaunchAgents/com.opencode-mem.sync.plist")
        return

    if not sys.platform.startswith("linux"):
        print("[yellow]Autostart install is only supported on macOS and Linux[/yellow]")
        raise typer.Exit(code=1)

    source = Path(__file__).resolve().parent.parent / "docs" / "autostart" / "systemd"
    unit_path = source / "opencode-mem-sync.service"
    if install_mode == "system":
        dest = Path("/etc/systemd/system/opencode-mem-sync.service")
        dest.write_text(unit_path.read_text())
        print(f"[green]Installed system service at {dest}[/green]")
        print("Run: systemctl enable --now opencode-mem-sync.service")
        return
    dest = Path.home() / ".config" / "systemd" / "user" / "opencode-mem-sync.service"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(unit_path.read_text())
    print(f"[green]Installed user service at {dest}[/green]")
    print("Run: systemctl --user enable --now opencode-mem-sync.service")


@sync_app.command("uninstall")
def sync_uninstall() -> None:
    """Uninstall autostart service configuration."""
    _sync_uninstall_impl(user=True)


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
        if (not remap_project) and isinstance(project, str) and ("/" in project or "\\" in project):
            project = project.replace("\\", "/").rstrip("/").split("/")[-1]

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
            metadata = _merge_summary_metadata(base_metadata, import_metadata)

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
                tags=mem_data.get("tags_text", "").split() if mem_data.get("tags_text") else None,
                metadata=metadata,
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
        if (not remap_project) and isinstance(project, str) and ("/" in project or "\\" in project):
            project = project.replace("\\", "/").rstrip("/").split("/")[-1]
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


@db_app.command("normalize-projects")
def db_normalize_projects(
    db_path: str = typer.Option(None, help="Path to opencode-mem SQLite database"),
    apply: bool = typer.Option(False, help="Apply changes (default is dry-run)"),
) -> None:
    """Normalize project identifiers in the DB.

    This rewrites path-like projects (e.g. "/Users/.../opencode-mem") to their
    basename ("opencode-mem") to avoid machine-specific anchoring.
    """

    store = _store(db_path)
    preview = store.normalize_projects(dry_run=not apply)
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


@app.command("normalize-projects", hidden=True)
def normalize_projects(
    db_path: str = typer.Option(None, help="Path to opencode-mem SQLite database"),
    apply: bool = typer.Option(False, help="Apply changes (default is dry-run)"),
) -> None:
    db_normalize_projects(db_path=db_path, apply=apply)


@app.command()
def normalize_imported_metadata(
    db_path: str = typer.Option(None, help="Path to SQLite database"),
    dry_run: bool = typer.Option(False, help="Preview changes without writing"),
) -> None:
    """Normalize imported session summary metadata for viewer rendering."""
    store = _store(db_path)
    rows = store.conn.execute(
        "SELECT id, metadata_json FROM memory_items WHERE kind = 'session_summary'"
    ).fetchall()
    updated = 0
    now = dt.datetime.now(dt.UTC).isoformat()
    for row in rows:
        metadata = db.from_json(row["metadata_json"])
        if not isinstance(metadata, dict):
            metadata = {}
        import_metadata = metadata.get("import_metadata")
        merged = _merge_summary_metadata(metadata, import_metadata)
        if merged == metadata:
            continue
        updated += 1
        if dry_run:
            continue
        store.conn.execute(
            "UPDATE memory_items SET metadata_json = ?, updated_at = ? WHERE id = ?",
            (db.to_json(merged), now, row["id"]),
        )
    if not dry_run:
        store.conn.commit()
    print(f"[green]✓ Updated {updated} session summaries[/green]")
    if dry_run:
        print("[yellow]Dry run - no data was updated[/yellow]")


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


@app.command("version")
def version() -> None:
    """Print version."""

    print(__version__)
