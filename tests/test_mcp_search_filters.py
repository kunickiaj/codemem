from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from codemem.mcp_server import build_server
from codemem.store import MemoryStore


def _call_tool(server: Any, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    _content, structured = asyncio.run(server.call_tool(name, arguments))
    assert isinstance(structured, dict)
    return structured


def _seed_actor_scoped_memories(db_path: Path) -> tuple[str, int, int]:
    store = MemoryStore(db_path)
    actor_id = store.actor_id
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    personal_id = store.remember(session, kind="note", title="Alpha", body_text="Local alpha")
    shared_id = store.remember(
        session,
        kind="note",
        title="Alpha",
        body_text="Shared alpha",
        metadata={
            "actor_id": "actor:teammate",
            "actor_display_name": "Teammate",
            "workspace_id": "shared:team-alpha",
            "workspace_kind": "shared",
        },
    )
    store.end_session(session)
    store.close()
    return actor_id, personal_id, shared_id


def test_memory_search_supports_actor_and_workspace_filters(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    actor_id, personal_id, shared_id = _seed_actor_scoped_memories(db_path)
    monkeypatch.setenv("CODEMEM_DB", str(db_path))

    server = build_server()
    shared_only = _call_tool(
        server,
        "memory_search",
        {
            "query": "alpha",
            "project": "/tmp/project-a",
            "include_workspace_kinds": ["shared"],
            "personal_first": False,
        },
    )
    personal_only = _call_tool(
        server,
        "memory_search",
        {
            "query": "alpha",
            "project": "/tmp/project-a",
            "include_actor_ids": [actor_id],
        },
    )

    assert [item["id"] for item in shared_only["items"]] == [shared_id]
    assert shared_only["items"][0]["metadata"]["workspace_kind"] == "shared"
    assert [item["id"] for item in personal_only["items"]] == [personal_id]


def test_memory_pack_supports_workspace_filters(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    _actor_id, _personal_id, shared_id = _seed_actor_scoped_memories(db_path)
    monkeypatch.setenv("CODEMEM_DB", str(db_path))

    server = build_server()
    payload = _call_tool(
        server,
        "memory_pack",
        {
            "context": "alpha",
            "project": "/tmp/project-a",
            "include_workspace_kinds": ["shared"],
            "personal_first": False,
        },
    )

    assert [item["id"] for item in payload["items"]] == [shared_id]
    assert payload["items"][0]["metadata"]["workspace_kind"] == "shared"
