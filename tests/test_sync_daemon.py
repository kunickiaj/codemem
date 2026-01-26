import json
import os
import threading
from http.server import HTTPServer
from pathlib import Path
from typing import cast

import pytest

from opencode_mem import db, sync_daemon
from opencode_mem.store import MemoryStore, ReplicationOp
from opencode_mem.sync_api import build_sync_handler
from opencode_mem.sync_daemon import sync_once
from opencode_mem.sync_discovery import update_peer_addresses
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


def test_sync_once_records_attempt_and_cursor(tmp_path: Path) -> None:
    os.environ["OPENCODE_MEM_KEYS_DIR"] = str(tmp_path / "keys-client")
    store_a = MemoryStore(tmp_path / "a.sqlite")
    store_b = MemoryStore(tmp_path / "b.sqlite")
    try:
        session_id = store_a.start_session(
            cwd=str(tmp_path),
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project-a",
        )
        store_a.remember(session_id, kind="note", title="Omega", body_text="Omega body")
        update_peer_addresses(store_a.conn, "peer-1", ["http://127.0.0.1:0"])
    finally:
        store_a.close()
        store_b.close()

    client_keys_dir = tmp_path / "keys-client"
    server_keys_dir = tmp_path / "keys-server"

    conn = db.connect(tmp_path / "b.sqlite")
    try:
        db.initialize_schema(conn)
        ensure_device_identity(conn, keys_dir=server_keys_dir)
    finally:
        conn.close()

    server, port = _start_server(tmp_path / "b.sqlite")
    try:
        client_conn = db.connect(tmp_path / "a.sqlite")
        try:
            client_device_id, _ = ensure_device_identity(client_conn, keys_dir=client_keys_dir)
        finally:
            client_conn.close()
        client_public_key = load_public_key(client_keys_dir)
        assert client_public_key
        fingerprint = fingerprint_public_key(client_public_key)
        conn = db.connect(tmp_path / "b.sqlite")
        try:
            conn.execute(
                """
                INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, addresses_json, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    client_device_id,
                    fingerprint,
                    client_public_key,
                    "[]",
                    "2026-01-24T00:00:00Z",
                ),
            )
            conn.commit()
        finally:
            conn.close()
        server_public_key = load_public_key(server_keys_dir)
        assert server_public_key
        server_fingerprint = fingerprint_public_key(server_public_key)
        conn = db.connect(tmp_path / "a.sqlite")
        try:
            conn.execute(
                """
                UPDATE sync_peers
                SET pinned_fingerprint = ?, public_key = ?
                WHERE peer_device_id = ?
                """,
                (server_fingerprint, server_public_key, "peer-1"),
            )
            conn.commit()
        finally:
            conn.close()

        store_a = MemoryStore(tmp_path / "a.sqlite")
        try:
            result = sync_once(store_a, "peer-1", [f"http://127.0.0.1:{port}"])
            assert result["ok"] is True

            cursor_row = store_a.conn.execute(
                "SELECT last_acked_cursor FROM replication_cursors WHERE peer_device_id = ?",
                ("peer-1",),
            ).fetchone()
            assert cursor_row is not None
            assert cursor_row["last_acked_cursor"]

            attempt = store_a.conn.execute(
                "SELECT ok FROM sync_attempts WHERE peer_device_id = ?",
                ("peer-1",),
            ).fetchone()
            assert attempt is not None
            assert attempt["ok"] == 1
        finally:
            store_a.close()

        store_b = MemoryStore(tmp_path / "b.sqlite")
        try:
            row = store_b.conn.execute(
                "SELECT title FROM memory_items WHERE title = ?",
                ("Omega",),
            ).fetchone()
            assert row is not None
        finally:
            store_b.close()
    finally:
        server.shutdown()
        os.environ.pop("OPENCODE_MEM_KEYS_DIR", None)


def test_request_json_respects_body_bytes(monkeypatch) -> None:
    called = {}

    class DummyConn:
        def __init__(self) -> None:
            self.body = None

        def request(self, method, path, body=None, headers=None):
            self.body = body

        def getresponse(self):
            class Resp:
                status = 200

                def read(self):
                    return b"{}"

            return Resp()

        def close(self):
            return None

    def fake_http(host, port=None, timeout=None):
        called["conn"] = DummyConn()
        return called["conn"]

    monkeypatch.setattr("opencode_mem.sync_daemon.HTTPConnection", fake_http)
    status, _payload = sync_daemon._request_json(
        "POST",
        "http://example.test/ops",
        body={"ops": [1]},
        body_bytes=b"signed-bytes",
    )
    assert status == 200
    assert called["conn"].body == b"signed-bytes"


def _make_op(op_id: str, entity_id: str, payload: dict | None = None) -> dict:
    return {
        "op_id": op_id,
        "entity_type": "memory_item",
        "entity_id": entity_id,
        "op_type": "upsert",
        "payload": payload or {},
        "clock": {"rev": 1, "updated_at": "t", "device_id": "d"},
        "device_id": "d",
        "created_at": "t",
    }


def test_chunk_ops_by_size_single_batch() -> None:
    ops = [_make_op("a", "1"), _make_op("b", "2")]
    typed_ops = cast(list[ReplicationOp], ops)
    body_bytes = len(json.dumps({"ops": ops}, ensure_ascii=False).encode("utf-8"))
    batches = sync_daemon._chunk_ops_by_size(typed_ops, max_bytes=body_bytes)
    assert batches == [typed_ops]


def test_chunk_ops_by_size_splits_batches() -> None:
    ops = [_make_op("a", "1"), _make_op("b", "2"), _make_op("c", "3")]
    typed_ops = cast(list[ReplicationOp], ops)
    max_bytes = len(json.dumps({"ops": ops[:2]}, ensure_ascii=False).encode("utf-8"))
    batches = sync_daemon._chunk_ops_by_size(typed_ops, max_bytes=max_bytes)
    assert batches == [typed_ops[:2], typed_ops[2:]]


def test_chunk_ops_by_size_raises_on_oversize() -> None:
    ops = [_make_op("a", "1", payload={"blob": "x" * 300})]
    typed_ops = cast(list[ReplicationOp], ops)
    body_bytes = len(json.dumps({"ops": ops}, ensure_ascii=False).encode("utf-8"))
    with pytest.raises(RuntimeError, match="single op exceeds size limit"):
        sync_daemon._chunk_ops_by_size(typed_ops, max_bytes=body_bytes - 1)


def test_sync_daemon_tick_uses_run_sync_pass(monkeypatch, tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.conn.execute(
            "INSERT INTO sync_peers(peer_device_id, addresses_json, created_at) VALUES (?, ?, ?)",
            ("peer-1", "[]", "2026-01-24T00:00:00Z"),
        )
        store.conn.execute(
            "INSERT INTO sync_peers(peer_device_id, addresses_json, created_at) VALUES (?, ?, ?)",
            ("peer-2", "[]", "2026-01-24T00:00:00Z"),
        )
        store.conn.commit()

        monkeypatch.setattr(store, "migrate_legacy_import_keys", lambda *, limit: 0)
        monkeypatch.setattr(store, "backfill_replication_ops", lambda *, limit: 0)
        monkeypatch.setattr(sync_daemon, "mdns_enabled", lambda: False)

        called: list[str] = []

        def fake_run_sync_pass(store_arg, peer_device_id, **k):
            called.append(str(peer_device_id))
            return {"ok": True, "peer_device_id": str(peer_device_id)}

        monkeypatch.setattr(sync_daemon, "run_sync_pass", fake_run_sync_pass)

        results = sync_daemon.sync_daemon_tick(store)
        assert {item.get("peer_device_id") for item in results} == {"peer-1", "peer-2"}
        assert set(called) == {"peer-1", "peer-2"}
    finally:
        store.close()
