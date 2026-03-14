from __future__ import annotations

import http.client
import json
import threading
from http.server import HTTPServer
from pathlib import Path

from codemem import db
from codemem.coordinator_api import build_coordinator_handler
from codemem.coordinator_store import CoordinatorStore
from codemem.sync_auth import build_auth_headers
from codemem.sync_identity import ensure_device_identity, fingerprint_public_key, load_public_key


def _start_server(db_path: Path) -> tuple[HTTPServer, int]:
    handler = build_coordinator_handler(db_path)
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, int(server.server_address[1])


def _seed_identity(db_path: Path, keys_dir: Path) -> tuple[str, str, str]:
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        device_id, _ = ensure_device_identity(conn, keys_dir=keys_dir)
    finally:
        conn.close()
    public_key = load_public_key(keys_dir)
    assert public_key
    fingerprint = fingerprint_public_key(public_key)
    return device_id, public_key, fingerprint


def test_coordinator_presence_and_peers_flow(tmp_path: Path) -> None:
    coordinator_db = tmp_path / "coordinator.sqlite"
    client_db = tmp_path / "client.sqlite"
    peer_db = tmp_path / "peer.sqlite"
    client_keys = tmp_path / "client-keys"
    peer_keys = tmp_path / "peer-keys"

    client_device_id, client_public_key, client_fingerprint = _seed_identity(client_db, client_keys)
    peer_device_id, peer_public_key, peer_fingerprint = _seed_identity(peer_db, peer_keys)

    store = CoordinatorStore(coordinator_db)
    try:
        store.create_group("team-alpha", display_name="Team Alpha")
        store.enroll_device(
            "team-alpha",
            device_id=client_device_id,
            fingerprint=client_fingerprint,
            public_key=client_public_key,
            display_name="client",
        )
        store.enroll_device(
            "team-alpha",
            device_id=peer_device_id,
            fingerprint=peer_fingerprint,
            public_key=peer_public_key,
            display_name="peer",
        )
        store.upsert_presence(
            group_id="team-alpha",
            device_id=peer_device_id,
            addresses=["http://127.0.0.1:7337"],
            ttl_s=180,
        )
    finally:
        store.close()

    server, port = _start_server(coordinator_db)
    try:
        presence_body = {
            "group_id": "team-alpha",
            "fingerprint": client_fingerprint,
            "public_key": client_public_key,
            "addresses": ["http://192.0.2.10:7337"],
            "ttl_s": 180,
        }
        presence_url = f"http://127.0.0.1:{port}/v1/presence"
        presence_headers = build_auth_headers(
            device_id=client_device_id,
            method="POST",
            url=presence_url,
            body_bytes=json.dumps(presence_body, ensure_ascii=False).encode("utf-8"),
            keys_dir=client_keys,
        )
        presence_headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request(
            "POST", "/v1/presence", body=json.dumps(presence_body), headers=presence_headers
        )
        resp = conn.getresponse()
        presence_payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert presence_payload["addresses"] == ["http://192.0.2.10:7337"]

        peers_url = f"http://127.0.0.1:{port}/v1/peers?group_id=team-alpha"
        peers_headers = build_auth_headers(
            device_id=client_device_id,
            method="GET",
            url=peers_url,
            body_bytes=b"",
            keys_dir=client_keys,
        )
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/v1/peers?group_id=team-alpha", headers=peers_headers)
        resp = conn.getresponse()
        peers_payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert len(peers_payload["items"]) == 1
        assert peers_payload["items"][0]["device_id"] == peer_device_id
        assert peers_payload["items"][0]["addresses"] == ["http://127.0.0.1:7337"]
        assert peers_payload["items"][0]["stale"] is False
    finally:
        server.shutdown()


