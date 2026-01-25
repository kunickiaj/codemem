import http.client
import json
import threading
from http.server import HTTPServer
from pathlib import Path

from opencode_mem import db
from opencode_mem.store import MemoryStore
from opencode_mem.sync_api import build_sync_handler
from opencode_mem.sync_auth import build_auth_headers
from opencode_mem.sync_identity import (
    ensure_device_identity,
    fingerprint_public_key,
    load_public_key,
)


def _start_server(db_path: Path) -> tuple[HTTPServer, int]:
    handler = build_sync_handler(db_path)
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, int(server.server_address[1])


def test_sync_status_endpoint(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        ensure_device_identity(conn, keys_dir=tmp_path / "keys")
    finally:
        conn.close()

    public_key = load_public_key(tmp_path / "keys")
    assert public_key
    fingerprint = fingerprint_public_key(public_key)
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            """
            INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, addresses_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                "local",
                fingerprint,
                public_key,
                "[]",
                "2026-01-24T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        headers = build_auth_headers(
            device_id="local",
            method="GET",
            url="http://127.0.0.1/v1/status",
            body_bytes=b"",
            keys_dir=tmp_path / "keys",
        )
        conn.request("GET", "/v1/status", headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload.get("device_id")
        assert payload.get("fingerprint")
        assert payload.get("protocol_version") == "1"
    finally:
        server.shutdown()


def test_sync_ops_roundtrip(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    store = MemoryStore(db_path)
    try:
        session_id = store.start_session(
            cwd=str(tmp_path),
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project-a",
        )
        store.remember(session_id, kind="note", title="Delta", body_text="Delta body")
        ops, _ = store.load_replication_ops_since(None, limit=10)
    finally:
        store.close()

    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        ensure_device_identity(conn, keys_dir=tmp_path / "keys")
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        public_key = load_public_key(tmp_path / "keys")
        assert public_key
        fingerprint = fingerprint_public_key(public_key)
        conn = db.connect(db_path)
        try:
            db.initialize_schema(conn)
            conn.execute(
                """
                INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, addresses_json, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    "local",
                    fingerprint,
                    public_key,
                    "[]",
                    "2026-01-24T00:00:00Z",
                ),
            )
            conn.commit()
        finally:
            conn.close()

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        headers = build_auth_headers(
            device_id="local",
            method="GET",
            url=f"http://127.0.0.1:{port}/v1/ops?limit=10",
            body_bytes=b"",
            keys_dir=tmp_path / "keys",
        )
        conn.request("GET", "/v1/ops?limit=10", headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert len(payload.get("ops", [])) == len(ops)
        conn.close()

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        body = json.dumps({"ops": ops}).encode("utf-8")
        headers = build_auth_headers(
            device_id="local",
            method="POST",
            url=f"http://127.0.0.1:{port}/v1/ops",
            body_bytes=body,
            keys_dir=tmp_path / "keys",
        )
        headers["Content-Type"] = "application/json"
        conn.request(
            "POST",
            "/v1/ops",
            body=body,
            headers=headers,
        )
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload.get("skipped") == len(ops)
    finally:
        server.shutdown()
