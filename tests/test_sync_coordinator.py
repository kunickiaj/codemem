from __future__ import annotations

import datetime as dt
import json
import threading
from http.server import HTTPServer
from pathlib import Path

from codemem.config import OpencodeMemConfig
from codemem.store import MemoryStore
from codemem.sync import coordinator
from codemem.sync.sync_pass import run_sync_pass
from codemem.sync_api import build_sync_handler
from codemem.sync_identity import ensure_device_identity, fingerprint_public_key, load_public_key


def _start_server(db_path: Path) -> tuple[HTTPServer, int]:
    handler = build_sync_handler(db_path)
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, int(server.server_address[1])


def test_refresh_peer_address_cache_updates_matching_peer(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    keys_dir = tmp_path / "keys"
    monkeypatch.setenv("CODEMEM_KEYS_DIR", str(keys_dir))
    store = MemoryStore(db_path)
    try:
        ensure_device_identity(store.conn, keys_dir=keys_dir)
        actor = store.create_actor(display_name="Teammate")
        store.conn.execute(
            """
            INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, actor_id, addresses_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "peer-1",
                "fp-peer-1",
                "ssh-ed25519 AAAApeer",
                actor["actor_id"],
                json.dumps(["http://stale.local:7337"]),
                "2026-01-24T00:00:00Z",
            ),
        )
        store.conn.commit()

        def fake_request_json(method: str, url: str, **_kwargs):
            if method == "POST" and url.endswith("/v1/presence"):
                return 200, {
                    "ok": True,
                    "addresses": ["http://127.0.0.1:7337"],
                    "expires_at": "2099-01-01T00:00:00Z",
                }
            if method == "GET" and "/v1/peers?" in url:
                return 200, {
                    "items": [
                        {
                            "device_id": "peer-1",
                            "fingerprint": "fp-peer-1",
                            "addresses": ["http://127.0.0.1:7337"],
                            "last_seen_at": "2099-01-01T00:00:00Z",
                            "expires_at": "2099-01-01T00:03:00Z",
                            "stale": False,
                        }
                    ]
                }
            raise AssertionError(f"unexpected {method} {url}")

        monkeypatch.setattr("codemem.sync.coordinator.http_client.request_json", fake_request_json)

        result = coordinator.refresh_peer_address_cache(
            store,
            config=OpencodeMemConfig(
                sync_coordinator_url="https://coord.example",
                sync_coordinator_group="team-alpha",
                sync_coordinator_timeout_s=3,
                sync_coordinator_presence_ttl_s=180,
                sync_advertise="127.0.0.1",
                sync_port=7337,
            ),
        )

        addresses = store.conn.execute(
            "SELECT addresses_json FROM sync_peers WHERE peer_device_id = ?",
            ("peer-1",),
        ).fetchone()

        assert result == {"updated_peers": 1, "ignored_peers": 0}
        assert addresses is not None
        assert json.loads(addresses["addresses_json"]) == [
            "http://127.0.0.1:7337",
            "http://stale.local:7337",
        ]
    finally:
        store.close()


def test_refresh_peer_address_cache_ignores_fingerprint_mismatch(
    tmp_path: Path, monkeypatch
) -> None:
    db_path = tmp_path / "mem.sqlite"
    keys_dir = tmp_path / "keys"
    monkeypatch.setenv("CODEMEM_KEYS_DIR", str(keys_dir))
    store = MemoryStore(db_path)
    try:
        ensure_device_identity(store.conn, keys_dir=keys_dir)
        actor = store.create_actor(display_name="Teammate")
        store.conn.execute(
            """
            INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, actor_id, addresses_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "peer-1",
                "expected-fingerprint",
                "ssh-ed25519 AAAApeer",
                actor["actor_id"],
                json.dumps(["http://stale.local:7337"]),
                "2026-01-24T00:00:00Z",
            ),
        )
        store.conn.commit()

        def fake_request_json(method: str, url: str, **_kwargs):
            if method == "POST":
                return 200, {"ok": True, "addresses": [], "expires_at": "2099-01-01T00:00:00Z"}
            return 200, {
                "items": [
                    {
                        "device_id": "peer-1",
                        "fingerprint": "wrong-fingerprint",
                        "addresses": ["http://127.0.0.1:7337"],
                        "expires_at": "2099-01-01T00:03:00Z",
                    }
                ]
            }

        monkeypatch.setattr("codemem.sync.coordinator.http_client.request_json", fake_request_json)

        result = coordinator.refresh_peer_address_cache(
            store,
            config=OpencodeMemConfig(
                sync_coordinator_url="https://coord.example",
                sync_coordinator_group="team-alpha",
                sync_coordinator_timeout_s=3,
                sync_coordinator_presence_ttl_s=180,
                sync_advertise="127.0.0.1",
                sync_port=7337,
            ),
        )

        addresses = store.conn.execute(
            "SELECT addresses_json FROM sync_peers WHERE peer_device_id = ?",
            ("peer-1",),
        ).fetchone()

        assert result == {"updated_peers": 0, "ignored_peers": 1}
        assert addresses is not None
        assert json.loads(addresses["addresses_json"]) == ["http://stale.local:7337"]
    finally:
        store.close()


