import json
import os
import threading
from http.server import HTTPServer
from pathlib import Path
from typing import cast

import pytest

from codemem import db
from codemem.store import MemoryStore, ReplicationOp
from codemem.sync import http_client, replication, sync_pass
from codemem.sync.discovery import update_peer_addresses
from codemem.sync_api import build_sync_handler
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


def test_sync_once_records_attempt_and_cursor(tmp_path: Path) -> None:
    client_keys_dir = tmp_path / "keys-client"
    server_keys_dir = tmp_path / "keys-server"
    os.environ["CODEMEM_KEYS_DIR"] = str(client_keys_dir)

    conn = db.connect(tmp_path / "a.sqlite")
    try:
        db.initialize_schema(conn)
        ensure_device_identity(conn, keys_dir=client_keys_dir)
    finally:
        conn.close()

    store_a = MemoryStore(tmp_path / "a.sqlite")
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
        # Placeholder peer id; will be renamed to the real server device id once known.
        update_peer_addresses(store_a.conn, "peer-1", ["http://127.0.0.1:0"])
    finally:
        store_a.close()

    conn = db.connect(tmp_path / "b.sqlite")
    try:
        db.initialize_schema(conn)
        server_device_id, _ = ensure_device_identity(conn, keys_dir=server_keys_dir)
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
            conn.execute(
                "UPDATE sync_peers SET peer_device_id = ? WHERE peer_device_id = ?",
                (server_device_id, "peer-1"),
            )
            conn.execute(
                "UPDATE replication_cursors SET peer_device_id = ? WHERE peer_device_id = ?",
                (server_device_id, "peer-1"),
            )
            conn.execute(
                "UPDATE sync_attempts SET peer_device_id = ? WHERE peer_device_id = ?",
                (server_device_id, "peer-1"),
            )
            conn.commit()
        finally:
            conn.close()

        store_a = MemoryStore(tmp_path / "a.sqlite")
        try:
            result = sync_pass.sync_once(store_a, server_device_id, [f"http://127.0.0.1:{port}"])
            assert result["ok"] is True

            cursor_row = store_a.conn.execute(
                "SELECT last_acked_cursor FROM replication_cursors WHERE peer_device_id = ?",
                (server_device_id,),
            ).fetchone()
            assert cursor_row is not None
            assert cursor_row["last_acked_cursor"]

            attempt = store_a.conn.execute(
                "SELECT ok FROM sync_attempts WHERE peer_device_id = ?",
                (server_device_id,),
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
        os.environ.pop("CODEMEM_KEYS_DIR", None)


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

    monkeypatch.setattr("codemem.sync.http_client.HTTPConnection", fake_http)
    status, _payload = http_client.request_json(
        "POST",
        "http://example.test/ops",
        body={"ops": [1]},
        body_bytes=b"signed-bytes",
    )
    assert status == 200
    assert called["conn"].body == b"signed-bytes"


def test_sync_once_splits_push_batches_on_peer_payload_too_large(
    monkeypatch, tmp_path: Path
) -> None:
    client_keys_dir = tmp_path / "keys-client"
    server_keys_dir = tmp_path / "keys-server"
    os.environ["CODEMEM_KEYS_DIR"] = str(client_keys_dir)

    conn = db.connect(tmp_path / "a.sqlite")
    try:
        db.initialize_schema(conn)
        ensure_device_identity(conn, keys_dir=client_keys_dir)
    finally:
        conn.close()

    conn = db.connect(tmp_path / "b.sqlite")
    try:
        db.initialize_schema(conn)
        server_device_id, _ = ensure_device_identity(conn, keys_dir=server_keys_dir)
    finally:
        conn.close()

    # Force the server to reject larger POST bodies.
    monkeypatch.setattr("codemem.sync_api.MAX_SYNC_BODY_BYTES", 10_000)

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

        store_a = MemoryStore(tmp_path / "a.sqlite")
        try:
            update_peer_addresses(store_a.conn, server_device_id, [f"http://127.0.0.1:{port}"])
            store_a.conn.execute(
                "UPDATE sync_peers SET pinned_fingerprint = ?, public_key = ? WHERE peer_device_id = ?",
                (server_fingerprint, server_public_key, server_device_id),
            )
            store_a.conn.commit()

            session_id = store_a.start_session(
                cwd=str(tmp_path),
                git_remote=None,
                git_branch=None,
                user="tester",
                tool_version="test",
                project="/tmp/project-a",
            )
            # Create enough small ops that the default client batch exceeds the server limit,
            # but each individual op remains below it so splitting can succeed.
            for i in range(30):
                store_a.remember(
                    session_id,
                    kind="note",
                    title=f"Small-{i}",
                    body_text="x" * 800,
                )

            result = sync_pass.sync_once(
                store_a, server_device_id, [f"http://127.0.0.1:{port}"], limit=50
            )
            assert result["ok"] is True
        finally:
            store_a.close()
    finally:
        server.shutdown()
        os.environ.pop("CODEMEM_KEYS_DIR", None)


def test_apply_replication_ops_allows_cross_device_legacy_entity_id(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        sender_device_id = "dev-a"
        origin_device_id = "dev-b"
        legacy_id = f"legacy:{origin_device_id}:memory_item:123"
        op = {
            "op_id": "op-1",
            "entity_type": "memory_item",
            "entity_id": legacy_id,
            "op_type": "upsert",
            "payload": {
                "session_id": 1,
                "kind": "note",
                "title": "Hello",
                "body_text": "World",
                "import_key": legacy_id,
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
            },
            "clock": {
                "rev": 1,
                "updated_at": "2026-01-01T00:00:00Z",
                "device_id": sender_device_id,
            },
            "device_id": sender_device_id,
            "created_at": "2026-01-01T00:00:00Z",
        }

        result = store.apply_replication_ops(
            cast(list[ReplicationOp], [op]),
            source_device_id=sender_device_id,
            received_at="2026-01-01T00:00:00Z",
        )
        assert result["inserted"] == 1
    finally:
        store.close()


def _make_op(op_id: str, entity_id: str, payload: dict | None = None) -> dict:
    return {
        "op_id": op_id,
        "entity_type": "memory_item",
        "entity_id": entity_id,
        "op_type": "upsert",
        "payload": payload or {},
        "clock": {"rev": 1, "updated_at": "2026-01-01T00:00:00Z", "device_id": "d"},
        "device_id": "d",
        "created_at": "2026-01-01T00:00:00Z",
    }


def test_chunk_ops_by_size_single_batch() -> None:
    ops = [_make_op("a", "1"), _make_op("b", "2")]
    typed_ops = cast(list[ReplicationOp], ops)
    body_bytes = len(json.dumps({"ops": ops}, ensure_ascii=False).encode("utf-8"))
    batches = replication.chunk_ops_by_size(typed_ops, max_bytes=body_bytes)
    assert batches == [typed_ops]


def test_chunk_ops_by_size_splits_batches() -> None:
    ops = [_make_op("a", "1"), _make_op("b", "2"), _make_op("c", "3")]
    typed_ops = cast(list[ReplicationOp], ops)
    max_bytes = len(json.dumps({"ops": ops[:2]}, ensure_ascii=False).encode("utf-8"))
    batches = replication.chunk_ops_by_size(typed_ops, max_bytes=max_bytes)
    assert batches == [typed_ops[:2], typed_ops[2:]]


def test_chunk_ops_by_size_raises_on_oversize() -> None:
    ops = [_make_op("a", "1", payload={"blob": "x" * 300})]
    typed_ops = cast(list[ReplicationOp], ops)
    body_bytes = len(json.dumps({"ops": ops}, ensure_ascii=False).encode("utf-8"))
    with pytest.raises(RuntimeError, match="single op exceeds size limit"):
        replication.chunk_ops_by_size(typed_ops, max_bytes=body_bytes - 1)


def test_sync_once_does_not_trust_peer_next_cursor(monkeypatch, tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.conn.execute(
            "INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, addresses_json, created_at) VALUES (?, ?, ?, ?)",
            ("peer-1", "fp-peer", "[]", "2026-01-24T00:00:00Z"),
        )
        store.conn.commit()

        monkeypatch.setattr(
            "codemem.sync.sync_pass.ensure_device_identity",
            lambda conn, keys_dir=None: ("dev-local", "fp-local"),
        )
        monkeypatch.setattr(
            "codemem.sync.sync_pass.build_auth_headers",
            lambda **kwargs: {},
        )

        ops = [
            {
                "op_id": "op-1",
                "entity_type": "memory_item",
                "entity_id": "k1",
                "op_type": "upsert",
                "payload": {},
                "clock": {
                    "rev": 1,
                    "updated_at": "2026-01-01T00:00:00Z",
                    "device_id": "peer-1",
                },
                "device_id": "peer-1",
                "created_at": "2026-01-01T00:00:00Z",
            },
            {
                "op_id": "op-2",
                "entity_type": "memory_item",
                "entity_id": "k2",
                "op_type": "upsert",
                "payload": {},
                "clock": {
                    "rev": 1,
                    "updated_at": "2026-01-01T00:00:01Z",
                    "device_id": "peer-1",
                },
                "device_id": "peer-1",
                "created_at": "2026-01-01T00:00:01Z",
            },
        ]

        def fake_request_json(method: str, url: str, **kwargs):
            if url.endswith("/v1/status"):
                return 200, {"fingerprint": "fp-peer"}
            if "/v1/ops?" in url:
                return 200, {"ops": ops, "next_cursor": "9999-01-01T00:00:00Z|zzz"}
            raise AssertionError(f"unexpected request: {method} {url}")

        monkeypatch.setattr(http_client, "request_json", fake_request_json)

        result = sync_pass.sync_once(store, "peer-1", ["127.0.0.1:7337"], limit=10)
        assert result["ok"] is True

        row = store.conn.execute(
            "SELECT last_applied_cursor FROM replication_cursors WHERE peer_device_id = ?",
            ("peer-1",),
        ).fetchone()
        assert row is not None
        assert row["last_applied_cursor"] == "2026-01-01T00:00:01Z|op-2"
    finally:
        store.close()


def test_sync_once_succeeds_when_peer_skips_filtered_ops(monkeypatch, tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.conn.execute(
            "INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, addresses_json, created_at) VALUES (?, ?, ?, ?)",
            ("peer-1", "fp-peer", "[]", "2026-01-24T00:00:00Z"),
        )
        store.conn.commit()

        monkeypatch.setattr(
            "codemem.sync.sync_pass.ensure_device_identity",
            lambda conn, keys_dir=None: ("dev-local", "fp-local"),
        )
        monkeypatch.setattr(
            "codemem.sync.sync_pass.build_auth_headers",
            lambda **kwargs: {},
        )

        def fake_request_json(method: str, url: str, **kwargs):
            if url.endswith("/v1/status"):
                return 200, {"fingerprint": "fp-peer"}
            if "/v1/ops?" in url:
                return 200, {
                    "ops": [],
                    "next_cursor": "2026-01-01T00:00:09Z|op-9",
                    "skipped": 2,
                }
            return 200, {"inserted": 0, "updated": 0}

        monkeypatch.setattr(http_client, "request_json", fake_request_json)

        result = sync_pass.sync_once(store, "peer-1", ["127.0.0.1:7337"], limit=10)
        assert result["ok"] is True
        assert result["ops_in"] == 0
        row = store.conn.execute(
            "SELECT last_applied_cursor FROM replication_cursors WHERE peer_device_id = ?",
            ("peer-1",),
        ).fetchone()
        assert row is not None
        assert row["last_applied_cursor"] == "2026-01-01T00:00:09Z|op-9"
    finally:
        store.close()


def test_sync_once_includes_auth_reason_in_status_failure_detail(
    monkeypatch, tmp_path: Path
) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.conn.execute(
            "INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, addresses_json, created_at) VALUES (?, ?, ?, ?)",
            ("peer-1", "fp-peer", "[]", "2026-01-24T00:00:00Z"),
        )
        store.conn.commit()

        monkeypatch.setattr(
            "codemem.sync.sync_pass.ensure_device_identity",
            lambda conn, keys_dir=None: ("dev-local", "fp-local"),
        )
        monkeypatch.setattr(
            "codemem.sync.sync_pass.build_auth_headers",
            lambda **kwargs: {},
        )

        def fake_request_json(method: str, url: str, **kwargs):
            if url.endswith("/v1/status"):
                return 401, {"error": "unauthorized", "reason": "unknown_peer"}
            raise AssertionError(f"unexpected request: {method} {url}")

        monkeypatch.setattr(http_client, "request_json", fake_request_json)

        result = sync_pass.sync_once(store, "peer-1", ["127.0.0.1:7337"], limit=10)
        assert result["ok"] is False
        assert "unauthorized:unknown_peer" in str(result.get("error") or "")
    finally:
        store.close()


def test_sync_once_advances_last_acked_when_outbound_filtered(monkeypatch, tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.conn.execute(
            "INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, addresses_json, created_at) VALUES (?, ?, ?, ?)",
            ("peer-1", "fp-peer", "[]", "2026-01-24T00:00:00Z"),
        )
        store.conn.commit()

        monkeypatch.setattr(
            "codemem.sync.sync_pass.ensure_device_identity",
            lambda conn, keys_dir=None: ("dev-local", "fp-local"),
        )
        monkeypatch.setattr(
            "codemem.sync.sync_pass.build_auth_headers",
            lambda **kwargs: {},
        )

        def fake_request_json(method: str, url: str, **kwargs):
            if url.endswith("/v1/status"):
                return 200, {"fingerprint": "fp-peer"}
            if "/v1/ops?" in url:
                return 200, {"ops": []}
            return 200, {"inserted": 0, "updated": 0}

        monkeypatch.setattr(http_client, "request_json", fake_request_json)

        outbound_cursor = "2026-02-01T00:00:00Z|op-1"

        def fake_load_replication_ops_since(cursor, *, limit, device_id):
            return [
                {
                    "op_id": "op-1",
                    "entity_type": "memory_item",
                    "entity_id": "k1",
                    "op_type": "upsert",
                    "payload": {},
                    "clock": {
                        "rev": 1,
                        "updated_at": "2026-02-01T00:00:00Z",
                        "device_id": "dev-local",
                    },
                    "device_id": "dev-local",
                    "created_at": "2026-02-01T00:00:00Z",
                }
            ], outbound_cursor

        def fake_filter_replication_ops_for_sync(ops, *, peer_device_id=None):
            return [], outbound_cursor

        monkeypatch.setattr(store, "load_replication_ops_since", fake_load_replication_ops_since)
        monkeypatch.setattr(
            store, "filter_replication_ops_for_sync", fake_filter_replication_ops_for_sync
        )

        result = sync_pass.sync_once(store, "peer-1", ["127.0.0.1:7337"], limit=10)
        assert result["ok"] is True

        row = store.conn.execute(
            "SELECT last_acked_cursor FROM replication_cursors WHERE peer_device_id = ?",
            ("peer-1",),
        ).fetchone()
        assert row is not None
        assert row["last_acked_cursor"] == outbound_cursor
    finally:
        store.close()


def test_sync_once_backfills_tags_and_vectors_for_incoming_upserts(
    monkeypatch, tmp_path: Path
) -> None:
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
        memory_id = store.remember(session_id, kind="note", title="Seed", body_text="Body")
        store.conn.execute(
            "UPDATE memory_items SET import_key = ? WHERE id = ?", ("import-1", memory_id)
        )
        store.conn.execute(
            "INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, addresses_json, created_at) VALUES (?, ?, ?, ?)",
            ("peer-1", "fp-peer", "[]", "2026-01-24T00:00:00Z"),
        )
        store.conn.commit()

        monkeypatch.setattr(
            "codemem.sync.sync_pass.ensure_device_identity",
            lambda conn, keys_dir=None: ("dev-local", "fp-local"),
        )
        monkeypatch.setattr(
            "codemem.sync.sync_pass.build_auth_headers",
            lambda **kwargs: {},
        )

        captured: dict[str, list[int]] = {"tags": [], "vectors": []}

        def fake_backfill_tags_text(*, memory_ids=None, active_only=True, **kwargs):
            captured["tags"] = list(memory_ids or [])
            return {"checked": len(captured["tags"]), "updated": 0, "skipped": 0}

        def fake_backfill_vectors(*, memory_ids=None, active_only=True, **kwargs):
            captured["vectors"] = list(memory_ids or [])
            return {"checked": len(captured["vectors"]), "embedded": 0, "inserted": 0, "skipped": 0}

        monkeypatch.setattr(store, "backfill_tags_text", fake_backfill_tags_text)
        monkeypatch.setattr(store, "backfill_vectors", fake_backfill_vectors)
        monkeypatch.setattr(
            store,
            "apply_replication_ops",
            lambda ops, source_device_id, received_at: {"inserted": 1, "updated": 0, "skipped": 0},
        )

        incoming_ops = [
            {
                "op_id": "op-1",
                "entity_type": "memory_item",
                "entity_id": "import-1",
                "op_type": "upsert",
                "payload": {"import_key": "import-1"},
                "clock": {
                    "rev": 1,
                    "updated_at": "2026-01-01T00:00:00Z",
                    "device_id": "peer-1",
                },
                "device_id": "peer-1",
                "created_at": "2026-01-01T00:00:00Z",
            }
        ]

        def fake_request_json(method: str, url: str, **kwargs):
            if url.endswith("/v1/status"):
                return 200, {"fingerprint": "fp-peer"}
            if "/v1/ops?" in url:
                return 200, {"ops": incoming_ops}
            return 200, {"inserted": 0, "updated": 0}

        monkeypatch.setattr(http_client, "request_json", fake_request_json)

        result = sync_pass.sync_once(store, "peer-1", ["127.0.0.1:7337"], limit=10)
        assert result["ok"] is True
        assert captured["tags"] == [memory_id]
        assert captured["vectors"] == [memory_id]
    finally:
        store.close()


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
        monkeypatch.setattr(sync_pass.discovery, "mdns_enabled", lambda: False)

        called: list[str] = []

        def fake_run_sync_pass(store_arg, peer_device_id, **k):
            called.append(str(peer_device_id))
            return {"ok": True, "peer_device_id": str(peer_device_id)}

        monkeypatch.setattr(sync_pass, "run_sync_pass", fake_run_sync_pass)

        results = sync_pass.sync_daemon_tick(store)
        assert {item.get("peer_device_id") for item in results} == {"peer-1", "peer-2"}
        assert set(called) == {"peer-1", "peer-2"}
    finally:
        store.close()
