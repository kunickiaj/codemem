from __future__ import annotations

from pathlib import Path
from typing import Any

from codemem.store import MemoryStore
from codemem.viewer_routes import memory


class DummyHandler:
    def __init__(self) -> None:
        self.response: dict[str, Any] | None = None
        self.status: int | None = None

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        self.response = payload
        self.status = status


def _seed_items(store: MemoryStore, *, kind: str, count: int) -> None:
    row = store.conn.execute(
        """
        INSERT INTO sessions(started_at, cwd, project, user, tool_version)
        VALUES (?, ?, ?, ?, ?)
        """,
        ("2026-01-01T00:00:00Z", "/tmp/work", "proj", "tester", "test"),
    )
    session_id = int(row.lastrowid or 0)
    for index in range(count):
        timestamp = f"2026-01-01T00:00:{index:02d}Z"
        store.conn.execute(
            """
            INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (session_id, kind, f"{kind}-{index}", f"body-{index}", timestamp, timestamp),
        )
    store.conn.commit()


def test_observations_endpoint_supports_offset_pagination(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        _seed_items(store, kind="bugfix", count=5)
        handler = DummyHandler()

        handled = memory.handle_get(handler, store, "/api/observations", "limit=2&offset=0")

        assert handled is True
        assert handler.status == 200
        assert handler.response is not None
        assert len(handler.response["items"]) == 2
        assert handler.response["pagination"] == {
            "limit": 2,
            "offset": 0,
            "next_offset": 2,
            "has_more": True,
        }

        next_handler = DummyHandler()
        handled = memory.handle_get(next_handler, store, "/api/observations", "limit=2&offset=4")

        assert handled is True
        assert next_handler.status == 200
        assert next_handler.response is not None
        assert len(next_handler.response["items"]) == 1
        assert next_handler.response["pagination"] == {
            "limit": 2,
            "offset": 4,
            "next_offset": None,
            "has_more": False,
        }
    finally:
        store.close()


def test_summaries_endpoint_supports_offset_pagination(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        _seed_items(store, kind="session_summary", count=3)
        handler = DummyHandler()

        handled = memory.handle_get(handler, store, "/api/summaries", "limit=2&offset=0")

        assert handled is True
        assert handler.status == 200
        assert handler.response is not None
        assert len(handler.response["items"]) == 2
        assert handler.response["pagination"] == {
            "limit": 2,
            "offset": 0,
            "next_offset": 2,
            "has_more": True,
        }
    finally:
        store.close()


def test_observations_endpoint_rejects_invalid_pagination_params(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        handler = DummyHandler()

        handled = memory.handle_get(handler, store, "/api/observations", "limit=abc&offset=0")

        assert handled is True
        assert handler.status == 400
        assert handler.response == {"error": "limit and offset must be int"}
    finally:
        store.close()


def test_observations_endpoint_supports_scope_filter(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        session = store.start_session(
            cwd="/tmp/work",
            git_remote=None,
            git_branch="main",
            user="tester",
            tool_version="test",
            project="proj",
        )
        mine_id = store.remember(session, kind="bugfix", title="Mine", body_text="Local note")
        shared_id = store.remember(
            session,
            kind="bugfix",
            title="Shared",
            body_text="Shared note",
            metadata={
                "actor_id": "actor:teammate",
                "actor_display_name": "Teammate",
                "visibility": "shared",
                "workspace_id": "shared:team-alpha",
                "workspace_kind": "shared",
            },
        )
        store.end_session(session)

        mine_handler = DummyHandler()
        handled = memory.handle_get(mine_handler, store, "/api/observations", "scope=mine")
        assert handled is True
        assert mine_handler.status == 200
        assert mine_handler.response is not None
        assert [item["id"] for item in mine_handler.response["items"]] == [mine_id]

        shared_handler = DummyHandler()
        handled = memory.handle_get(shared_handler, store, "/api/observations", "scope=shared")
        assert handled is True
        assert shared_handler.status == 200
        assert shared_handler.response is not None
        assert [item["id"] for item in shared_handler.response["items"]] == [shared_id]

        theirs_handler = DummyHandler()
        handled = memory.handle_get(theirs_handler, store, "/api/observations", "scope=theirs")
        assert handled is True
        assert theirs_handler.status == 200
        assert theirs_handler.response is not None
        assert [item["id"] for item in theirs_handler.response["items"]] == [shared_id]
    finally:
        store.close()


def test_observations_endpoint_rejects_invalid_scope(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        handler = DummyHandler()

        handled = memory.handle_get(handler, store, "/api/observations", "scope=nope")

        assert handled is True
        assert handler.status == 400
        assert handler.response == {"error": "invalid_scope"}
    finally:
        store.close()
