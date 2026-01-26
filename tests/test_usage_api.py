import json
from http.server import HTTPServer
from pathlib import Path
from threading import Thread

from opencode_mem import db
from opencode_mem.viewer import ViewerHandler


def _get_json(url: str) -> dict:
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(url) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8")
        raise AssertionError(f"HTTP {exc.code}: {body}") from exc


def test_api_usage_totals_respect_project_filter(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
        conn.execute(
            "INSERT INTO sessions(id, started_at, project) VALUES (1, '2026-01-01T00:00:00Z', 'opencode-mem')"
        )
        conn.execute(
            "INSERT INTO sessions(id, started_at, project) VALUES (2, '2026-01-01T00:00:00Z', 'dotfiles')"
        )
        conn.execute(
            """
            INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
            VALUES (1, 'pack', 10, 0, 5, '2026-01-01T00:00:01Z', ?)
            """,
            (json.dumps({"project": "opencode-mem"}),),
        )
        conn.execute(
            """
            INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
            VALUES (2, 'pack', 20, 0, 7, '2026-01-01T00:00:02Z', ?)
            """,
            (json.dumps({"project": "dotfiles"}),),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    monkeypatch.setenv("OPENCODE_MEM_VIEWER_DEBUG", "1")
    httpd = HTTPServer(("127.0.0.1", 0), ViewerHandler)
    port = httpd.server_port
    thread = Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        global_payload = _get_json(f"http://127.0.0.1:{port}/api/usage")
        assert global_payload["project"] is None
        assert global_payload["totals"]["tokens_read"] == 30

        filtered = _get_json(f"http://127.0.0.1:{port}/api/usage?project=opencode-mem")
        assert filtered["project"] == "opencode-mem"
        assert filtered["totals"]["tokens_read"] == 10
        assert filtered["totals_global"]["tokens_read"] == 30
        packs = filtered.get("recent_packs") or []
        assert all(
            (row.get("metadata_json") or {}).get("project") == "opencode-mem" for row in packs
        )
    finally:
        httpd.shutdown()


def test_normalize_projects_rewrites_usage_event_project(tmp_path: Path) -> None:
    store_db = tmp_path / "mem.sqlite"
    conn = db.connect(store_db)
    try:
        db.initialize_schema(conn)
        conn.execute(
            """
            INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
            VALUES (NULL, 'pack', 0, 0, 0, '2026-01-01T00:00:00Z', ?)
            """,
            (json.dumps({"project": "/Users/adam/workspace/opencode-mem"}),),
        )
        conn.commit()
    finally:
        conn.close()

    from opencode_mem.store import MemoryStore

    store = MemoryStore(store_db)
    try:
        preview = store.normalize_projects(dry_run=True)
        assert preview["usage_events_to_update"] == 1
        store.normalize_projects(dry_run=False)
        row = store.conn.execute(
            "SELECT metadata_json FROM usage_events WHERE event = 'pack' LIMIT 1"
        ).fetchone()
        meta = json.loads(row["metadata_json"])
        assert meta["project"] == "opencode-mem"
    finally:
        store.close()
