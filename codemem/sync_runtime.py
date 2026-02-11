from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SyncRuntimeStatus:
    running: bool
    mechanism: str
    detail: str
    pid: int | None = None


def _pid_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


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


def _write_pid(pid_path: Path, pid: int) -> None:
    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text(f"{pid}\n")


def _clear_pid(pid_path: Path) -> None:
    try:
        pid_path.unlink()
    except FileNotFoundError:
        return


def _sync_pid_path() -> Path:
    pid_path = os.environ.get("CODEMEM_SYNC_PID", "~/.codemem/sync-daemon.pid")
    return Path(os.path.expanduser(pid_path))


def _port_open(host: str, port: int) -> bool:
    try:
        infos = socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except OSError:
        return False
    for family, socktype, proto, _canon, address in infos:
        try:
            with socket.socket(family, socktype, proto) as sock:
                sock.settimeout(0.2)
                if sock.connect_ex(address) == 0:
                    return True
        except OSError:
            continue
    return False


def _normalize_check_host(host: str) -> str:
    if host in {"0.0.0.0", "::", "::0"}:
        return "127.0.0.1"
    return host


def _pid_command(pid: int) -> str | None:
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "command="],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    command = (result.stdout or "").strip()
    if not command:
        return None
    return command


def _is_sync_daemon_command(command: str) -> bool:
    normalized = command.lower()
    return "sync" in normalized and "daemon" in normalized


def _pid_is_sync_daemon(pid: int) -> bool:
    command = _pid_command(pid)
    if not command:
        return False
    return _is_sync_daemon_command(command)


def service_status_macos() -> SyncRuntimeStatus:
    uid = os.getuid()
    label = "com.codemem.sync"
    target = f"gui/{uid}/{label}"
    result = subprocess.run(
        ["launchctl", "print", target],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return SyncRuntimeStatus(False, "service", "not loaded")
    text = result.stdout
    running = "active count = 1" in text or "state = running" in text
    if "last exit code" in text and "EX_CONFIG" in text:
        return SyncRuntimeStatus(False, "service", "failed (EX_CONFIG)")
    return SyncRuntimeStatus(running, "service", "running" if running else "loaded")


def service_status_linux(user: bool) -> SyncRuntimeStatus:
    base = ["systemctl"]
    if user:
        base.append("--user")
    result = subprocess.run(
        [*base, "is-active", "codemem-sync.service"],
        capture_output=True,
        text=True,
        check=False,
    )
    state = (result.stdout or "").strip() or "unknown"
    return SyncRuntimeStatus(result.returncode == 0, "service", state)


def effective_status(host: str, port: int) -> SyncRuntimeStatus:
    if sys.platform.startswith("darwin"):
        svc = service_status_macos()
        if svc.running:
            return svc
    elif sys.platform.startswith("linux"):
        svc = service_status_linux(user=True)
        if svc.running:
            return svc
        system_svc = service_status_linux(user=False)
        if system_svc.running:
            return system_svc
    pid_path = _sync_pid_path()
    pid = _read_pid(pid_path)
    if pid is not None and _pid_running(pid) and _pid_is_sync_daemon(pid):
        return SyncRuntimeStatus(True, "pidfile", "running", pid=pid)
    if _port_open(_normalize_check_host(host), port):
        return SyncRuntimeStatus(True, "port", "listening")
    if sys.platform.startswith("darwin"):
        return SyncRuntimeStatus(False, "service", service_status_macos().detail)
    if sys.platform.startswith("linux"):
        return SyncRuntimeStatus(False, "service", service_status_linux(user=True).detail)
    return SyncRuntimeStatus(False, "none", "unsupported")


def spawn_daemon(host: str, port: int, interval_s: int, db_path: str | None) -> int:
    binary = os.environ.get("CODEMEM_SYNC_BIN") or "codemem"
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
    log_path = Path("~/.codemem/sync-daemon.log").expanduser()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("ab") as log:
        proc = subprocess.Popen(
            cmd,
            stdout=log,
            stderr=log,
            start_new_session=True,
            env=os.environ.copy(),
        )
    pid = int(proc.pid)
    _write_pid(_sync_pid_path(), pid)
    return pid


def stop_pidfile() -> bool:
    pid_path = _sync_pid_path()
    pid = _read_pid(pid_path)
    if pid is None:
        return False
    if not _pid_running(pid):
        _clear_pid(pid_path)
        return False
    if not _pid_is_sync_daemon(pid):
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
