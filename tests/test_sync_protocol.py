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


def test_ops_cursor_paging(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        session_id = store.start_session(
            cwd=str(tmp_path),
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project-a",
        )
        store.remember(session_id, kind="note", title="A", body_text="One")
        store.remember(session_id, kind="note", title="B", body_text="Two")
    finally:
        store.close()

    conn = db.connect(tmp_path / "mem.sqlite")
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

    server, port = _start_server(tmp_path / "mem.sqlite")
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        headers = build_auth_headers(
            device_id="local",
            method="GET",
            url=f"http://127.0.0.1:{port}/v1/ops?limit=1",
            body_bytes=b"",
            keys_dir=tmp_path / "keys",
        )
        conn.request("GET", "/v1/ops?limit=1", headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert len(payload.get("ops", [])) == 1
        cursor = payload.get("next_cursor")
        assert cursor
        conn.close()

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        headers = build_auth_headers(
            device_id="local",
            method="GET",
            url=f"http://127.0.0.1:{port}/v1/ops?limit=1&since={cursor}",
            body_bytes=b"",
            keys_dir=tmp_path / "keys",
        )
        conn.request("GET", f"/v1/ops?limit=1&since={cursor}", headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert len(payload.get("ops", [])) == 1
        assert payload.get("next_cursor")
    finally:
        server.shutdown()


def test_ops_cursor_does_not_advance_past_filtered_ops(tmp_path: Path, monkeypatch) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"sync_projects_include": ["project-a"]}) + "\n")
    monkeypatch.setenv("OPENCODE_MEM_CONFIG", str(config_path))

    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.record_replication_op(
            op_id="op-1",
            entity_type="memory_item",
            entity_id="k1",
            op_type="upsert",
            payload={"project": "project-a"},
            clock={"rev": 1, "updated_at": "2026-01-01T00:00:00Z", "device_id": "local"},
            device_id="local",
            created_at="2026-01-01T00:00:00Z",
        )
        store.record_replication_op(
            op_id="op-2",
            entity_type="memory_item",
            entity_id="k2",
            op_type="upsert",
            payload={"project": "project-a"},
            clock={"rev": 1, "updated_at": "2026-01-01T00:00:01Z", "device_id": "local"},
            device_id="local",
            created_at="2026-01-01T00:00:01Z",
        )
        store.record_replication_op(
            op_id="op-3",
            entity_type="memory_item",
            entity_id="k3",
            op_type="upsert",
            payload={"project": "project-b"},
            clock={"rev": 1, "updated_at": "2026-01-01T00:00:02Z", "device_id": "local"},
            device_id="local",
            created_at="2026-01-01T00:00:02Z",
        )
    finally:
        store.close()

    conn = db.connect(tmp_path / "mem.sqlite")
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

    server, port = _start_server(tmp_path / "mem.sqlite")
    try:
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
        assert [op.get("op_id") for op in payload.get("ops", [])] == ["op-1", "op-2"]
        cursor = payload.get("next_cursor")
        assert cursor == "2026-01-01T00:00:01Z|op-2"
        conn.close()

        config_path.write_text(
            json.dumps({"sync_projects_include": ["project-a", "project-b"]}) + "\n"
        )

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        headers = build_auth_headers(
            device_id="local",
            method="GET",
            url=f"http://127.0.0.1:{port}/v1/ops?limit=10&since={cursor}",
            body_bytes=b"",
            keys_dir=tmp_path / "keys",
        )
        conn.request("GET", f"/v1/ops?limit=10&since={cursor}", headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert [op.get("op_id") for op in payload.get("ops", [])] == ["op-3"]
        assert payload.get("next_cursor") == "2026-01-01T00:00:02Z|op-3"
    finally:
        server.shutdown()


def test_ops_cursor_does_not_advance_for_unknown_project_when_include_set(
    tmp_path: Path, monkeypatch
) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"sync_projects_include": ["project-a"]}) + "\n")
    monkeypatch.setenv("OPENCODE_MEM_CONFIG", str(config_path))

    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.record_replication_op(
            op_id="op-1",
            entity_type="memory_item",
            entity_id="k1",
            op_type="upsert",
            payload={"project": "project-a"},
            clock={"rev": 1, "updated_at": "2026-01-01T00:00:03Z", "device_id": "local"},
            device_id="local",
            created_at="2026-01-01T00:00:00Z",
        )
        store.record_replication_op(
            op_id="op-2",
            entity_type="memory_item",
            entity_id="k2",
            op_type="upsert",
            payload={},
            clock={"rev": 1, "updated_at": "2026-01-01T00:00:04Z", "device_id": "local"},
            device_id="local",
            created_at="2026-01-01T00:00:01Z",
        )
    finally:
        store.close()

    conn = db.connect(tmp_path / "mem.sqlite")
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

    server, port = _start_server(tmp_path / "mem.sqlite")
    try:
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
        assert [op.get("op_id") for op in payload.get("ops", [])] == ["op-1"]
        assert payload.get("next_cursor") == "2026-01-01T00:00:00Z|op-1"
    finally:
        server.shutdown()


