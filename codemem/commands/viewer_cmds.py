from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import typer
from rich import print

from codemem.viewer import start_viewer


def _viewer_pid_path() -> Path:
    pid_path = os.environ.get("CODEMEM_VIEWER_PID", "~/.codemem-viewer.pid")
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


def serve(
    *,
    db_path: str | None,
    host: str,
    port: int,
    background: bool,
    stop: bool,
    restart: bool,
) -> None:
    """Run the viewer server (foreground or background)."""

    if stop and restart:
        print("[red]Use only one of --stop or --restart[/red]")
        raise typer.Exit(code=1)

    if db_path:
        os.environ["CODEMEM_DB"] = db_path
    pid_path = _viewer_pid_path()

    if stop or restart:
        pid = _read_pid(pid_path)
        port_pid = _pid_for_port(port) if _port_open(host, port) else None
        if pid is not None and port_pid is not None and pid != port_pid:
            print(
                f"[yellow]Viewer PID file mismatch (file {pid}, port {port_pid}); using port pid[/yellow]"
            )
            pid = port_pid
        if pid is None and port_pid is not None:
            pid = port_pid
            print(f"[yellow]Found viewer pid {pid} by port scan[/yellow]")
        if pid is None:
            if _port_open(host, port):
                print("[yellow]Viewer is running but no PID file was found[/yellow]")
            else:
                print("[yellow]No background viewer found[/yellow]")
        elif not _pid_running(pid):
            _clear_pid(pid_path)
            print("[yellow]Removed stale viewer PID file[/yellow]")
        elif not _port_open(host, port):
            _clear_pid(pid_path)
            print("[yellow]Removed stale viewer PID file (port not listening)[/yellow]")
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
        if pid is not None:
            if _pid_running(pid) and _port_open(host, port):
                print(f"[yellow]Viewer already running (pid {pid})[/yellow]")
                return
            _clear_pid(pid_path)
        if _port_open(host, port):
            print(f"[yellow]Viewer already running at http://{host}:{port}[/yellow]")
            return
        cmd = [
            sys.executable,
            "-m",
            "codemem.cli",
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
