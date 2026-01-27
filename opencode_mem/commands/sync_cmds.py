from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import typer
from rich import print


def sync_attempts_cmd(*, store_from_path, db_path: str | None, limit: int) -> None:
    """Show recent sync attempts."""

    store = store_from_path(db_path)
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


def sync_enable_cmd(
    *,
    store_from_path,
    read_config_or_exit,
    write_config_or_exit,
    get_config_path,
    load_config,
    ensure_device_identity,
    effective_status,
    spawn_daemon,
    run_service_action_quiet,
    install_autostart_quiet,
    db_path: str | None,
    host: str | None,
    port: int | None,
    interval_s: int | None,
    start: bool,
    advertise: str | None,
    install: bool | None,
) -> None:
    """Enable sync and initialize device identity."""

    store = store_from_path(db_path)
    try:
        device_id, fingerprint = ensure_device_identity(store.conn)
    finally:
        store.close()

    config_data = read_config_or_exit()
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
    write_config_or_exit(config_data)
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
        install_autostart_quiet(user=True)
        print("- Starting via service...")
        run_service_action_quiet("restart", user=True, system=False)
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
            if run_service_action_quiet("restart", user=True, system=False):
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


def sync_disable_cmd(
    *,
    read_config_or_exit,
    write_config_or_exit,
    run_service_action,
    stop_pidfile,
    sync_uninstall_impl,
    stop: bool,
    uninstall: bool,
) -> None:
    """Disable sync without deleting keys or peers."""

    config_data = read_config_or_exit()
    config_data["sync_enabled"] = False
    write_config_or_exit(config_data)
    print("[yellow]Sync disabled[/yellow]")
    if not stop:
        if uninstall:
            sync_uninstall_impl(user=True)
        return
    try:
        run_service_action("stop", user=True, system=False)
        print("[green]Sync daemon stopped[/green]")
    except typer.Exit:
        if stop_pidfile():
            print("[green]Sync daemon stopped[/green]")
            if uninstall:
                sync_uninstall_impl(user=True)
            return
        print("Stop the daemon to apply disable:")
        print("- opencode-mem sync stop")
        print("- or stop your foreground `opencode-mem sync daemon`")
        if uninstall:
            sync_uninstall_impl(user=True)


def sync_status_cmd(
    *,
    store_from_path,
    load_config,
    get_config_path,
    effective_status,
    db_path: str | None,
) -> None:
    """Show sync configuration and peer summary."""

    config = load_config()
    store = store_from_path(db_path)
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
    daemon_status = effective_status(config.sync_host, config.sync_port)
    if daemon_status.running:
        extra = f" pid={daemon_status.pid}" if daemon_status.pid else ""
        print(f"- Daemon: running ({daemon_status.mechanism}{extra})")
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


