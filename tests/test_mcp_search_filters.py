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
    personal_id = store.remember(
        session,
        kind="note",
        title="Alpha",
        body_text="Local alpha",
        metadata={"visibility": "private"},
    )
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


def test_memory_search_reports_widened_shared_results(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    _actor_id, personal_id, shared_id = _seed_actor_scoped_memories(db_path)
    monkeypatch.setenv("CODEMEM_DB", str(db_path))

    server = build_server()
    payload = _call_tool(
        server,
        "memory_search",
        {
            "query": "alpha",
            "project": "/tmp/project-a",
            "limit": 1,
            "widen_shared_when_weak": True,
        },
    )

    assert [item["id"] for item in payload["items"]] == [personal_id, shared_id]
    assert payload["items"][0]["metadata"]["widened_from_shared"] is False
    assert payload["items"][1]["metadata"]["widened_from_shared"] is True
    assert payload["widening"]["widening_applied"] is True


def test_memory_search_supports_trust_filters_and_bias(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    store = MemoryStore(db_path)
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    trusted_id = store.remember(
        session,
        kind="note",
        title="Shared auth flow",
        body_text="Trusted shared details",
        metadata={
            "actor_id": "actor:trusted",
            "actor_display_name": "Trusted teammate",
            "workspace_id": "shared:team-alpha",
            "workspace_kind": "shared",
            "visibility": "shared",
            "trust_state": "trusted",
        },
    )
    legacy_id = store.remember(
        session,
        kind="note",
        title="Shared auth flow",
        body_text="Legacy shared details",
        metadata={
            "actor_id": "actor:legacy",
            "actor_display_name": "Legacy teammate",
            "workspace_id": "shared:team-alpha",
            "workspace_kind": "shared",
            "visibility": "shared",
            "trust_state": "legacy_unknown",
        },
    )
    store.end_session(session)
    store.conn.execute(
        "UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?",
        ("2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00", trusted_id),
    )
    store.conn.execute(
        "UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?",
        ("2026-01-02T00:00:00+00:00", "2026-01-02T00:00:00+00:00", legacy_id),
    )
    store.conn.commit()
    store.close()
    monkeypatch.setenv("CODEMEM_DB", str(db_path))

    server = build_server()
    filtered = _call_tool(
        server,
        "memory_search",
        {
            "query": "shared auth flow",
            "project": "/tmp/project-a",
            "include_trust_states": ["legacy_unknown"],
            "personal_first": False,
        },
    )
    ranked = _call_tool(
        server,
        "memory_search",
        {
            "query": "shared auth flow",
            "project": "/tmp/project-a",
            "personal_first": False,
            "trust_bias": "soft",
        },
    )

    assert [item["id"] for item in filtered["items"]] == [legacy_id]
    assert [item["id"] for item in ranked["items"]] == [trusted_id, legacy_id]


def test_memory_pack_reports_widened_shared_items(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    store = MemoryStore(db_path)
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    personal_id = store.remember(session, kind="note", title="Alpha", body_text="Local alpha")
    personal_id_2 = store.remember(
        session, kind="note", title="Alpha", body_text="Second local alpha"
    )
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
            "visibility": "shared",
        },
    )
    store.end_session(session)
    store.close()
    monkeypatch.setenv("CODEMEM_DB", str(db_path))

    server = build_server()
    payload = _call_tool(
        server,
        "memory_pack",
        {
            "context": "alpha",
            "project": "/tmp/project-a",
            "limit": 2,
            "widen_shared_when_weak": True,
        },
    )

    returned_ids = {item["id"] for item in payload["items"]}
    assert personal_id in returned_ids or personal_id_2 in returned_ids
    assert shared_id in returned_ids
    assert payload["metrics"]["widening_applied"] is True
    assert payload["metrics"]["widened_shared_items"] >= 1