def test_coordinator_presence_rejects_non_numeric_ttl(tmp_path: Path) -> None:
    coordinator_db = tmp_path / "coordinator.sqlite"
    client_db = tmp_path / "client.sqlite"
    client_keys = tmp_path / "client-keys"
    client_device_id, client_public_key, client_fingerprint = _seed_identity(client_db, client_keys)

    store = CoordinatorStore(coordinator_db)
    try:
        store.create_group("team-alpha")
        store.enroll_device(
            "team-alpha",
            device_id=client_device_id,
            fingerprint=client_fingerprint,
            public_key=client_public_key,
        )
    finally:
        store.close()

    server, port = _start_server(coordinator_db)
    try:
        body = {
            "group_id": "team-alpha",
            "fingerprint": client_fingerprint,
            "public_key": client_public_key,
            "addresses": ["http://192.0.2.10:7337"],
            "ttl_s": "abc",
        }
        url = f"http://127.0.0.1:{port}/v1/presence"
        headers = build_auth_headers(
            device_id=client_device_id,
            method="POST",
            url=url,
            body_bytes=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            keys_dir=client_keys,
        )
        headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("POST", "/v1/presence", body=json.dumps(body), headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 400
        assert payload["error"] == "ttl_s_must_be_int"
    finally:
        server.shutdown()


def test_coordinator_presence_rejects_non_list_addresses(tmp_path: Path) -> None:
    coordinator_db = tmp_path / "coordinator.sqlite"
    client_db = tmp_path / "client.sqlite"
    client_keys = tmp_path / "client-keys"
    client_device_id, client_public_key, client_fingerprint = _seed_identity(client_db, client_keys)

    store = CoordinatorStore(coordinator_db)
    try:
        store.create_group("team-alpha")
        store.enroll_device(
            "team-alpha",
            device_id=client_device_id,
            fingerprint=client_fingerprint,
            public_key=client_public_key,
        )
    finally:
        store.close()

    server, port = _start_server(coordinator_db)
    try:
        body = {
            "group_id": "team-alpha",
            "fingerprint": client_fingerprint,
            "public_key": client_public_key,
            "addresses": "http://192.0.2.10:7337",
            "ttl_s": 180,
        }
        url = f"http://127.0.0.1:{port}/v1/presence"
        headers = build_auth_headers(
            device_id=client_device_id,
            method="POST",
            url=url,
            body_bytes=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            keys_dir=client_keys,
        )
        headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("POST", "/v1/presence", body=json.dumps(body), headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 400
        assert payload["error"] == "addresses_must_be_list_of_strings"
    finally:
        server.shutdown()


def test_coordinator_presence_rejects_large_body(tmp_path: Path) -> None:
    coordinator_db = tmp_path / "coordinator.sqlite"
    client_db = tmp_path / "client.sqlite"
    client_keys = tmp_path / "client-keys"
    client_device_id, _client_public_key, _client_fingerprint = _seed_identity(
        client_db, client_keys
    )

    server, port = _start_server(coordinator_db)
    try:
        body = b"{" + b"a" * 70000 + b"}"
        url = f"http://127.0.0.1:{port}/v1/presence"
        headers = build_auth_headers(
            device_id=client_device_id,
            method="POST",
            url=url,
            body_bytes=body,
            keys_dir=client_keys,
        )
        headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("POST", "/v1/presence", body=body, headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 413
        assert payload["error"] == "body_too_large"
    finally:
        server.shutdown()


def test_admin_endpoints_require_admin_secret(tmp_path: Path, monkeypatch) -> None:
    coordinator_db = tmp_path / "coordinator.sqlite"
    monkeypatch.setenv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "topsecret")
    store = CoordinatorStore(coordinator_db)
    try:
        store.create_group("team-alpha")
    finally:
        store.close()

    server, port = _start_server(coordinator_db)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/v1/admin/devices?group_id=team-alpha")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 401
        assert payload["error"] == "missing_admin_header"
    finally:
        server.shutdown()


def test_admin_device_management_flow(tmp_path: Path, monkeypatch) -> None:
    coordinator_db = tmp_path / "coordinator.sqlite"
    monkeypatch.setenv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "topsecret")
    store = CoordinatorStore(coordinator_db)
    try:
        store.create_group("team-alpha")
    finally:
        store.close()

    server, port = _start_server(coordinator_db)
    headers = {"X-Codemem-Coordinator-Admin": "topsecret", "Content-Type": "application/json"}
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        body = json.dumps(
            {
                "group_id": "team-alpha",
                "device_id": "device-1",
                "fingerprint": "fp-1",
                "public_key": "ssh-ed25519 AAAAtest example@test",
                "display_name": "laptop",
            }
        )
        conn.request("POST", "/v1/admin/devices", body=body, headers=headers)
        resp = conn.getresponse()
        assert resp.status == 200

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request(
            "GET",
            "/v1/admin/devices?group_id=team-alpha",
            headers={"X-Codemem-Coordinator-Admin": "topsecret"},
        )
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload["items"][0]["display_name"] == "laptop"

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request(
            "POST",
            "/v1/admin/devices/rename",
            body=json.dumps(
                {"group_id": "team-alpha", "device_id": "device-1", "display_name": "work-laptop"}
            ),
            headers=headers,
        )
        resp = conn.getresponse()
        assert resp.status == 200

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request(
            "POST",
            "/v1/admin/devices/disable",
            body=json.dumps({"group_id": "team-alpha", "device_id": "device-1"}),
            headers=headers,
        )
        resp = conn.getresponse()
        assert resp.status == 200

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request(
            "GET",
            "/v1/admin/devices?group_id=team-alpha&include_disabled=1",
            headers={"X-Codemem-Coordinator-Admin": "topsecret"},
        )
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload["items"][0]["display_name"] == "work-laptop"
        assert payload["items"][0]["enabled"] == 0

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request(
            "POST",
            "/v1/admin/devices/remove",
            body=json.dumps({"group_id": "team-alpha", "device_id": "device-1"}),
            headers=headers,
        )
        resp = conn.getresponse()
        assert resp.status == 200

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request(
            "GET",
            "/v1/admin/devices?group_id=team-alpha&include_disabled=1",
            headers={"X-Codemem-Coordinator-Admin": "topsecret"},
        )
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload["items"] == []
    finally:
        server.shutdown()


def test_admin_invite_generation_flow(tmp_path: Path, monkeypatch) -> None:
    coordinator_db = tmp_path / "coordinator.sqlite"
    monkeypatch.setenv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "topsecret")
    store = CoordinatorStore(coordinator_db)
    try:
        store.create_group("team-alpha", display_name="Team Alpha")
    finally:
        store.close()

    server, port = _start_server(coordinator_db)
    headers = {"X-Codemem-Coordinator-Admin": "topsecret", "Content-Type": "application/json"}
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        body = json.dumps(
            {
                "group_id": "team-alpha",
                "policy": "auto_admit",
                "expires_at": "2026-03-15T00:00:00Z",
                "created_by": "admin",
                "coordinator_url": f"http://127.0.0.1:{port}",
            }
        )
        conn.request("POST", "/v1/admin/invites", body=body, headers=headers)
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload["ok"] is True
        assert payload["payload"]["group_id"] == "team-alpha"
        assert payload["payload"]["policy"] == "auto_admit"
        assert payload["encoded"]
        assert payload["link"].startswith("codemem://join?invite=")
    finally:
        server.shutdown()