def test_refresh_peer_address_cache_ignores_expired_presence(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    keys_dir = tmp_path / "keys"
    monkeypatch.setenv("CODEMEM_KEYS_DIR", str(keys_dir))
    store = MemoryStore(db_path)
    try:
        ensure_device_identity(store.conn, keys_dir=keys_dir)
        actor = store.create_actor(display_name="Teammate")
        store.conn.execute(
            """
            INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, actor_id, addresses_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "peer-1",
                "fp-peer-1",
                "ssh-ed25519 AAAApeer",
                actor["actor_id"],
                json.dumps(["http://stale.local:7337"]),
                "2026-01-24T00:00:00Z",
            ),
        )
        store.conn.commit()

        def fake_request_json(method: str, url: str, **_kwargs):
            if method == "POST":
                return 200, {"ok": True, "addresses": [], "expires_at": "2099-01-01T00:00:00Z"}
            return 200, {
                "items": [
                    {
                        "device_id": "peer-1",
                        "fingerprint": "fp-peer-1",
                        "addresses": ["http://127.0.0.1:7337"],
                        "expires_at": "2000-01-01T00:00:00Z",
                    }
                ]
            }

        monkeypatch.setattr("codemem.sync.coordinator.http_client.request_json", fake_request_json)

        result = coordinator.refresh_peer_address_cache(
            store,
            config=OpencodeMemConfig(
                sync_coordinator_url="https://coord.example",
                sync_coordinator_group="team-alpha",
                sync_coordinator_timeout_s=3,
                sync_coordinator_presence_ttl_s=180,
                sync_advertise="127.0.0.1",
                sync_port=7337,
            ),
        )

        addresses = store.conn.execute(
            "SELECT addresses_json FROM sync_peers WHERE peer_device_id = ?",
            ("peer-1",),
        ).fetchone()

        assert result == {"updated_peers": 0, "ignored_peers": 1}
        assert addresses is not None
        assert json.loads(addresses["addresses_json"]) == ["http://stale.local:7337"]
    finally:
        store.close()


def test_run_sync_pass_uses_coordinator_refreshed_addresses(tmp_path: Path, monkeypatch) -> None:
    local_db = tmp_path / "local.sqlite"
    remote_db = tmp_path / "remote.sqlite"
    local_keys = tmp_path / "local-keys"
    remote_keys = tmp_path / "remote-keys"
    monkeypatch.setenv("CODEMEM_KEYS_DIR", str(local_keys))

    remote_store = MemoryStore(remote_db)
    try:
        remote_device_id, _ = ensure_device_identity(remote_store.conn, keys_dir=remote_keys)
        remote_store.device_id = remote_device_id
        remote_public_key = load_public_key(remote_keys)
        assert remote_public_key
        remote_fingerprint = fingerprint_public_key(remote_public_key)
        remote_session = remote_store.start_session(
            cwd=str(tmp_path),
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="codemem",
        )
        remote_store.remember(
            remote_session, kind="note", title="Remote", body_text="From coordinator peer"
        )
    finally:
        remote_store.close()

    server, port = _start_server(remote_db)
    local_store = MemoryStore(local_db)
    try:
        local_device_id, _ = ensure_device_identity(local_store.conn, keys_dir=local_keys)
        local_public_key = load_public_key(local_keys)
        assert local_public_key
        local_fingerprint = fingerprint_public_key(local_public_key)
        local_store.conn.execute(
            """
            INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, addresses_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                remote_device_id,
                remote_fingerprint,
                remote_public_key,
                json.dumps([]),
                dt.datetime.now(dt.UTC).isoformat(),
            ),
        )
        local_store.conn.commit()
        remote_conn = MemoryStore(remote_db)
        try:
            remote_conn.conn.execute(
                """
                INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, addresses_json, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    local_device_id,
                    local_fingerprint,
                    local_public_key,
                    json.dumps([]),
                    dt.datetime.now(dt.UTC).isoformat(),
                ),
            )
            remote_conn.conn.commit()
        finally:
            remote_conn.close()

        def fake_refresh(store: MemoryStore) -> dict[str, int]:
            store.conn.execute(
                "UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = ?",
                (json.dumps([f"http://127.0.0.1:{port}"]), remote_device_id),
            )
            store.conn.commit()
            return {"updated_peers": 1, "ignored_peers": 0}

        monkeypatch.setattr(
            "codemem.sync.sync_pass.coordinator.refresh_peer_address_cache", fake_refresh
        )

        result = run_sync_pass(local_store, remote_device_id, mdns_entries=[])
        imported = local_store.conn.execute(
            "SELECT COUNT(1) AS total FROM memory_items WHERE title = ?",
            ("Remote",),
        ).fetchone()

        assert result["ok"] is True
        assert imported is not None
        assert int(imported["total"] or 0) == 1
    finally:
        local_store.close()
        server.shutdown()


def test_run_sync_pass_falls_back_when_coordinator_refresh_fails(
    tmp_path: Path, monkeypatch
) -> None:
    local_db = tmp_path / "local.sqlite"
    remote_db = tmp_path / "remote.sqlite"
    local_keys = tmp_path / "local-keys"
    remote_keys = tmp_path / "remote-keys"
    monkeypatch.setenv("CODEMEM_KEYS_DIR", str(local_keys))

    remote_store = MemoryStore(remote_db)
    try:
        remote_device_id, _ = ensure_device_identity(remote_store.conn, keys_dir=remote_keys)
        remote_store.device_id = remote_device_id
        remote_public_key = load_public_key(remote_keys)
        assert remote_public_key
        remote_fingerprint = fingerprint_public_key(remote_public_key)
        remote_session = remote_store.start_session(
            cwd=str(tmp_path),
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="codemem",
        )
        remote_store.remember(
            remote_session, kind="note", title="Remote", body_text="From cached peer"
        )
    finally:
        remote_store.close()

    server, port = _start_server(remote_db)
    local_store = MemoryStore(local_db)
    try:
        local_device_id, _ = ensure_device_identity(local_store.conn, keys_dir=local_keys)
        local_public_key = load_public_key(local_keys)
        assert local_public_key
        local_fingerprint = fingerprint_public_key(local_public_key)
        local_store.conn.execute(
            """
            INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, addresses_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                remote_device_id,
                remote_fingerprint,
                remote_public_key,
                json.dumps([f"http://127.0.0.1:{port}"]),
                dt.datetime.now(dt.UTC).isoformat(),
            ),
        )
        local_store.conn.commit()
        remote_conn = MemoryStore(remote_db)
        try:
            remote_conn.conn.execute(
                """
                INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, addresses_json, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    local_device_id,
                    local_fingerprint,
                    local_public_key,
                    json.dumps([]),
                    dt.datetime.now(dt.UTC).isoformat(),
                ),
            )
            remote_conn.conn.commit()
        finally:
            remote_conn.close()

        def fake_refresh(_store: MemoryStore) -> dict[str, int]:
            raise RuntimeError("unauthorized")

        monkeypatch.setattr(
            "codemem.sync.sync_pass.coordinator.refresh_peer_address_cache", fake_refresh
        )

        result = run_sync_pass(local_store, remote_device_id, mdns_entries=[])
        imported = local_store.conn.execute(
            "SELECT COUNT(1) AS total FROM memory_items WHERE title = ?",
            ("Remote",),
        ).fetchone()

        assert result["ok"] is True
        assert imported is not None
        assert int(imported["total"] or 0) == 1
    finally:
        local_store.close()
        server.shutdown()
