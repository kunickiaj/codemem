import http.client
import json
import threading
from http.server import HTTPServer
from pathlib import Path

from opencode_mem import db
from opencode_mem.sync_api import MAX_SYNC_BODY_BYTES, build_sync_handler
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


def _seed_local_peer(db_path: Path, keys_dir: Path) -> None:
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        ensure_device_identity(conn, keys_dir=keys_dir)
        public_key = load_public_key(keys_dir)
        assert public_key
        fingerprint = fingerprint_public_key(public_key)
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


def test_sync_ops_rejects_large_body(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("opencode_mem.sync_api.MAX_SYNC_BODY_BYTES", 64)
    db_path = tmp_path / "mem.sqlite"
    keys_dir = tmp_path / "keys"
    _seed_local_peer(db_path, keys_dir)

    server, port = _start_server(db_path)
    try:
        body = b"{" + b"a" * 128 + b"}"
        headers = build_auth_headers(
            device_id="local",
            method="POST",
            url=f"http://127.0.0.1:{port}/v1/ops",
            body_bytes=body,
            keys_dir=keys_dir,
        )
        headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("POST", "/v1/ops", body=body, headers=headers)
        resp = conn.getresponse()
        assert resp.status == 413
    finally:
        server.shutdown()
