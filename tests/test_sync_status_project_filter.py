import json
from http.server import HTTPServer
from pathlib import Path
from threading import Thread

from opencode_mem import db
from opencode_mem.viewer import ViewerHandler


def test_sync_status_includes_project_filter(tmp_path: Path, monkeypatch) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({"sync_enabled": True, "sync_projects_include": ["opencode-mem"]}) + "\n"
    )
    monkeypatch.setenv("OPENCODE_MEM_CONFIG", str(config_path))

    db_path = tmp_path / "mem.sqlite"
    conn = db.connect(db_path)
    try:
        db.initialize_schema(conn)
    finally:
        conn.close()
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))

    httpd = HTTPServer(("127.0.0.1", 0), ViewerHandler)
    port = httpd.server_port
    thread = Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        import urllib.request

        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/sync/status") as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        pf = payload.get("project_filter")
        assert pf is not None
        assert pf.get("include") == ["opencode-mem"]
    finally:
        httpd.shutdown()
