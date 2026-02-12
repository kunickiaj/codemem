import http.client
import json
import threading
from http.server import HTTPServer
from pathlib import Path

from codemem import db
from codemem.store import MemoryStore
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
    monkeypatch.setattr("codemem.sync_api.MAX_SYNC_BODY_BYTES", 64)
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


def test_sync_ops_rejects_identity_mismatch(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    keys_dir = tmp_path / "keys"
    _seed_local_peer(db_path, keys_dir)

    op = {
        "op_id": "op-1",
        "entity_type": "memory_item",
        "entity_id": "k1",
        "op_type": "upsert",
        "payload": {},
        "clock": {"rev": 1, "updated_at": "2026-01-01T00:00:00Z", "device_id": "local"},
        "device_id": "evil",
        "created_at": "2026-01-01T00:00:00Z",
    }
    body = json.dumps({"ops": [op]}).encode("utf-8")

    server, port = _start_server(db_path)
    try:
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
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 400
        assert payload.get("error") == "identity_mismatch"
    finally:
        server.shutdown()

    store = MemoryStore(db_path)
    try:
        row = store.conn.execute(
            "SELECT COUNT(*) AS count FROM replication_ops WHERE op_id = ?",
            ("op-1",),
        ).fetchone()
        assert row is not None
        assert int(row["count"]) == 0
    finally:
        store.close()


def test_sync_ops_rejects_invalid_timestamp(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    keys_dir = tmp_path / "keys"
    _seed_local_peer(db_path, keys_dir)

    op = {
        "op_id": "op-1",
        "entity_type": "memory_item",
        "entity_id": "k1",
        "op_type": "upsert",
        "payload": {},
        "clock": {"rev": 1, "updated_at": "2026-01-01T00:00:00Z", "device_id": "local"},
        "device_id": "local",
        "created_at": "not-a-timestamp",
    }
    body = json.dumps({"ops": [op]}).encode("utf-8")

    server, port = _start_server(db_path)
    try:
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
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 400
        assert payload.get("error") == "invalid_timestamp"
    finally:
        server.shutdown()


def test_sync_ops_canonicalizes_old_legacy_import_key(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    keys_dir = tmp_path / "keys"
    _seed_local_peer(db_path, keys_dir)

    op = {
        "op_id": "op-1",
        "entity_type": "memory_item",
        "entity_id": "legacy:memory_item:1",
        "op_type": "upsert",
        "payload": {
            "import_key": "legacy:memory_item:1",
            "session_id": 1,
            "project": "project-a",
            "kind": "note",
            "title": "T",
            "body_text": "B",
            "confidence": 0.5,
            "active": 1,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            "metadata_json": {},
        },
        "clock": {"rev": 1, "updated_at": "2026-01-01T00:00:00Z", "device_id": "local"},
        "device_id": "local",
        "created_at": "2026-01-01T00:00:00Z",
    }
    body = json.dumps({"ops": [op]}).encode("utf-8")

    server, port = _start_server(db_path)
    try:
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
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload.get("inserted") == 1
    finally:
        server.shutdown()

    store = MemoryStore(db_path)
    try:
        row = store.conn.execute(
            "SELECT import_key FROM memory_items WHERE title = ?",
            ("T",),
        ).fetchone()
        assert row is not None
        assert row["import_key"] == "legacy:local:memory_item:1"

        op_row = store.conn.execute(
            "SELECT entity_id FROM replication_ops WHERE op_id = ?",
            ("op-1",),
        ).fetchone()
        assert op_row is not None
        assert op_row["entity_id"] == "legacy:local:memory_item:1"
    finally:
        store.close()


def test_sync_auth_401_hides_internal_reason_by_default(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    keys_dir = tmp_path / "keys"
    _seed_local_peer(db_path, keys_dir)

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/v1/status", headers={})
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 401
        assert payload == {"error": "unauthorized"}
    finally:
        server.shutdown()


def test_sync_auth_401_includes_reason_code_when_diagnostics_enabled(
    monkeypatch, tmp_path: Path
) -> None:
    db_path = tmp_path / "mem.sqlite"
    keys_dir = tmp_path / "keys"
    _seed_local_peer(db_path, keys_dir)
    monkeypatch.setenv("CODEMEM_SYNC_AUTH_DIAGNOSTICS", "1")

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/v1/status", headers={})
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 401
        assert payload == {"error": "unauthorized", "reason": "missing_headers"}
    finally:
        server.shutdown()
