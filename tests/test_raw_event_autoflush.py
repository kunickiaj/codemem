from __future__ import annotations

import http.client
import json
import threading
from http.server import HTTPServer
from pathlib import Path
from unittest.mock import MagicMock, patch

from codemem.store import MemoryStore
from codemem.viewer import ViewerHandler


def test_raw_events_autoflush_updates_flush_state(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    monkeypatch.setenv("CODEMEM_RAW_EVENTS_AUTO_FLUSH", "1")
    monkeypatch.setenv("CODEMEM_RAW_EVENTS_DEBOUNCE_MS", "0")

    mock_response = MagicMock()
    mock_response.parsed.observations = []
    mock_response.parsed.summary = None
    mock_response.parsed.skip_summary_reason = None

    with (
        patch("codemem.plugin_ingest.OBSERVER") as observer,
        patch("codemem.plugin_ingest.capture_pre_context") as pre,
        patch("codemem.plugin_ingest.capture_post_context") as post,
    ):
        observer.observe.return_value = mock_response
        pre.return_value = {"project": "test"}
        post.return_value = {"git_diff": "", "recent_files": ""}

        server = HTTPServer(("127.0.0.1", 0), ViewerHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = int(server.server_address[1])
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            events = [
                {
                    "opencode_session_id": "sess-af",
                    "event_id": "evt-0",
                    "event_seq": 0,
                    "event_type": "user_prompt",
                    "payload": {"type": "user_prompt", "prompt_text": "Hello"},
                    "ts_wall_ms": 100,
                },
                {
                    "opencode_session_id": "sess-af",
                    "event_id": "evt-1",
                    "event_seq": 1,
                    "event_type": "tool.execute.after",
                    "payload": {
                        "type": "tool.execute.after",
                        "tool": "read",
                        "args": {"filePath": "x"},
                    },
                    "ts_wall_ms": 200,
                },
            ]
            body = {
                "cwd": str(tmp_path),
                "project": "test-project",
                "started_at": "2026-01-01T00:00:00Z",
                "events": events,
            }
            conn.request(
                "POST",
                "/api/raw-events",
                body=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
            resp = conn.getresponse()
            assert resp.status == 200
            resp.read()
            conn.close()

            store = MemoryStore(db_path)
            try:
                assert store.raw_event_flush_state("sess-af") == 1
            finally:
                store.close()
        finally:
            server.shutdown()
