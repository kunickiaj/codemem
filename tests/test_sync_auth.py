import http.client
import json
import threading
from http.server import HTTPServer
from pathlib import Path

from codemem import db
from codemem.sync_api import build_sync_handler
from codemem.sync_auth import build_auth_headers
from codemem.sync_identity import (
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


def test_auth_rejects_unknown_peer(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        ensure_device_identity(conn, keys_dir=tmp_path / "keys")
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        headers = build_auth_headers(
            device_id="unknown",
            method="GET",
            url=f"http://127.0.0.1:{port}/v1/status",
            body_bytes=b"",
            keys_dir=tmp_path / "keys",
        )
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/v1/status", headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 401
        assert payload == {"error": "unauthorized"}
    finally:
        server.shutdown()


def test_auth_accepts_valid_signature(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        ensure_device_identity(conn, keys_dir=tmp_path / "keys")
        public_key = load_public_key(tmp_path / "keys")
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

    server, port = _start_server(db_path)
    try:
        headers = build_auth_headers(
            device_id="local",
            method="GET",
            url=f"http://127.0.0.1:{port}/v1/status",
            body_bytes=b"",
            keys_dir=tmp_path / "keys",
        )
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/v1/status", headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload.get("device_id")
    finally:
        server.shutdown()


def test_auth_rejects_replay(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        ensure_device_identity(conn, keys_dir=tmp_path / "keys")
        public_key = load_public_key(tmp_path / "keys")
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

    server, port = _start_server(db_path)
    try:
        headers = build_auth_headers(
            device_id="local",
            method="GET",
            url=f"http://127.0.0.1:{port}/v1/status",
            body_bytes=b"",
            keys_dir=tmp_path / "keys",
            nonce="deadbeef",
        )
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/v1/status", headers=headers)
        resp = conn.getresponse()
        assert resp.status == 200
        conn.close()

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/v1/status", headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 401
        assert payload == {"error": "unauthorized"}
    finally:
        server.shutdown()


def test_auth_rejects_fingerprint_mismatch(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        ensure_device_identity(conn, keys_dir=tmp_path / "keys")
        public_key = load_public_key(tmp_path / "keys")
        assert public_key
        conn.execute(
            """
            INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, addresses_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                "local",
                "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
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
        headers = build_auth_headers(
            device_id="local",
            method="GET",
            url=f"http://127.0.0.1:{port}/v1/status",
            body_bytes=b"",
            keys_dir=tmp_path / "keys",
        )
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/v1/status", headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 401
        assert payload == {"error": "unauthorized"}
    finally:
        server.shutdown()