def test_ops_endpoint_signals_blocked_head_op_when_filtered(tmp_path: Path, monkeypatch) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"sync_projects_include": ["project-a"]}) + "\n")
    monkeypatch.setenv("OPENCODE_MEM_CONFIG", str(config_path))

    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.record_replication_op(
            op_id="op-1",
            entity_type="memory_item",
            entity_id="k1",
            op_type="upsert",
            payload={"project": "project-a"},
            clock={"rev": 1, "updated_at": "2026-01-01T00:00:00Z", "device_id": "local"},
            device_id="local",
            created_at="2026-01-01T00:00:00Z",
        )
        store.record_replication_op(
            op_id="op-2",
            entity_type="memory_item",
            entity_id="k2",
            op_type="upsert",
            payload={},
            clock={"rev": 1, "updated_at": "2026-01-01T00:00:01Z", "device_id": "local"},
            device_id="local",
            created_at="2026-01-01T00:00:01Z",
        )
    finally:
        store.close()

    conn = db.connect(tmp_path / "mem.sqlite")
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

    server, port = _start_server(tmp_path / "mem.sqlite")
    try:
        cursor = "2026-01-01T00:00:00Z|op-1"
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        headers = build_auth_headers(
            device_id="local",
            method="GET",
            url=f"http://127.0.0.1:{port}/v1/ops?limit=10&since={cursor}",
            body_bytes=b"",
            keys_dir=tmp_path / "keys",
        )
        conn.request("GET", f"/v1/ops?limit=10&since={cursor}", headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload.get("ops") == []
        assert payload.get("next_cursor") is None
        assert payload.get("blocked") is True
        assert payload.get("blocked_reason") == "project_filter"
        assert payload.get("blocked_op", {}).get("op_id") == "op-2"
    finally:
        server.shutdown()


def test_peer_project_filter_override_allows_more_than_global(tmp_path: Path, monkeypatch) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"sync_projects_include": ["project-a"]}) + "\n")
    monkeypatch.setenv("OPENCODE_MEM_CONFIG", str(config_path))

    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.record_replication_op(
            op_id="op-1",
            entity_type="memory_item",
            entity_id="k1",
            op_type="upsert",
            payload={"project": "project-a"},
            clock={"rev": 1, "updated_at": "2026-01-01T00:00:00Z", "device_id": "local"},
            device_id="local",
            created_at="2026-01-01T00:00:00Z",
        )
        store.record_replication_op(
            op_id="op-2",
            entity_type="memory_item",
            entity_id="k2",
            op_type="upsert",
            payload={"project": "project-b"},
            clock={"rev": 1, "updated_at": "2026-01-01T00:00:01Z", "device_id": "local"},
            device_id="local",
            created_at="2026-01-01T00:00:01Z",
        )
        ops, _next = store.load_replication_ops_since(None, limit=10, device_id="local")
        allowed_default, _cursor, _blocked = store.filter_replication_ops_for_sync_with_status(ops)
        assert [op.get("op_id") for op in allowed_default] == ["op-1"]

        store.conn.execute(
            """
            INSERT INTO sync_peers(
                peer_device_id,
                pinned_fingerprint,
                public_key,
                addresses_json,
                created_at,
                projects_include_json,
                projects_exclude_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "peer-1",
                "fp",
                "pub",
                "[]",
                "2026-01-24T00:00:00Z",
                "[]",
                "[]",
            ),
        )
        store.conn.commit()
        allowed_peer, _cursor, _blocked = store.filter_replication_ops_for_sync_with_status(
            ops, peer_device_id="peer-1"
        )
        assert [op.get("op_id") for op in allowed_peer] == ["op-1", "op-2"]
    finally:
        store.close()