def test_join_endpoint_auto_admit_and_pending(tmp_path: Path, monkeypatch) -> None:
    coordinator_db = tmp_path / "coordinator.sqlite"
    monkeypatch.setenv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "topsecret")
    store = CoordinatorStore(coordinator_db)
    try:
        store.create_group("team-alpha", display_name="Team Alpha")
        invite_auto = store.create_invite(
            group_id="team-alpha",
            policy="auto_admit",
            expires_at="2099-01-01T00:00:00Z",
        )
        invite_pending = store.create_invite(
            group_id="team-alpha",
            policy="approval_required",
            expires_at="2099-01-01T00:00:00Z",
        )
    finally:
        store.close()

    server, port = _start_server(coordinator_db)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        body = json.dumps(
            {
                "token": invite_auto["token"],
                "device_id": "device-auto",
                "public_key": "ssh-ed25519 AAAAtest auto@test",
                "fingerprint": "fp-auto",
                "display_name": "auto-device",
            }
        )
        conn.request("POST", "/v1/join", body=body, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload["status"] == "enrolled"

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        body = json.dumps(
            {
                "token": invite_pending["token"],
                "device_id": "device-pending",
                "public_key": "ssh-ed25519 AAAAtest pending@test",
                "fingerprint": "fp-pending",
                "display_name": "pending-device",
            }
        )
        conn.request("POST", "/v1/join", body=body, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload["status"] == "pending"
    finally:
        server.shutdown()
