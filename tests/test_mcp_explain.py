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


def _seed_store_for_query_and_ids(db_path: Path) -> tuple[int, int]:
    store = MemoryStore(db_path)
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    memory_query = store.remember(
        session,
        kind="decision",
        title="Cache tuning decision",
        body_text="Picked cache tuning strategy",
    )
    memory_id_only = store.remember(
        session,
        kind="note",
        title="Follow-up",
        body_text="Review benchmark numbers",
    )
    store.end_session(session)
    store.close()
    return memory_query, memory_id_only


def test_memory_explain_tool_is_registered(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CODEMEM_DB", str(tmp_path / "mem.sqlite"))

    server = build_server()
    tools = asyncio.run(server.list_tools())

    names = {tool.name for tool in tools}
    assert "memory_explain" in names


def test_memory_explain_combines_query_and_ids(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    memory_query, memory_id_only = _seed_store_for_query_and_ids(db_path)
    monkeypatch.setenv("CODEMEM_DB", str(db_path))

    server = build_server()
    payload = _call_tool(
        server,
        "memory_explain",
        {
            "query": "cache tuning",
            "ids": [memory_query, memory_id_only],
            "project": "/tmp/project-a",
        },
    )

    assert [item["id"] for item in payload["items"]] == [memory_query, memory_id_only]
    assert payload["items"][0]["retrieval"] == {"source": "query+id_lookup", "rank": 1}
    assert payload["items"][1]["retrieval"] == {"source": "id_lookup", "rank": None}
    assert payload["errors"] == []


def test_memory_explain_reports_missing_and_project_mismatch(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    store = MemoryStore(db_path)
    session_a = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    memory_a = store.remember(session_a, kind="note", title="A", body_text="A body")
    store.end_session(session_a)
    session_b = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-b",
    )
    memory_b = store.remember(session_b, kind="note", title="B", body_text="B body")
    store.end_session(session_b)
    store.close()

    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    server = build_server()
    payload = _call_tool(
        server,
        "memory_explain",
        {
            "ids": [memory_a, memory_b, 999999],
            "project": "project-a",
        },
    )

    assert [item["id"] for item in payload["items"]] == [memory_a]
    assert payload["missing_ids"] == [memory_b, 999999]
    assert {error["code"] for error in payload["errors"]} == {"NOT_FOUND", "PROJECT_MISMATCH"}


def test_memory_explain_requires_query_or_ids(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CODEMEM_DB", str(tmp_path / "mem.sqlite"))

    server = build_server()
    payload = _call_tool(server, "memory_explain", {})

    assert payload["items"] == []
    assert payload["missing_ids"] == []
    assert any(error["field"] == "query" for error in payload["errors"])


def test_memory_explain_include_pack_context_shape(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    _memory_query, memory_id_only = _seed_store_for_query_and_ids(db_path)
    monkeypatch.setenv("CODEMEM_DB", str(db_path))

    server = build_server()
    payload = _call_tool(
        server,
        "memory_explain",
        {
            "ids": [memory_id_only],
            "include_pack_context": True,
            "project": "/tmp/project-a",
        },
    )

    pack_context = payload["items"][0]["pack_context"]
    assert isinstance(pack_context, dict)
    assert pack_context["included"] is None
    assert pack_context["section"] is None
    assert payload["metadata"]["include_pack_context"] is True
    assert payload["errors"] == []


def test_memory_explain_uses_default_project_scope_when_project_omitted(
    tmp_path: Path, monkeypatch
) -> None:
    db_path = tmp_path / "mem.sqlite"
    store = MemoryStore(db_path)
    session_a = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    memory_a = store.remember(session_a, kind="note", title="A", body_text="A body")
    store.end_session(session_a)
    session_b = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-b",
    )
    memory_b = store.remember(session_b, kind="note", title="B", body_text="B body")
    store.end_session(session_b)
    store.close()

    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    monkeypatch.setenv("CODEMEM_PROJECT", "/tmp/project-a")
    server = build_server()

    payload = _call_tool(
        server,
        "memory_explain",
        {
            "ids": [memory_a, memory_b],
        },
    )

    assert [item["id"] for item in payload["items"]] == [memory_a]
    assert payload["missing_ids"] == [memory_b]
    assert {error["code"] for error in payload["errors"]} == {"PROJECT_MISMATCH"}
    mismatch = next(error for error in payload["errors"] if error["code"] == "PROJECT_MISMATCH")
    assert mismatch["ids"] == [memory_b]
