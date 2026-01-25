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
