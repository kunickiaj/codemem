import http.client
import json
import threading
from http.server import HTTPServer
from pathlib import Path

from opencode_mem import db, sync_identity
from opencode_mem.sync_identity import ensure_device_identity
from opencode_mem.viewer import ViewerHandler


def _start_server(db_path: Path) -> tuple[HTTPServer, int]:
    server = HTTPServer(("127.0.0.1", 0), ViewerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, int(server.server_address[1])


def _write_fake_keys(private_key_path: Path, public_key_path: Path) -> None:
    private_key_path.parent.mkdir(parents=True, exist_ok=True)
    private_key_path.write_text("private-key")
    public_key_path.write_text("public-key")


def test_sync_status_endpoint(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    monkeypatch.setenv("OPENCODE_MEM_KEYS_DIR", str(tmp_path / "keys"))
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
        conn.execute(
            "INSERT INTO sync_daemon_state(id, last_error, last_error_at) VALUES (1, ?, ?)",
            ("boom", "2026-01-24T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/status")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload.get("device_id") == "dev-1"
        assert payload.get("peer_count") == 1
        assert payload.get("daemon_last_error") == "boom"
    finally:
        server.shutdown()


def test_sync_peers_list_endpoint(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            """
            INSERT INTO sync_peers(peer_device_id, name, addresses_json, created_at)
            VALUES (?, ?, ?, ?)
            """,
            ("peer-1", "Laptop", json.dumps(["peer.local:7337"]), "2026-01-24T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/peers")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        items = payload.get("items") or []
        assert len(items) == 1
        assert items[0]["name"] == "Laptop"
    finally:
        server.shutdown()


def test_sync_peers_rename(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            "INSERT INTO sync_peers(peer_device_id, addresses_json, created_at) VALUES (?, ?, ?)",
            ("peer-1", "[]", "2026-01-24T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        body = json.dumps({"peer_device_id": "peer-1", "name": "Office"})
        conn.request(
            "POST",
            "/api/sync/peers/rename",
            body=body.encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        assert resp.status == 200
    finally:
        server.shutdown()


def test_sync_rejects_cross_origin(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            "INSERT INTO sync_peers(peer_device_id, addresses_json, created_at) VALUES (?, ?, ?)",
            ("peer-1", "[]", "2026-01-24T00:00:00Z"),
        )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        body = json.dumps({"peer_device_id": "peer-1", "name": "Office"})
        conn.request(
            "POST",
            "/api/sync/peers/rename",
            body=body.encode("utf-8"),
            headers={"Content-Type": "application/json", "Origin": "https://evil.invalid"},
        )
        resp = conn.getresponse()
        assert resp.status == 403
    finally:
        server.shutdown()


def test_sync_now_rejects_when_disabled(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    monkeypatch.setattr(
        "opencode_mem.viewer.load_config", lambda: type("Cfg", (), {"sync_enabled": False})()
    )
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request(
            "POST",
            "/api/sync/actions/sync-now",
            body="{}",
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        assert resp.status == 403
    finally:
        server.shutdown()


def test_sync_pairing_payload(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    keys_dir = tmp_path / "keys"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    monkeypatch.setenv("OPENCODE_MEM_KEYS_DIR", str(keys_dir))
    monkeypatch.setattr(sync_identity, "_generate_keypair", _write_fake_keys)
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        ensure_device_identity(conn, keys_dir=keys_dir)
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/pairing")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload.get("device_id")
        assert payload.get("public_key")
    finally:
        server.shutdown()
