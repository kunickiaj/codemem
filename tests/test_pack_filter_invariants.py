from __future__ import annotations

from pathlib import Path

import opencode_mem.store as store_module
from opencode_mem.store import MemoryStore


def test_pack_project_filter_is_subset(monkeypatch, tmp_path: Path) -> None:
    class FakeEmbeddingClient:
        def embed(self, texts):
            return [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr(store_module, "get_embedding_client", lambda: FakeEmbeddingClient())

    store = MemoryStore(tmp_path / "mem.sqlite")
    a = store.start_session(
        cwd="/tmp/a",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    a_id = store.remember(a, kind="note", title="Alpha", body_text="Alpha A")
    store.end_session(a)

    b = store.start_session(
        cwd="/tmp/b",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-b",
    )
    store.remember(b, kind="note", title="Alpha", body_text="Alpha B")
    store.end_session(b)

    pack_all = store.build_memory_pack("alpha", limit=10)
    all_ids = {item.get("id") for item in pack_all.get("items", [])}

    pack_a = store.build_memory_pack("alpha", limit=10, filters={"project": "/tmp/project-a"})
    a_ids = {item.get("id") for item in pack_a.get("items", [])}

    assert a_id in a_ids
    assert a_ids.issubset(all_ids)
