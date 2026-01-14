from pathlib import Path

from opencode_mem import store as store_module
from opencode_mem.store import MemoryStore


def test_insert_and_search(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    mid = store.remember(
        session,
        kind="observation",
        title="Added login endpoint",
        body_text="Implemented login endpoint for auth",
    )
    store.end_session(session)

    results = store.search("login", limit=5)
    assert results, "Expected search results"
    assert results[0].id == mid
    pack = store.build_memory_pack("login work", limit=3)
    assert any("login" in item["body"] for item in pack["items"])


def test_recent_filters(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    store.remember(session, kind="observation", title="Alpha", body_text="Alpha body")
    store.remember(session, kind="decision", title="Beta", body_text="Beta body")
    store.end_session(session)

    observations = store.recent(limit=10, filters={"kind": "observation"})
    assert len(observations) == 1
    assert observations[0]["kind"] == "observation"


def test_usage_stats(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    store.remember(
        session,
        kind="note",
        title="Alpha",
        body_text="Alpha body text that should count",
    )
    store.remember(
        session, kind="note", title="Beta", body_text="Beta body text that should count"
    )
    store.end_session(session)

    store.search("Alpha", limit=5)
    store.build_memory_pack("Alpha", limit=5, token_budget=8)

    stats = store.stats()
    usage = {event["event"]: event for event in stats["usage"]["events"]}

    assert usage["search"]["count"] == 1
    assert usage["pack"]["count"] == 1
    assert usage["search"]["tokens_read"] > 0
    assert usage["pack"]["tokens_read"] > 0


def test_pack_reuse_savings(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    metadata = {"discovery_tokens": 120}
    store.remember(
        session,
        kind="note",
        title="Alpha",
        body_text="Shared body content one",
        metadata=metadata,
    )
    store.remember(
        session,
        kind="note",
        title="Beta",
        body_text="Shared body content two",
        metadata=metadata,
    )
    store.end_session(session)

    store.build_memory_pack("Shared body", limit=5)

    stats = store.stats()
    usage = {event["event"]: event for event in stats["usage"]["events"]}
    assert usage["pack"]["tokens_saved"] > 0


def test_deactivate_low_signal_observations(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    store.remember(session, kind="observation", title="List ls", body_text="List ls")
    store.remember(
        session,
        kind="observation",
        title="Updated viewer",
        body_text="Updated viewer layout",
    )
    store.end_session(session)

    preview = store.deactivate_low_signal_observations(dry_run=True)
    assert preview["deactivated"] == 1

    result = store.deactivate_low_signal_observations()
    assert result["deactivated"] == 1

    observations = store.recent(limit=10, filters={"kind": "observation"})
    assert len(observations) == 1
    assert observations[0]["title"] == "Updated viewer"


def test_project_filters(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    alpha = store.start_session(
        cwd="/tmp/alpha",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/alpha",
    )
    beta = store.start_session(
        cwd="/tmp/beta",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/beta",
    )
    store.remember(alpha, kind="note", title="Alpha", body_text="Alpha only")
    store.remember(beta, kind="note", title="Beta", body_text="Beta only")
    store.end_session(alpha)
    store.end_session(beta)

    alpha_results = store.search("only", limit=10, filters={"project": "/tmp/alpha"})
    beta_results = store.search("only", limit=10, filters={"project": "/tmp/beta"})
    assert len(alpha_results) == 1
    assert len(beta_results) == 1
    assert alpha_results[0].body_text == "Alpha only"
    assert beta_results[0].body_text == "Beta only"


def test_project_basename_filters(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    store.remember(session, kind="note", title="Alpha", body_text="Alpha only")
    store.end_session(session)

    search_results = store.search("Alpha", limit=5, filters={"project": "project-a"})
    recent_results = store.recent(limit=5, filters={"project": "project-a"})

    assert len(search_results) == 1
    assert len(recent_results) == 1


def test_pack_falls_back_to_recent_for_tasks(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    store.remember(session, kind="note", title="Alpha", body_text="Alpha body")
    store.end_session(session)

    pack = store.build_memory_pack(
        "pending tasks", limit=5, filters={"project": "/tmp/project-a"}
    )

    assert any(item["body"] == "Alpha body" for item in pack["items"])


def test_pack_recall_prefers_recent_session_summaries(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    store.remember(
        session,
        kind="session_summary",
        title="Session summary",
        body_text="Worked on viewer filters",
    )
    store.remember(session, kind="note", title="Note", body_text="Minor note")
    store.end_session(session)

    pack = store.build_memory_pack(
        "what did we do last time", limit=3, filters={"project": "/tmp/project-a"}
    )

    assert pack["items"]
    assert pack["items"][0]["kind"] == "session_summary"


def test_pack_fuzzy_fallback_on_typos(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    store.remember(
        session, kind="note", title="Memory pack", body_text="Memory pack improvements"
    )
    store.end_session(session)

    pack = store.build_memory_pack(
        "memry pakc", limit=5, filters={"project": "/tmp/project-a"}
    )

    assert any("Memory pack improvements" in item["body"] for item in pack["items"])


def test_pack_reranks_by_recency(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    old_id = store.remember(
        session, kind="note", title="Alpha", body_text="Update search ranking"
    )
    new_id = store.remember(
        session, kind="note", title="Beta", body_text="Update search ranking"
    )
    store.conn.execute(
        "UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?",
        ("2020-01-01T00:00:00", "2020-01-01T00:00:00", old_id),
    )
    store.conn.commit()
    store.end_session(session)

    pack = store.build_memory_pack(
        "search ranking", limit=2, filters={"project": "/tmp/project-a"}
    )

    assert pack["items"][0]["id"] == new_id


def test_pack_recall_uses_timeline(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    first_id = store.remember(
        session, kind="note", title="First", body_text="Alpha task"
    )
    summary_id = store.remember(
        session,
        kind="session_summary",
        title="Session summary",
        body_text="Beta work completed",
    )
    last_id = store.remember(
        session, kind="note", title="Last", body_text="Gamma follow-up"
    )
    store.conn.execute(
        "UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?",
        ("2020-01-01T00:00:00", "2020-01-01T00:00:00", first_id),
    )
    store.conn.execute(
        "UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?",
        ("2020-01-02T00:00:00", "2020-01-02T00:00:00", summary_id),
    )
    store.conn.execute(
        "UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?",
        ("2020-01-03T00:00:00", "2020-01-03T00:00:00", last_id),
    )
    store.conn.commit()
    store.end_session(session)

    pack = store.build_memory_pack(
        "recap beta", limit=3, filters={"project": "/tmp/project-a"}
    )

    assert [item["id"] for item in pack["items"]] == [first_id, summary_id, last_id]


def test_search_index_and_timeline(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    first_id = store.remember(
        session, kind="note", title="Alpha", body_text="Alpha context"
    )
    anchor_id = store.remember(
        session, kind="note", title="Beta", body_text="Beta context"
    )
    last_id = store.remember(
        session, kind="note", title="Gamma", body_text="Gamma context"
    )
    store.end_session(session)

    index = store.search_index("Beta", limit=5, filters={"project": "/tmp/project-a"})
    assert index
    assert index[0]["id"] == anchor_id

    timeline = store.timeline(
        memory_id=anchor_id,
        depth_before=1,
        depth_after=1,
        filters={"project": "/tmp/project-a"},
    )
    assert [item["id"] for item in timeline] == [first_id, anchor_id, last_id]


def test_pack_semantic_fallback(monkeypatch, tmp_path: Path) -> None:
    class FakeEmbeddingClient:
        def embed(self, texts):
            vectors = []
            for text in texts:
                lowered = text.lower()
                if "alpha" in lowered or "alfa" in lowered:
                    vectors.append([1.0, 0.0])
                else:
                    vectors.append([0.0, 1.0])
            return vectors

    monkeypatch.setattr(
        store_module, "get_embedding_client", lambda: FakeEmbeddingClient()
    )

    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    store.remember(session, kind="note", title="Alpha memory", body_text="Alpha recall")
    store.remember(session, kind="note", title="Beta memory", body_text="Beta recall")
    store.end_session(session)

    pack = store.build_memory_pack(
        "alfa", limit=1, filters={"project": "/tmp/project-a"}
    )

    assert pack["items"][0]["title"] == "Alpha memory"
