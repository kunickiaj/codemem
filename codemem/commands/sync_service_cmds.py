from __future__ import annotations

import contextlib
import os
import subprocess
import sys
from pathlib import Path

import typer
from rich import print


def _build_service_commands(action: str, install_mode: str) -> list[list[str]]:
    if sys.platform.startswith("darwin"):
        label = "com.codemem.sync"
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
            return [
                ["launchctl", "stop", target],
                ["launchctl", "kickstart", "-k", target],
            ]
        raise ValueError("unknown action")

    if sys.platform.startswith("linux"):
        unit = "codemem-sync.service"
        base = ["systemctl"]
        if install_mode == "user":
            base.append("--user")
        return [[*base, action, unit]]

    raise ValueError("unsupported platform")


def run_service_action(action: str, *, user: bool, system: bool) -> None:
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


def run_service_action_quiet(action: str, *, user: bool, system: bool) -> bool:
    if user and system:
        return False
    install_mode = "system" if system else "user"
    try:
        commands = _build_service_commands(action, install_mode)
    except ValueError:
        return False
    ok = True
    for command in commands:
        if not _run_subprocess_quiet(command):
            ok = False
    return ok


def _run_subprocess_quiet(command: list[str]) -> bool:
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError:
        return False
    return result.returncode == 0


def install_autostart_quiet(*, user: bool) -> bool:
    repo_root = Path(__file__).resolve().parents[2]
    if sys.platform.startswith("darwin"):
        if not user:
            return False
        source = repo_root / "docs" / "autostart" / "launchd"
        plist_path = source / "com.codemem.sync.plist"
        dest = Path.home() / "Library" / "LaunchAgents" / "com.codemem.sync.plist"
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(plist_path.read_text())
        except OSError:
            return False
        uid = os.getuid()
        load_ok = _run_subprocess_quiet(["launchctl", "load", "-w", str(dest)])
        kickstart_ok = _run_subprocess_quiet(
            ["launchctl", "kickstart", "-k", f"gui/{uid}/com.codemem.sync"]
        )
        return load_ok and kickstart_ok

    if sys.platform.startswith("linux"):
        source = repo_root / "docs" / "autostart" / "systemd"
        unit_path = source / "codemem-sync.service"
        dest = Path.home() / ".config" / "systemd" / "user" / "codemem-sync.service"
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(unit_path.read_text())
        except OSError:
            return False
        reload_ok = _run_subprocess_quiet(["systemctl", "--user", "daemon-reload"])
        enable_ok = _run_subprocess_quiet(
            ["systemctl", "--user", "enable", "--now", "codemem-sync.service"]
        )
        return reload_ok and enable_ok

    return False


def sync_uninstall_impl(*, user: bool) -> None:
    if sys.platform.startswith("darwin"):
        if not user:
            return
        dest = Path.home() / "Library" / "LaunchAgents" / "com.codemem.sync.plist"
        uid = os.getuid()
        subprocess.run(
            ["launchctl", "unload", "-w", str(dest)],
            capture_output=True,
            text=True,
            check=False,
        )
        subprocess.run(
            ["launchctl", "remove", f"gui/{uid}/com.codemem.sync"],
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
        dest = Path.home() / ".config" / "systemd" / "user" / "codemem-sync.service"
        subprocess.run(
            ["systemctl", "--user", "disable", "--now", "codemem-sync.service"],
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
        print("[green]Removed systemd user sync autostart[/green]")


def sync_service_status_cmd(
    *, load_config, effective_status, verbose: bool, user: bool, system: bool
) -> None:
    config = load_config()
    status = effective_status(config.sync_host, config.sync_port)
    label = "running" if status.running else "not running"
    extra = f" pid={status.pid}" if status.pid else ""
    print(f"- Sync: {label} ({status.mechanism}; {status.detail}{extra})")
    if not verbose:
        return
    run_service_action("status", user=user, system=system)


def sync_service_start_cmd(
    *, load_config, effective_status, spawn_daemon, user: bool, system: bool
) -> None:
    config = load_config()
    if not config.sync_enabled:
        print("[yellow]Sync is disabled (run `codemem sync enable`).[/yellow]")
        raise typer.Exit(code=1)
    if run_service_action_quiet("start", user=user, system=system):
        status = effective_status(config.sync_host, config.sync_port)
        if status.running:
            print("[green]Started sync daemon[/green]")
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


def sync_service_stop_cmd(
    *,
    load_config,
    effective_status,
    stop_pidfile,
    user: bool,
    system: bool,
) -> None:
    try:
        run_service_action("stop", user=user, system=system)
        print("[green]Stopped sync daemon[/green]")
        return
    except typer.Exit:
        if stop_pidfile():
            print("[green]Stopped sync daemon (pidfile)[/green]")
            return
        cfg = load_config()
        status = effective_status(cfg.sync_host, cfg.sync_port)
        if not status.running:
            print("[yellow]Sync already stopped[/yellow]")
            return
        raise


def sync_service_restart_cmd(
    *,
    load_config,
    effective_status,
    spawn_daemon,
    stop_pidfile,
    user: bool,
    system: bool,
) -> None:
    if run_service_action_quiet("restart", user=user, system=system):
        cfg = load_config()
        status = effective_status(cfg.sync_host, cfg.sync_port)
        if status.running:
            print("[green]Restarted sync daemon[/green]")
            return
    sync_service_stop_cmd(
        load_config=load_config,
        effective_status=effective_status,
        stop_pidfile=stop_pidfile,
        user=user,
        system=system,
    )
    sync_service_start_cmd(
        load_config=load_config,
        effective_status=effective_status,
        spawn_daemon=spawn_daemon,
        user=user,
        system=system,
    )
