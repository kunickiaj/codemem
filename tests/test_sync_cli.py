import json
import os
from pathlib import Path

import typer
from typer.testing import CliRunner

from codemem import db, sync_identity
from codemem.cli import app

runner = CliRunner()


def _write_fake_keys(private_key_path: Path, public_key_path: Path) -> None:
    private_key_path.parent.mkdir(parents=True, exist_ok=True)
    private_key_path.write_text("private-key")
    public_key_path.write_text("public-key")
    os.chmod(private_key_path, 0o600)


def _write_fake_keys_by_dir(private_key_path: Path, public_key_path: Path) -> None:
    private_key_path.parent.mkdir(parents=True, exist_ok=True)
    suffix = private_key_path.parent.name
    private_key_path.write_text(f"private-{suffix}")
    public_key_path.write_text(f"public-{suffix}")
    os.chmod(private_key_path, 0o600)


def test_sync_enable_writes_config(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sync_identity, "_generate_keypair", _write_fake_keys)
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    env = {"CODEMEM_CONFIG": str(config_path)}

    monkeypatch.setattr("codemem.cli_app._sync_daemon_running", lambda host, port: False)
    monkeypatch.setattr("codemem.cli_app.spawn_daemon", lambda *a, **k: 12345)
    monkeypatch.setattr(
        "codemem.cli_app.effective_status",
        lambda host, port: type(
            "S", (), {"running": True, "mechanism": "pidfile", "detail": "running", "pid": 12345}
        )(),
    )

    result = runner.invoke(
        app,
        [
            "sync",
            "enable",
            "--db-path",
            str(db_path),
            "--host",
            "0.0.0.0",
            "--port",
            "7337",
            "--interval-s",
            "60",
            "--no-install",
        ],
        env=env,
    )
    assert result.exit_code == 0


def test_sync_enable_mac_defaults_no_install(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sync_identity, "_generate_keypair", _write_fake_keys)
    monkeypatch.setattr("codemem.commands.sync_cmds.sys.platform", "darwin")
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    env = {"CODEMEM_CONFIG": str(config_path)}
    monkeypatch.setattr("codemem.cli_app.spawn_daemon", lambda *a, **k: 123)
    monkeypatch.setattr(
        "codemem.cli_app.effective_status",
        lambda host, port: type(
            "S", (), {"running": True, "mechanism": "pidfile", "detail": "running", "pid": 123}
        )(),
    )
    result = runner.invoke(app, ["sync", "enable", "--db-path", str(db_path)], env=env)
    assert result.exit_code == 0
    assert "falling back" not in result.stdout
    data = json.loads(config_path.read_text())
    assert data["sync_enabled"] is True
    assert data["sync_host"] == "0.0.0.0"
    assert data["sync_port"] == 7337
    assert data["sync_interval_s"] == 120

    conn = db.connect(db_path)
    try:
        row = conn.execute("SELECT device_id FROM sync_device LIMIT 1").fetchone()
        assert row is not None
    finally:
        conn.close()


def test_sync_enable_no_start(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sync_identity, "_generate_keypair", _write_fake_keys)
    monkeypatch.setattr(
        "codemem.cli_app.spawn_daemon",
        lambda *a, **k: (_ for _ in ()).throw(Exception("no")),
    )
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    env = {"CODEMEM_CONFIG": str(config_path)}
    result = runner.invoke(
        app,
        ["sync", "enable", "--db-path", str(db_path), "--no-start", "--no-install"],
        env=env,
    )
    assert result.exit_code == 0


def test_sync_enable_restarts_running_daemon_on_change(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sync_identity, "_generate_keypair", _write_fake_keys)
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    config_path.write_text(
        json.dumps({"sync_host": "127.0.0.1", "sync_port": 7337, "sync_interval_s": 120}) + "\n"
    )
    env = {"CODEMEM_CONFIG": str(config_path)}

    monkeypatch.setattr(
        "codemem.cli_app.effective_status",
        lambda host, port: type(
            "S", (), {"running": True, "mechanism": "pidfile", "detail": "running", "pid": 1}
        )(),
    )
    called = {"restart": 0}

    def fake_run_service(action: str, *, user: bool, system: bool) -> bool:
        assert action == "restart"
        called["restart"] += 1
        return True

    monkeypatch.setattr("codemem.cli_app._run_service_action_quiet", fake_run_service)
    result = runner.invoke(
        app,
        ["sync", "enable", "--db-path", str(db_path), "--host", "0.0.0.0", "--no-install"],
        env=env,
    )
    assert result.exit_code == 0
    assert called["restart"] == 1


