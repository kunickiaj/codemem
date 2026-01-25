import json
import os
from pathlib import Path

from typer.testing import CliRunner

from opencode_mem import db, sync_identity
from opencode_mem.cli import app

runner = CliRunner()


def _write_fake_keys(private_key_path: Path, public_key_path: Path) -> None:
    private_key_path.parent.mkdir(parents=True, exist_ok=True)
    private_key_path.write_text("private-key")
    public_key_path.write_text("public-key")
    os.chmod(private_key_path, 0o600)


def test_sync_enable_writes_config(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sync_identity, "_generate_keypair", _write_fake_keys)
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    env = {"OPENCODE_MEM_CONFIG": str(config_path)}

    class DummyProc:
        pid = 12345

    monkeypatch.setattr("opencode_mem.cli._sync_daemon_running", lambda host, port: False)
    monkeypatch.setattr("opencode_mem.cli.subprocess.Popen", lambda *a, **k: DummyProc())

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
        ],
        env=env,
    )
    assert result.exit_code == 0
    data = json.loads(config_path.read_text())
    assert data["sync_enabled"] is True
    assert data["sync_host"] == "0.0.0.0"
    assert data["sync_port"] == 7337
    assert data["sync_interval_s"] == 60

    conn = db.connect(db_path)
    try:
        row = conn.execute("SELECT device_id FROM sync_device LIMIT 1").fetchone()
        assert row is not None
    finally:
        conn.close()


def test_sync_enable_no_start(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(sync_identity, "_generate_keypair", _write_fake_keys)
    monkeypatch.setattr(
        "opencode_mem.cli.subprocess.Popen", lambda *a, **k: (_ for _ in ()).throw(Exception("no"))
    )
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    env = {"OPENCODE_MEM_CONFIG": str(config_path)}
    result = runner.invoke(
        app,
        ["sync", "enable", "--db-path", str(db_path), "--no-start"],
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
    env = {"OPENCODE_MEM_CONFIG": str(config_path)}

    monkeypatch.setattr("opencode_mem.cli._sync_daemon_running", lambda host, port: True)
    called = {"restart": 0}

    def fake_run_service(action: str, *, user: bool, system: bool) -> None:
        assert action == "restart"
        called["restart"] += 1

    monkeypatch.setattr("opencode_mem.cli._run_service_action", fake_run_service)
    result = runner.invoke(
        app,
        ["sync", "enable", "--db-path", str(db_path), "--host", "0.0.0.0"],
        env=env,
    )
    assert result.exit_code == 0
    assert called["restart"] == 1


def test_sync_pair_accept_stores_peer(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    env = {"OPENCODE_MEM_CONFIG": str(config_path)}
    public_key = "public-key"
    payload = {
        "device_id": "peer-1",
        "fingerprint": sync_identity.fingerprint_public_key(public_key),
        "public_key": public_key,
        "address": "peer:7337",
    }
    result = runner.invoke(
        app,
        ["sync", "pair", "--accept", json.dumps(payload), "--db-path", str(db_path)],
        env=env,
    )
    assert result.exit_code == 0

    conn = db.connect(db_path)
    try:
        row = conn.execute(
            "SELECT peer_device_id, pinned_fingerprint, public_key FROM sync_peers LIMIT 1"
        ).fetchone()
        assert row is not None
        assert row["peer_device_id"] == "peer-1"
        assert row["pinned_fingerprint"] == payload["fingerprint"]
        assert row["public_key"] == public_key
    finally:
        conn.close()


def test_sync_peers_list(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "mem.sqlite"
    env = {"OPENCODE_MEM_CONFIG": str(config_path)}
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


def test_sync_service_status_linux_user(monkeypatch) -> None:
    calls = []

    def fake_run(command, capture_output, text, check):
        calls.append(command)

        class Result:
            returncode = 0
            stdout = "ok"
            stderr = ""

        return Result()

    monkeypatch.setattr("opencode_mem.cli.sys.platform", "linux")
    monkeypatch.setattr("opencode_mem.cli.subprocess.run", fake_run)
    result = runner.invoke(app, ["sync", "service", "status"])
    assert result.exit_code == 0
    assert calls == [["systemctl", "--user", "status", "opencode-mem-sync.service"]]


def test_sync_daemon_requires_enabled(monkeypatch) -> None:
    monkeypatch.setattr(
        "opencode_mem.cli.load_config", lambda: type("Cfg", (), {"sync_enabled": False})()
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
    monkeypatch.setattr("opencode_mem.cli._sync_daemon_running", lambda host, port: False)
    monkeypatch.setattr("opencode_mem.cli._port_open", lambda host, port: False)
    result = runner.invoke(app, ["sync", "doctor", "--db-path", str(db_path)])
    assert result.exit_code == 0