def sync_pair_cmd(
    *,
    store_from_path,
    ensure_device_identity,
    load_public_key,
    fingerprint_public_key,
    update_peer_addresses,
    set_peer_project_filter,
    pick_advertise_hosts,
    pick_advertise_host,
    load_config,
    accept: str | None,
    name: str | None,
    address: str | None,
    include: str | None,
    exclude: str | None,
    all_projects: bool,
    default_projects: bool,
    db_path: str | None,
) -> None:
    """Print pairing payload or accept a peer payload."""

    def _parse_projects(value: str | None) -> list[str]:
        if not value:
            return []
        return [p.strip() for p in value.split(",") if p.strip()]

    store = store_from_path(db_path)
    try:
        if not accept and (include or exclude or all_projects or default_projects):
            print("[red]Project filters can only be set when accepting a payload[/red]")
            raise typer.Exit(code=1)
        if accept:
            if all_projects and default_projects:
                print("[red]Use only one of --all or --default[/red]")
                raise typer.Exit(code=1)
            if (all_projects or default_projects) and (include or exclude):
                print("[red]--include/--exclude cannot be combined with --all/--default[/red]")
                raise typer.Exit(code=1)

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

            if default_projects:
                set_peer_project_filter(
                    store.conn,
                    device_id,
                    include=None,
                    exclude=None,
                )
            elif all_projects or include or exclude:
                set_peer_project_filter(
                    store.conn,
                    device_id,
                    include=[] if all_projects else _parse_projects(include),
                    exclude=[] if all_projects else _parse_projects(exclude),
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


def sync_peers_list_cmd(*, store_from_path, from_json, db_path: str | None) -> None:
    """List known sync peers."""

    store = store_from_path(db_path)
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
        addresses = from_json(row["addresses_json"]) if row["addresses_json"] else []
        label = row["name"] or row["peer_device_id"]
        last_sync = row["last_sync_at"] or "never"
        status = row["last_error"] or "ok"
        address_text = ", ".join(addresses) if addresses else "(no addresses)"
        print(
            f"- {label} ({row['peer_device_id']}): {address_text} | last_sync={last_sync} | {status}"
        )


def sync_peers_remove_cmd(*, store_from_path, peer: str, db_path: str | None) -> None:
    """Remove a peer."""

    store = store_from_path(db_path)
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


def sync_peers_rename_cmd(
    *, store_from_path, peer_device_id: str, name: str, db_path: str | None
) -> None:
    """Rename a peer."""

    store = store_from_path(db_path)
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


def sync_once_cmd(
    *,
    store_from_path,
    sync_pass_preflight,
    mdns_enabled,
    discover_peers_via_mdns,
    run_sync_pass,
    peer: str | None,
    db_path: str | None,
) -> None:
    """Run a single sync pass."""

    store = store_from_path(db_path)
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


def sync_doctor_cmd(
    *,
    store_from_path,
    load_config,
    mdns_runtime_status,
    sync_daemon_running,
    port_open,
    from_json,
    db_path: str | None,
) -> None:
    """Diagnose common sync setup and connectivity issues."""

    config = load_config()
    print("[bold]Sync doctor[/bold]")
    print(f"- Enabled: {config.sync_enabled}")
    print(f"- Listen: {config.sync_host}:{config.sync_port}")
    mdns_ok, mdns_detail = mdns_runtime_status(bool(getattr(config, "sync_mdns", True)))
    print(f"- mDNS: {mdns_detail}")
    include = [p for p in getattr(config, "sync_projects_include", []) if p]
    exclude = [p for p in getattr(config, "sync_projects_exclude", []) if p]
    if include or exclude:
        print(f"- Project filter: include={include or '[]'} exclude={exclude or '[]'}")
    running = sync_daemon_running(config.sync_host, config.sync_port)
    print(f"- Daemon: {'running' if running else 'not running'}")

    store = store_from_path(db_path)
    unknown_project_ops = 0
    blocked_outbound: dict[str, dict[str, Any]] = {}
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
        if include:
            unknown_project_ops = store.count_replication_ops_missing_project()

        if include or exclude:
            for peer_row in peers:
                peer_device_id = str(peer_row["peer_device_id"])
                cursor_row = store.conn.execute(
                    "SELECT last_acked_cursor FROM replication_cursors WHERE peer_device_id = ?",
                    (peer_device_id,),
                ).fetchone()
                last_acked = str(cursor_row["last_acked_cursor"]) if cursor_row else None
                effective_last_acked = store.normalize_outbound_cursor(
                    last_acked, device_id=store.device_id
                )
                outbound_ops, _cursor = store.load_replication_ops_since(
                    effective_last_acked,
                    limit=200,
                    device_id=store.device_id,
                )
                _allowed, _next, blocked = store.filter_replication_ops_for_sync_with_status(
                    outbound_ops, peer_device_id=peer_device_id
                )
                if blocked is not None:
                    blocked_outbound[peer_device_id] = blocked
    finally:
        store.close()

    issues: list[str] = []

    if include and unknown_project_ops:
        print(
            f"- Unknown project ops: {unknown_project_ops} (memory_item ops missing project; include-filter cannot classify them)"
        )
        issues.append("unknown project ops")

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
    for peer_row in peers:
        addresses = from_json(peer_row["addresses_json"]) if peer_row["addresses_json"] else []
        addresses = [str(item) for item in addresses if isinstance(item, str)]
        pinned = bool(peer_row["pinned_fingerprint"])
        has_key = bool(peer_row["public_key"])
        reach = "unknown"
        if addresses:
            host_port = addresses[0]
            try:
                if "://" in host_port:
                    host_port = host_port.split("://", 1)[1]
                host, port_str = host_port.rsplit(":", 1)
                reach = "ok" if port_open(host, int(port_str)) else "unreachable"
            except Exception:
                reach = "invalid address"
        blocked = blocked_outbound.get(str(peer_row["peer_device_id"]))
        blocked_suffix = ""
        if blocked is not None:
            project_value = blocked.get("project")
            project_label = (
                project_value if isinstance(project_value, str) and project_value else "(missing)"
            )
            blocked_suffix = f" outbound_blocked={blocked.get('op_id')} project={project_label}"
        print(
            f"  - {peer_row['peer_device_id']}: addresses={len(addresses)} reach={reach} pinned={pinned} public_key={has_key}{blocked_suffix}"
        )
        if blocked is not None:
            issues.append(f"peer {peer_row['peer_device_id']} outbound blocked")
        if reach != "ok":
            issues.append(f"peer {peer_row['peer_device_id']} unreachable")
        if not pinned or not has_key:
            issues.append(f"peer {peer_row['peer_device_id']} not pinned")

    if issues:
        unique = list(dict.fromkeys(issues))
        print(f"[yellow]WARN: {', '.join(unique[:3])}[/yellow]")
    else:
        print("[green]OK: sync looks healthy[/green]")


def sync_repair_legacy_keys_cmd(
    *, store_from_path, db_path: str | None, limit: int, dry_run: bool
) -> None:
    """Repair legacy import_key duplication after Phase 2 sync hardening."""

    store = store_from_path(db_path)
    try:
        result = store.repair_legacy_import_keys(limit=limit, dry_run=dry_run)
    finally:
        store.close()
    mode = "dry-run" if dry_run else "applied"
    print(f"Repair legacy keys ({mode})")
    print(
        f"- Checked: {result['checked']} | renamed: {result['renamed']} | merged: {result['merged']} | tombstoned: {result['tombstoned']} | ops: {result['ops']}"
    )


def sync_daemon_cmd(
    *,
    load_config,
    run_sync_daemon,
    db_path: str | None,
    host: str | None,
    port: int | None,
    interval_s: int | None,
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


def sync_install_cmd(*, user: bool, system: bool) -> None:
    """Install autostart service for sync daemon."""

    if system and user:
        print("[red]Use only one of --user or --system[/red]")
        raise typer.Exit(code=1)
    install_mode = "system" if system else "user"
    repo_root = Path(__file__).resolve().parent.parent.parent
    if sys.platform.startswith("darwin"):
        source = repo_root / "docs" / "autostart" / "launchd"
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

    source = repo_root / "docs" / "autostart" / "systemd"
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


def sync_uninstall_cmd(*, sync_uninstall_impl) -> None:
    """Uninstall autostart service configuration."""

    sync_uninstall_impl(user=True)