def test_sync_disable_stops_service(monkeypatch, tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"sync_enabled": True}) + "\n")
    env = {"CODEMEM_CONFIG": str(config_path)}
    called = {"stop": 0}

    def fake_run_service(action: str, *, user: bool, system: bool) -> None:
        assert action == "stop"
        called["stop"] += 1

    monkeypatch.setattr("codemem.cli_app._run_service_action", fake_run_service)
    result = runner.invoke(app, ["sync", "disable"], env=env)
    assert result.exit_code == 0
    assert called["stop"] == 1


def test_sync_disable_stops_pid_when_no_service(monkeypatch, tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"sync_enabled": True}) + "\n")
    env = {"CODEMEM_CONFIG": str(config_path), "CODEMEM_SYNC_PID": str(tmp_path / "pid")}

    def fake_run_service(action: str, *, user: bool, system: bool) -> None:
        raise typer.Exit(code=1)

    monkeypatch.setattr("codemem.cli_app._run_service_action", fake_run_service)
    monkeypatch.setattr("codemem.cli_app.stop_pidfile", lambda: True)
    result = runner.invoke(app, ["sync", "disable"], env=env)
    assert result.exit_code == 0


def test_sync_pair_accept_stores_peer(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    env = {"CODEMEM_CONFIG": str(config_path)}
    public_key = "public-key"
    payload = {
        "device_id": "peer-1",
        "fingerprint": sync_identity.fingerprint_public_key(public_key),
        "public_key": public_key,
        "address": "peer:7337",
        "addresses": ["peer:7337", "peer.local:7337"],
    }
    result = runner.invoke(
        app,
        [
            "sync",
            "pair",
            "--accept",
            json.dumps(payload),
            "--include",
            "project-a,project-b",
            "--exclude",
            "private-repo",
            "--db-path",
            str(db_path),
        ],
        env=env,
    )
    assert result.exit_code == 0

    conn = db.connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT peer_device_id,
                   pinned_fingerprint,
                   public_key,
                   projects_include_json,
                   projects_exclude_json
            FROM sync_peers
            LIMIT 1
            """
        ).fetchone()
        assert row is not None
        assert row["peer_device_id"] == "peer-1"
        assert row["pinned_fingerprint"] == payload["fingerprint"]
        assert row["public_key"] == public_key
        assert json.loads(row["projects_include_json"]) == ["project-a", "project-b"]
        assert json.loads(row["projects_exclude_json"]) == ["private-repo"]

        stored = conn.execute(
            "SELECT addresses_json FROM sync_peers WHERE peer_device_id = ?",
            ("peer-1",),
        ).fetchone()
        assert stored is not None
        addresses = json.loads(stored["addresses_json"])
        assert "peer:7337" in addresses
    finally:
        conn.close()


def test_sync_pair_accept_file_stores_peer(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    payload_path = tmp_path / "pairing.json"
    env = {"CODEMEM_CONFIG": str(config_path)}
    public_key = "public-key"
    payload = {
        "device_id": "peer-file-1",
        "fingerprint": sync_identity.fingerprint_public_key(public_key),
        "public_key": public_key,
        "address": "peer-file:7337",
        "addresses": ["peer-file:7337"],
    }
    payload_path.write_text(json.dumps(payload), encoding="utf-8")

    result = runner.invoke(
        app,
        [
            "sync",
            "pair",
            "--accept-file",
            str(payload_path),
            "--db-path",
            str(db_path),
        ],
        env=env,
    )
    assert result.exit_code == 0

    conn = db.connect(db_path)
    try:
        row = conn.execute(
            "SELECT peer_device_id, pinned_fingerprint, public_key FROM sync_peers WHERE peer_device_id = ?",
            ("peer-file-1",),
        ).fetchone()
        assert row is not None
        assert row["pinned_fingerprint"] == payload["fingerprint"]
        assert row["public_key"] == payload["public_key"]
    finally:
        conn.close()


def test_sync_pair_prints_copyable_command(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sync_identity, "_generate_keypair", _write_fake_keys)
    monkeypatch.setattr("codemem.cli_app.pick_advertise_hosts", lambda value: ["127.0.0.1"])
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    env = {"CODEMEM_CONFIG": str(config_path)}
    result = runner.invoke(app, ["sync", "pair", "--db-path", str(db_path)], env=env)
    assert result.exit_code == 0
    assert "codemem sync pair --accept" in result.stdout
    normalized = " ".join(result.stdout.split())
    assert "--include/--exclude only control what it sends to peers" in normalized
    assert "does not yet enforce incoming project filters" in normalized
    assert "codemem sync pair --accept-file pairing.json" in result.stdout
    assert "codemem sync pair --payload-only" in result.stdout
    assert '"addresses"' in result.stdout


def test_sync_pair_help_marks_filters_outbound_only() -> None:
    result = runner.invoke(app, ["sync", "pair", "--help"])
    assert result.exit_code == 0
    normalized = " ".join(result.stdout.split())
    assert "outbound-only allowlist" in normalized
    assert "outbound-only blocklist" in normalized
    assert "outbound-only: this device pushes" in normalized
    assert "all projects to that peer" in normalized
    assert "print JSON only" in normalized


def test_sync_pair_accept_file_rejects_empty_file(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    payload_path = tmp_path / "empty-pairing.json"
    payload_path.write_text("", encoding="utf-8")
    env = {"CODEMEM_CONFIG": str(config_path)}

    result = runner.invoke(
        app,
        [
            "sync",
            "pair",
            "--accept-file",
            str(payload_path),
            "--db-path",
            str(db_path),
        ],
        env=env,
    )
    assert result.exit_code == 1
    assert "Empty pairing payload" in result.stdout


def test_sync_pair_accept_file_rejects_empty_stdin(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    env = {"CODEMEM_CONFIG": str(config_path)}

    result = runner.invoke(
        app,
        ["sync", "pair", "--accept-file", "-", "--db-path", str(db_path)],
        env=env,
        input="",
    )
    assert result.exit_code == 1
    assert "Empty pairing payload" in result.stdout


def test_sync_pair_payload_only_prints_json(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sync_identity, "_generate_keypair", _write_fake_keys)
    monkeypatch.setattr("codemem.cli_app.pick_advertise_hosts", lambda value: ["127.0.0.1"])
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    env = {"CODEMEM_CONFIG": str(config_path)}
    result = runner.invoke(
        app,
        ["sync", "pair", "--payload-only", "--db-path", str(db_path)],
        env=env,
    )
    assert result.exit_code == 0
    payload = json.loads(result.stdout.strip())
    assert isinstance(payload.get("device_id"), str)
    assert isinstance(payload.get("public_key"), str)
    assert payload.get("addresses") == ["127.0.0.1:7337"]


def test_sync_pair_uses_keys_dir_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sync_identity, "_generate_keypair", _write_fake_keys_by_dir)
    monkeypatch.setattr("codemem.cli_app.pick_advertise_hosts", lambda value: ["127.0.0.1"])
    monkeypatch.setattr(sync_identity, "DEFAULT_KEYS_DIR", tmp_path / "default-keys")

    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    env = {
        "CODEMEM_CONFIG": str(config_path),
        "CODEMEM_KEYS_DIR": str(tmp_path / "env-keys"),
    }

    result = runner.invoke(app, ["sync", "pair", "--db-path", str(db_path)], env=env)
    assert result.exit_code == 0

    start = result.stdout.find("{")
    assert start >= 0
    depth = 0
    end = -1
    for idx in range(start, len(result.stdout)):
        char = result.stdout[idx]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                end = idx + 1
                break
    assert end > start
    payload = json.loads(result.stdout[start:end])
    assert payload is not None
    assert payload["public_key"] == "public-env-keys"
    assert not (tmp_path / "default-keys" / "device.key.pub").exists()


def test_sync_enable_uses_keys_dir_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sync_identity, "_generate_keypair", _write_fake_keys_by_dir)
    monkeypatch.setattr(sync_identity, "DEFAULT_KEYS_DIR", tmp_path / "default-keys")
    monkeypatch.setattr("codemem.cli_app._sync_daemon_running", lambda host, port: False)
    monkeypatch.setattr("codemem.cli_app.spawn_daemon", lambda *a, **k: 12345)
    monkeypatch.setattr(
        "codemem.cli_app.effective_status",
        lambda host, port: type(
            "S", (), {"running": True, "mechanism": "pidfile", "detail": "running", "pid": 12345}
        )(),
    )

    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    env = {
        "CODEMEM_CONFIG": str(config_path),
        "CODEMEM_KEYS_DIR": str(tmp_path / "env-keys"),
    }

    result = runner.invoke(
        app,
        ["sync", "enable", "--db-path", str(db_path), "--no-install"],
        env=env,
    )
    assert result.exit_code == 0

    conn = db.connect(db_path)
    try:
        row = conn.execute("SELECT public_key FROM sync_device LIMIT 1").fetchone()
        assert row is not None
        assert row["public_key"] == "public-env-keys"
    finally:
        conn.close()
    assert not (tmp_path / "default-keys" / "device.key.pub").exists()


def test_sync_peers_list(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    env = {"CODEMEM_CONFIG": str(config_path)}
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            """
            INSERT INTO sync_peers(peer_device_id, name, addresses_json, created_at)
            VALUES (?, ?, ?, ?)
            """,
            ("peer-2", "Laptop", json.dumps(["peer-2:7337"]), "2026-01-24T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    result = runner.invoke(app, ["sync", "peers", "list", "--db-path", str(db_path)], env=env)
    assert result.exit_code == 0
    assert "Laptop" in result.stdout


def test_sync_uninstall_runs(monkeypatch) -> None:
    monkeypatch.setattr("codemem.cli_app._sync_uninstall_impl", lambda user: None)
    result = runner.invoke(app, ["sync", "uninstall"])
    assert result.exit_code == 0


def test_sync_stop_falls_back_to_pid(monkeypatch) -> None:
    monkeypatch.setattr(
        "codemem.cli_app._run_service_action",
        lambda *a, **k: (_ for _ in ()).throw(typer.Exit(1)),
    )
    monkeypatch.setattr("codemem.cli_app.stop_pidfile", lambda: True)
    result = runner.invoke(app, ["sync", "stop"])
    assert result.exit_code == 0


def test_sync_once_updates_addresses_from_mdns(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            "INSERT INTO sync_peers(peer_device_id, addresses_json, created_at) VALUES (?, ?, ?)",
            ("peer-1", json.dumps(["10.0.0.1:7337"]), "2026-01-24T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setattr("codemem.cli_app.mdns_enabled", lambda: True)
    monkeypatch.setattr(
        "codemem.cli_app.discover_peers_via_mdns",
        lambda: [{"host": "192.168.1.22", "port": 7337, "properties": {"device_id": "peer-1"}}],
    )
    monkeypatch.setattr("codemem.sync.sync_pass.sync_pass_preflight", lambda store: None)
    monkeypatch.setattr(
        "codemem.sync.sync_pass.sync_once",
        lambda store, peer, addresses, **k: {"ok": True},
    )
    result = runner.invoke(app, ["sync", "once", "--db-path", str(db_path)])
    assert result.exit_code == 0

    conn = db.connect(db_path)
    try:
        row = conn.execute(
            "SELECT addresses_json FROM sync_peers WHERE peer_device_id = ?",
            ("peer-1",),
        ).fetchone()
        assert row is not None
        addresses = json.loads(row["addresses_json"])
        assert "192.168.1.22:7337" in addresses
    finally:
        conn.close()


def test_sync_once_runs_preflight(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            "INSERT INTO sync_peers(peer_device_id, addresses_json, created_at) VALUES (?, ?, ?)",
            ("peer-1", json.dumps(["127.0.0.1:7337"]), "2026-01-24T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    called: dict[str, int] = {"legacy": 0, "backfill": 0}

    def fake_legacy(self, *, limit: int = 0):
        called["legacy"] = limit

    def fake_backfill(self, *, limit: int = 0):
        called["backfill"] = limit
        return 0

    monkeypatch.setattr("codemem.store.MemoryStore.migrate_legacy_import_keys", fake_legacy)
    monkeypatch.setattr("codemem.store.MemoryStore.backfill_replication_ops", fake_backfill)
    monkeypatch.setattr("codemem.cli_app.run_sync_pass", lambda store, peer, **k: {"ok": True})
    monkeypatch.setattr("codemem.cli_app.mdns_enabled", lambda: False)

    result = runner.invoke(app, ["sync", "once", "--db-path", str(db_path)])
    assert result.exit_code == 0
    assert called["legacy"] == 2000
    assert called["backfill"] == 200


def test_sync_doctor_reports_mdns_status(monkeypatch, tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    config_path.write_text(
        json.dumps(
            {"sync_enabled": True, "sync_host": "0.0.0.0", "sync_port": 7337, "sync_mdns": True}
        )
        + "\n"
    )
    env = {"CODEMEM_CONFIG": str(config_path)}
    monkeypatch.setattr("codemem.cli_app._sync_daemon_running", lambda host, port: True)
    monkeypatch.setattr(
        "codemem.cli_app._mdns_runtime_status",
        lambda enabled: (False, "enabled but zeroconf missing"),
    )
    result = runner.invoke(app, ["sync", "doctor", "--db-path", str(db_path)], env=env)
    assert result.exit_code == 0
    assert "mDNS:" in result.stdout
    assert "zeroconf" in result.stdout


def test_sync_service_status_uses_pid(monkeypatch) -> None:
    monkeypatch.setattr(
        "codemem.sync_runtime.service_status_macos",
        lambda: type(
            "S",
            (),
            {"running": False, "mechanism": "service", "detail": "failed (EX_CONFIG)", "pid": None},
        )(),
    )
    monkeypatch.setattr("codemem.sync_runtime._read_pid", lambda p: 123)
    monkeypatch.setattr("codemem.sync_runtime._pid_running", lambda pid: True)
    monkeypatch.setattr(
        "codemem.cli_app.load_config",
        lambda: type(
            "Cfg",
            (),
            {
                "sync_enabled": True,
                "sync_host": "127.0.0.1",
                "sync_port": 7337,
                "sync_interval_s": 120,
            },
        )(),
    )
    result = runner.invoke(app, ["sync", "status"])
    assert result.exit_code == 0
    assert "running" in result.stdout
    assert "pidfile" in result.stdout


def test_sync_daemon_requires_enabled(monkeypatch) -> None:
    monkeypatch.setattr(
        "codemem.cli_app.load_config", lambda: type("Cfg", (), {"sync_enabled": False})()
    )
    result = runner.invoke(app, ["sync", "daemon"])
    assert result.exit_code == 1


def test_sync_doctor_runs(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            "INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
            ("dev-1", "pub", "fp", "2026-01-24T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO sync_peers(peer_device_id, addresses_json, created_at) VALUES (?, ?, ?)",
            ("peer-1", "[]", "2026-01-24T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()
    monkeypatch.setattr("codemem.cli_app._sync_daemon_running", lambda host, port: False)
    monkeypatch.setattr("codemem.cli_app._port_open", lambda host, port: False)
    result = runner.invoke(app, ["sync", "doctor", "--db-path", str(db_path)])
    assert result.exit_code == 0


def test_sync_doctor_prints_ok(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            "INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
            ("dev-1", "pub", "fp", "2026-01-24T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO sync_peers(peer_device_id, addresses_json, pinned_fingerprint, public_key, created_at) VALUES (?, ?, ?, ?, ?)",
            ("peer-1", json.dumps(["127.0.0.1:7337"]), "fp", "pub", "2026-01-24T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setattr(
        "codemem.cli_app.load_config",
        lambda: type(
            "Cfg",
            (),
            {
                "sync_enabled": True,
                "sync_host": "127.0.0.1",
                "sync_port": 7337,
                "sync_interval_s": 120,
            },
        )(),
    )
    monkeypatch.setattr("codemem.cli_app._sync_daemon_running", lambda host, port: True)
    monkeypatch.setattr("codemem.cli_app._port_open", lambda host, port: True)
    result = runner.invoke(app, ["sync", "doctor", "--db-path", str(db_path)])
    assert result.exit_code == 0
    assert "OK: sync looks healthy" in result.stdout


def test_sync_doctor_warns_on_unknown_project_ops_when_include_active(
    monkeypatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    config_path.write_text(
        json.dumps(
            {
                "sync_enabled": True,
                "sync_host": "127.0.0.1",
                "sync_port": 7337,
                "sync_projects_include": ["some-project"],
            }
        )
        + "\n"
    )
    env = {"CODEMEM_CONFIG": str(config_path)}

    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            "INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
            ("dev-1", "pub", "fp", "2026-01-24T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO sync_peers(peer_device_id, addresses_json, pinned_fingerprint, public_key, created_at) VALUES (?, ?, ?, ?, ?)",
            (
                "peer-1",
                json.dumps(["127.0.0.1:7337"]),
                "fp",
                "pub",
                "2026-01-24T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO replication_ops(
                op_id, entity_type, entity_id, op_type, payload_json,
                clock_rev, clock_updated_at, clock_device_id, device_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "op-1",
                "memory_item",
                "legacy:dev-1:memory_item:1",
                "upsert",
                json.dumps({"id": 1, "title": "t"}),
                1,
                "2026-01-24T00:00:00Z",
                "dev-1",
                "dev-1",
                "2026-01-24T00:00:01Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setattr("codemem.cli_app._sync_daemon_running", lambda host, port: True)
    monkeypatch.setattr("codemem.cli_app._port_open", lambda host, port: True)

    result = runner.invoke(app, ["sync", "doctor", "--db-path", str(db_path)], env=env)
    assert result.exit_code == 0
    assert "Unknown project ops:" in result.stdout
    assert "Unknown project ops: 1" in result.stdout


def test_sync_doctor_reports_outbound_skipped_ops(monkeypatch, tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    config_path.write_text(
        json.dumps(
            {
                "sync_enabled": True,
                "sync_host": "127.0.0.1",
                "sync_port": 7337,
                "sync_projects_include": ["some-project"],
            }
        )
        + "\n"
    )
    env = {"CODEMEM_CONFIG": str(config_path)}

    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            "INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
            ("dev-1", "pub", "fp", "2026-01-24T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO sync_peers(peer_device_id, addresses_json, pinned_fingerprint, public_key, created_at) VALUES (?, ?, ?, ?, ?)",
            (
                "peer-1",
                json.dumps(["127.0.0.1:7337"]),
                "fp",
                "pub",
                "2026-01-24T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO replication_ops(
                op_id, entity_type, entity_id, op_type, payload_json,
                clock_rev, clock_updated_at, clock_device_id, device_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "op-1",
                "memory_item",
                "k1",
                "upsert",
                json.dumps({"project": "some-project"}),
                1,
                "2026-01-24T00:00:00Z",
                "dev-1",
                "dev-1",
                "2026-01-24T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO replication_ops(
                op_id, entity_type, entity_id, op_type, payload_json,
                clock_rev, clock_updated_at, clock_device_id, device_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "op-2",
                "memory_item",
                "k2",
                "upsert",
                json.dumps({"title": "no project"}),
                1,
                "2026-01-24T00:00:01Z",
                "dev-1",
                "dev-1",
                "2026-01-24T00:00:01Z",
            ),
        )
        conn.execute(
            "INSERT INTO replication_cursors(peer_device_id, last_acked_cursor, updated_at) VALUES (?, ?, ?)",
            ("peer-1", "2026-01-24T00:00:00Z|op-1", "2026-01-24T00:00:02Z"),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setattr("codemem.cli_app._sync_daemon_running", lambda host, port: True)
    monkeypatch.setattr("codemem.cli_app._port_open", lambda host, port: True)

    result = runner.invoke(app, ["sync", "doctor", "--db-path", str(db_path)], env=env)
    assert result.exit_code == 0
    assert "outbound_skipped=1" in result.stdout
