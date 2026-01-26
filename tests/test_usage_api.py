import http.client
import json
import threading
from http.server import HTTPServer
from pathlib import Path

from opencode_mem import db
from opencode_mem.store import MemoryStore
from opencode_mem.viewer import ViewerHandler


def _start_server(db_path: Path) -> tuple[HTTPServer, int]:
    server = HTTPServer(("127.0.0.1", 0), ViewerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, int(server.server_address[1])


def test_usage_endpoint_respects_project_filter(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))

    store = MemoryStore(db_path)
    try:
        session_a = store.start_session(
            cwd="/tmp",
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project-a",
        )
        store.end_session(session_a)
        session_b = store.start_session(
            cwd="/tmp",
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project-b",
        )
        store.end_session(session_b)

        store.record_usage(
            "pack",
            tokens_read=10,
            tokens_saved=3,
            metadata={"project": "/tmp/project-a", "items": 2},
        )
        store.record_usage("search", tokens_read=7, metadata={"project": "/tmp/project-a"})
        store.record_usage(
            "pack",
            tokens_read=20,
            tokens_saved=5,
            metadata={"project": "/tmp/project-b", "items": 4},
        )
        store.record_usage("search", tokens_read=9, metadata={"project": "/tmp/project-b"})
    finally:
        store.close()

    server, port = _start_server(db_path)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/api/usage?project=project-a")
        resp = conn.getresponse()
        payload = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200

        totals = payload.get("totals") or {}
        totals_global = payload.get("totals_global") or {}
        totals_filtered = payload.get("totals_filtered") or {}

        assert totals_global["events"] == 4
        assert totals_filtered["events"] == 2
        assert totals["events"] == 2

        assert totals_filtered["tokens_read"] == 17
        assert totals_global["tokens_read"] == 46
    finally:
        server.shutdown()


def test_normalize_projects_rewrites_usage_event_projects(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    store = MemoryStore(db_path)
    try:
        store.record_usage(
            "pack",
            tokens_read=10,
            tokens_saved=3,
            metadata={"project": "/tmp/project-a", "items": 2},
        )
        preview = store.normalize_projects(dry_run=True)
        assert preview.get("usage_events_to_update") == 1
        store.normalize_projects(dry_run=False)

        row = store.conn.execute(
            "SELECT metadata_json FROM usage_events WHERE event = 'pack' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        assert row is not None
        metadata = db.from_json(row["metadata_json"])
        assert metadata.get("project") == "project-a"
    finally:
        store.close()
