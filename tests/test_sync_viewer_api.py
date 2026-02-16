import datetime as dt
import http.client
import json
import threading
from http.server import HTTPServer
from pathlib import Path

from codemem import db, sync_identity
from codemem.sync_identity import ensure_device_identity
from codemem.sync_runtime import SyncRuntimeStatus
from codemem.viewer import ViewerHandler


def _start_server(db_path: Path) -> tuple[HTTPServer, int]:
    server = HTTPServer(("127.0.0.1", 0), ViewerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, int(server.server_address[1])


def _write_fake_keys(private_key_path: Path, public_key_path: Path) -> None:
    private_key_path.parent.mkdir(parents=True, exist_ok=True)
    private_key_path.write_text("private-key")
    public_key_path.write_text("public-key")


def _monkeypatch_sync_enabled(monkeypatch) -> None:
    monkeypatch.setattr(
        "codemem.viewer.load_config",
        lambda: type(
            "Cfg",
            (),
            {
                "sync_enabled": True,
                "sync_host": "127.0.0.1",
                "sync_port": 7337,
                "sync_interval_s": 60,
                "sync_projects_include": [],
                "sync_projects_exclude": [],
            },
        )(),
    )
    monkeypatch.setattr(
        "codemem.viewer_routes.sync.effective_status",
        lambda _host, _port: SyncRuntimeStatus(running=True, mechanism="test", detail=""),
    )


def test_sync_status_endpoint(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    monkeypatch.setenv("CODEMEM_KEYS_DIR", str(tmp_path / "keys"))
    monkeypatch.setattr(
        "codemem.viewer.load_config",
        lambda: type(
            "Cfg",
            (),
            {
                "sync_enabled": True,
                "sync_host": "127.0.0.1",
                "sync_port": 7337,
                "sync_interval_s": 60,
                "sync_projects_include": [],
                "sync_projects_exclude": [],
            },
        )(),
    )
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
        assert payload.get("peer_count") == 1
        assert payload.get("redacted") is True
        assert payload.get("daemon_state") == "error"
        assert payload.get("daemon_last_error") is None
    finally:
        server.shutdown()


def test_sync_status_endpoint_includes_diagnostics_when_requested(
    tmp_path: Path, monkeypatch
) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    monkeypatch.setenv("CODEMEM_KEYS_DIR", str(tmp_path / "keys"))
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
        conn.request("GET", "/api/sync/status?includeDiagnostics=1")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload.get("redacted") is False
        assert payload.get("device_id") == "dev-1"
        assert payload.get("daemon_last_error") == "boom"
        assert payload.get("bind")
    finally:
        server.shutdown()


def test_sync_status_keeps_stale_when_recent_attempt_fails_without_live_peer(
    tmp_path: Path, monkeypatch
) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    _monkeypatch_sync_enabled(monkeypatch)
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        stale_ts = (
            (dt.datetime.now(dt.UTC) - dt.timedelta(hours=11)).isoformat().replace("+00:00", "Z")
        )
        failed_ts = dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")
        conn.execute(
            """
            INSERT INTO sync_peers(
                peer_device_id, name, pinned_fingerprint, addresses_json,
                last_seen_at, last_sync_at, last_error, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "peer-1",
                "work",
                "fp-peer",
                json.dumps(["http://peer.local:7337"]),
                stale_ts,
                stale_ts,
                None,
                stale_ts,
            ),
        )
        conn.execute(
            """
            INSERT INTO sync_attempts(peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "peer-1",
                0,
                "http://peer.local:7337: timeout",
                failed_ts,
                failed_ts,
                0,
                0,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/status?includeDiagnostics=1")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload.get("daemon_state") == "stale"
        peers = payload.get("peers") or []
        assert peers
        peer_status = peers[0].get("status") or {}
        assert peer_status.get("peer_state") == "stale"
        assert peer_status.get("sync_status") == "stale"
        assert peer_status.get("ping_status") == "stale"
    finally:
        server.shutdown()


def test_sync_status_marks_offline_peers_as_informational_state(
    tmp_path: Path, monkeypatch
) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    _monkeypatch_sync_enabled(monkeypatch)
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        stale_ts = (
            (dt.datetime.now(dt.UTC) - dt.timedelta(hours=11)).isoformat().replace("+00:00", "Z")
        )
        failed_ts = dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")
        conn.execute(
            """
            INSERT INTO sync_peers(
                peer_device_id, name, pinned_fingerprint, addresses_json,
                last_seen_at, last_sync_at, last_error, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "peer-1",
                "work",
                "fp-peer",
                json.dumps(["http://peer.local:7337"]),
                stale_ts,
                stale_ts,
                "dial timeout",
                stale_ts,
            ),
        )
        conn.execute(
            """
            INSERT INTO sync_attempts(peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "peer-1",
                0,
                "http://peer.local:7337: timeout",
                failed_ts,
                failed_ts,
                0,
                0,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/status?includeDiagnostics=1")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload.get("daemon_state") == "offline-peers"
        peers = payload.get("peers") or []
        assert peers
        peer_status = peers[0].get("status") or {}
        assert peer_status.get("peer_state") == "offline"
    finally:
        server.shutdown()


def test_sync_status_ignores_stale_failure_for_top_level_error(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    _monkeypatch_sync_enabled(monkeypatch)
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        stale_ts = (
            (dt.datetime.now(dt.UTC) - dt.timedelta(hours=11)).isoformat().replace("+00:00", "Z")
        )
        conn.execute(
            """
            INSERT INTO sync_peers(
                peer_device_id, name, pinned_fingerprint, addresses_json,
                last_seen_at, last_sync_at, last_error, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "peer-1",
                "work",
                "fp-peer",
                json.dumps(["http://peer.local:7337"]),
                stale_ts,
                stale_ts,
                None,
                stale_ts,
            ),
        )
        conn.execute(
            """
            INSERT INTO sync_attempts(peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "peer-1",
                0,
                "http://peer.local:7337: timeout",
                stale_ts,
                stale_ts,
                0,
                0,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/status?includeDiagnostics=1")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload.get("daemon_state") == "stale"
    finally:
        server.shutdown()


def test_sync_status_marks_degraded_when_peer_is_fresh_but_has_error(
    tmp_path: Path, monkeypatch
) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    _monkeypatch_sync_enabled(monkeypatch)
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        fresh_ts = dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")
        conn.execute(
            """
            INSERT INTO sync_peers(
                peer_device_id, name, pinned_fingerprint, addresses_json,
                last_seen_at, last_sync_at, last_error, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "peer-1",
                "work",
                "fp-peer",
                json.dumps(["http://peer.local:7337"]),
                fresh_ts,
                fresh_ts,
                "dial timeout",
                fresh_ts,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/status?includeDiagnostics=1")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload.get("daemon_state") == "degraded"
        peers = payload.get("peers") or []
        assert peers
        peer_status = peers[0].get("status") or {}
        assert peer_status.get("peer_state") == "degraded"
    finally:
        server.shutdown()


def test_sync_status_attempt_address_parses_prefixed_multi_address_error(
    tmp_path: Path, monkeypatch
) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        ts = dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")
        conn.execute(
            """
            INSERT INTO sync_attempts(peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "peer-1",
                0,
                "all addresses failed | http://a.local:7337: timeout || http://b.local:7337: refused",
                ts,
                ts,
                0,
                0,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/status?includeDiagnostics=1")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        attempts = payload.get("attempts") or []
        assert attempts
        assert attempts[0].get("address") == "http://a.local:7337"
    finally:
        server.shutdown()


def test_sync_status_includes_project_filter_from_config(tmp_path: Path, monkeypatch) -> None:
    # Objective: /api/sync/status reflects configured sync project include/exclude filters.

    # Arrange
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    monkeypatch.setattr(
        "codemem.viewer.load_config",
        lambda: type(
            "Cfg",
            (),
            {
                "sync_enabled": True,
                "sync_host": "127.0.0.1",
                "sync_port": 7337,
                "sync_interval_s": 60,
                "sync_projects_include": ["codemem"],
                "sync_projects_exclude": ["other"],
            },
        )(),
    )
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        # Act
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/status")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))

        # Assert
        assert resp.status == 200
        assert payload.get("project_filter") == {
            "include": ["codemem"],
            "exclude": ["other"],
        }
    finally:
        server.shutdown()


def test_sync_status_project_filter_defaults_when_config_missing_fields(
    tmp_path: Path, monkeypatch
) -> None:
    # Objective: /api/sync/status handles missing/legacy config fields by returning safe defaults.

    # Arrange
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    monkeypatch.setattr(
        "codemem.viewer.load_config",
        lambda: type(
            "Cfg",
            (),
            {
                "sync_enabled": True,
                "sync_host": "127.0.0.1",
                "sync_port": 7337,
                "sync_interval_s": 60,
            },
        )(),
    )
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        # Act
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/status")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))

        # Assert
        assert resp.status == 200
        assert payload.get("project_filter") == {"include": [], "exclude": []}
    finally:
        server.shutdown()


def test_sync_peers_list_endpoint(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
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
        assert items[0]["addresses"] == []
        assert payload.get("redacted") is True

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/peers?includeDiagnostics=1")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        items = payload.get("items") or []
        assert items[0]["addresses"]
        assert payload.get("redacted") is False
    finally:
        server.shutdown()


def test_sync_peers_rename(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
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
            headers={
                "Content-Type": "application/json",
                "Origin": "http://127.0.0.1:38888",
            },
        )
        resp = conn.getresponse()
        assert resp.status == 200
    finally:
        server.shutdown()


def test_sync_rejects_cross_origin(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
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


def test_sync_rejects_spoofed_loopback_origin(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
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
            headers={
                "Content-Type": "application/json",
                "Origin": "http://127.0.0.1.evil.invalid",
            },
        )
        resp = conn.getresponse()
        assert resp.status == 403
    finally:
        server.shutdown()


def test_sync_rejects_missing_origin_for_mutating_post(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
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
        assert resp.status == 403
    finally:
        server.shutdown()


def test_sync_delete_rejects_missing_origin_for_mutating_delete(
    tmp_path: Path, monkeypatch
) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
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
        conn.request(
            "DELETE",
            "/api/sync/peers/peer-1",
            headers={},
        )
        resp = conn.getresponse()
        assert resp.status == 403
    finally:
        server.shutdown()


def test_sync_now_rejects_when_disabled(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    monkeypatch.setattr(
        "codemem.viewer.load_config", lambda: type("Cfg", (), {"sync_enabled": False})()
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
            headers={
                "Content-Type": "application/json",
                "Origin": "http://127.0.0.1:38888",
            },
        )
        resp = conn.getresponse()
        assert resp.status == 403
    finally:
        server.shutdown()


def test_sync_pairing_payload(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    keys_dir = tmp_path / "keys"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    monkeypatch.setenv("CODEMEM_KEYS_DIR", str(keys_dir))
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
        assert payload.get("redacted") is True
        assert "only control what it sends to peers" in str(
            payload.get("pairing_filter_hint") or ""
        )

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/pairing?includeDiagnostics=1")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert payload.get("device_id")
        assert payload.get("public_key")
        addresses = payload.get("addresses")
        assert isinstance(addresses, list)
        assert addresses
        assert all(":" in str(item) for item in addresses)
        assert all("#" not in str(item) for item in addresses)
        assert payload.get("public_key") != "[redacted]"
        assert "does not yet enforce incoming project filters" in str(
            payload.get("pairing_filter_hint") or ""
        )
    finally:
        server.shutdown()


def test_sync_attempts_rejects_invalid_limit(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            """
            INSERT INTO sync_attempts(peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("peer-1", 1, None, "2026-01-24T00:00:00Z", "2026-01-24T00:00:01Z", 1, 1),
        )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/attempts?limit=wat")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 400
        assert payload == {"error": "invalid_limit"}
    finally:
        server.shutdown()


def test_sync_attempts_rejects_non_positive_limit(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            """
            INSERT INTO sync_attempts(peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("peer-1", 1, None, "2026-01-24T00:00:00Z", "2026-01-24T00:00:01Z", 1, 1),
        )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        for query in ("0", "-1"):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
            conn.request("GET", f"/api/sync/attempts?limit={query}")
            resp = conn.getresponse()
            payload = json.loads(resp.read().decode("utf-8"))
            assert resp.status == 400
            assert payload == {"error": "invalid_limit"}
    finally:
        server.shutdown()


def test_sync_attempts_clamps_large_limit(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        for idx in range(3):
            conn.execute(
                """
                INSERT INTO sync_attempts(peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    f"peer-{idx}",
                    1,
                    None,
                    "2026-01-24T00:00:00Z",
                    f"2026-01-24T00:00:0{idx}Z",
                    1,
                    1,
                ),
            )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/attempts?limit=999999")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert len(payload.get("items") or []) == 3
    finally:
        server.shutdown()


def test_sync_attempts_boundary_limit_and_clamp(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        for idx in range(520):
            conn.execute(
                """
                INSERT INTO sync_attempts(peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    f"peer-{idx}",
                    1,
                    None,
                    "2026-01-24T00:00:00Z",
                    f"2026-01-24T00:{idx // 60:02d}:{idx % 60:02d}Z",
                    1,
                    1,
                ),
            )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/attempts?limit=500")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert len(payload.get("items") or []) == 500

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/attempts?limit=501")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert len(payload.get("items") or []) == 500
    finally:
        server.shutdown()


def test_sync_attempts_rejects_invalid_limit_query(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            """
            INSERT INTO sync_attempts(peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("peer-1", 1, None, "2026-01-24T00:00:00Z", "2026-01-24T00:00:01Z", 1, 1),
        )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/attempts?limit=wat")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 400
        assert payload == {"error": "invalid_limit"}
    finally:
        server.shutdown()


def test_sync_attempts_clamps_large_limit_query(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        for idx in range(3):
            conn.execute(
                """
                INSERT INTO sync_attempts(peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    f"peer-{idx}",
                    1,
                    None,
                    "2026-01-24T00:00:00Z",
                    f"2026-01-24T00:00:0{idx}Z",
                    1,
                    1,
                ),
            )
        conn.commit()
    finally:
        conn.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/sync/attempts?limit=999999")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert len(payload.get("items") or []) == 3
    finally:
        server.shutdown()
