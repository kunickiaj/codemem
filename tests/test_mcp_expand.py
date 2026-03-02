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


def _seed_two_projects(db_path: Path) -> tuple[int, int, int]:
    store = MemoryStore(db_path)
    session_a = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    memory_a1 = store.remember(session_a, kind="note", title="A1", body_text="A1 body")
    memory_a2 = store.remember(session_a, kind="note", title="A2", body_text="A2 body")
    store.end_session(session_a)

    session_b = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-b",
    )
    memory_b1 = store.remember(session_b, kind="note", title="B1", body_text="B1 body")
    store.end_session(session_b)
    store.close()
    return memory_a1, memory_a2, memory_b1


def test_memory_expand_tool_is_registered(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CODEMEM_DB", str(tmp_path / "mem.sqlite"))
    server = build_server()
    tools = asyncio.run(server.list_tools())

    names = {tool.name for tool in tools}
    assert "memory_expand" in names


def test_memory_expand_dedupes_ids_and_keeps_input_order(tmp_path: Path, monkeypatch) -> None:
    db_path = tmp_path / "mem.sqlite"
    memory_a1, memory_a2, _memory_b1 = _seed_two_projects(db_path)
    monkeypatch.setenv("CODEMEM_DB", str(db_path))

    server = build_server()
    payload = _call_tool(
        server,
        "memory_expand",
        {
            "ids": [memory_a2, memory_a1, memory_a2],
            "project": "/tmp/project-a",
        },
    )

    assert [item["id"] for item in payload["anchors"]] == [memory_a2, memory_a1]
    assert payload["missing_ids"] == []
    assert payload["observations"] == []
    assert payload["errors"] == []


def test_memory_expand_reports_invalid_missing_and_project_mismatch(
    tmp_path: Path, monkeypatch
) -> None:
    db_path = tmp_path / "mem.sqlite"
    memory_a1, _memory_a2, memory_b1 = _seed_two_projects(db_path)
    monkeypatch.setenv("CODEMEM_DB", str(db_path))

    server = build_server()
    payload = _call_tool(
        server,
        "memory_expand",
        {
            "ids": [memory_a1, memory_b1, 999999, "bad", True],
            "project": "/tmp/project-a",
            "include_observations": True,
        },
    )

    assert [item["id"] for item in payload["anchors"]] == [memory_a1]
    assert payload["missing_ids"] == [memory_b1, 999999]
    assert payload["observations"][0]["id"] == memory_a1
    assert all("id" in item and "session_id" in item for item in payload["timeline"])
    assert all("id" in item and "body_text" in item for item in payload["observations"])
    errors_by_code = {error["code"]: error for error in payload["errors"]}
    assert set(errors_by_code) == {"INVALID_ARGUMENT", "NOT_FOUND", "PROJECT_MISMATCH"}
    assert errors_by_code["INVALID_ARGUMENT"]["ids"] == ["bad", "True"]
    assert errors_by_code["NOT_FOUND"]["ids"] == [999999]
    assert errors_by_code["PROJECT_MISMATCH"]["ids"] == [memory_b1]


def test_memory_expand_uses_default_project_scope_when_project_omitted(
    tmp_path: Path, monkeypatch
) -> None:
    db_path = tmp_path / "mem.sqlite"
    memory_a1, _memory_a2, memory_b1 = _seed_two_projects(db_path)
    monkeypatch.setenv("CODEMEM_DB", str(db_path))
    monkeypatch.setenv("CODEMEM_PROJECT", "/tmp/project-a")

    server = build_server()
    payload = _call_tool(server, "memory_expand", {"ids": [memory_a1, memory_b1]})

    assert [item["id"] for item in payload["anchors"]] == [memory_a1]
    assert payload["missing_ids"] == [memory_b1]
    assert {error["code"] for error in payload["errors"]} == {"PROJECT_MISMATCH"}
    assert payload["metadata"]["project"] == "/tmp/project-a"
    assert payload["metadata"]["requested_ids_count"] == 2
    assert payload["metadata"]["returned_anchor_count"] == 1
