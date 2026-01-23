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
    assert "## Summary" in pack["pack_text"]
    assert "## Timeline" in pack["pack_text"]
    assert "## Observations" in pack["pack_text"]
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
    store.remember(session, kind="note", title="Beta", body_text="Beta body text that should count")
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
    """Test the deactivation mechanism works - with empty patterns, nothing is deactivated."""
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

    # With empty LOW_SIGNAL patterns, nothing should be deactivated
    preview = store.deactivate_low_signal_observations(dry_run=True)
    assert preview["deactivated"] == 0

    result = store.deactivate_low_signal_observations()
    assert result["deactivated"] == 0

    # Both observations should remain active
    observations = store.recent(limit=10, filters={"kind": "observation"})
    assert len(observations) == 2


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

    pack = store.build_memory_pack("pending tasks", limit=5, filters={"project": "/tmp/project-a"})

    assert "## Timeline" in pack["pack_text"]
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
    assert "## Summary" in pack["pack_text"]


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
    store.remember(session, kind="note", title="Memory pack", body_text="Memory pack improvements")
    store.end_session(session)

    pack = store.build_memory_pack("memry pakc", limit=5, filters={"project": "/tmp/project-a"})

    assert "## Observations" in pack["pack_text"]
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
    old_id = store.remember(session, kind="note", title="Alpha", body_text="Update search ranking")
    new_id = store.remember(session, kind="note", title="Beta", body_text="Update search ranking")
    store.conn.execute(
        "UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?",
        ("2020-01-01T00:00:00", "2020-01-01T00:00:00", old_id),
    )
    store.conn.commit()
    store.end_session(session)

    pack = store.build_memory_pack("search ranking", limit=2, filters={"project": "/tmp/project-a"})

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
    first_id = store.remember(session, kind="note", title="First", body_text="Alpha task")
    summary_id = store.remember(
        session,
        kind="session_summary",
        title="Session summary",
        body_text="Beta work completed",
    )
    last_id = store.remember(session, kind="note", title="Last", body_text="Gamma follow-up")
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

    pack = store.build_memory_pack("recap beta", limit=3, filters={"project": "/tmp/project-a"})

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
    first_id = store.remember(session, kind="note", title="Alpha", body_text="Alpha context")
    anchor_id = store.remember(session, kind="note", title="Beta", body_text="Beta context")
    last_id = store.remember(session, kind="note", title="Gamma", body_text="Gamma context")
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

    monkeypatch.setattr(store_module, "get_embedding_client", lambda: FakeEmbeddingClient())

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

    pack = store.build_memory_pack("alfa", limit=1, filters={"project": "/tmp/project-a"})

    assert pack["items"][0]["title"] == "Alpha memory"


def test_pack_limit_is_per_project(tmp_path: Path) -> None:
    """Ensure pack limit applies independently to each project."""
    store = MemoryStore(tmp_path / "mem.sqlite")

    # Create 60 memories in project-a
    session_a = store.start_session(
        cwd="/tmp/a",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    for i in range(60):
        store.remember(session_a, kind="note", title=f"A-{i}", body_text=f"Project A memory {i}")
    store.end_session(session_a)

    # Create 60 memories in project-b
    session_b = store.start_session(
        cwd="/tmp/b",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-b",
    )
    for i in range(60):
        store.remember(session_b, kind="note", title=f"B-{i}", body_text=f"Project B memory {i}")
    store.end_session(session_b)

    # Pack with limit=50 for project-a should get at most 50 from project-a
    pack_a = store.build_memory_pack("memory", limit=50, filters={"project": "/tmp/project-a"})
    a_items = pack_a["items"]
    assert len(a_items) <= 50, f"Expected at most 50 items from project-a, got {len(a_items)}"
    for item in a_items:
        assert "Project A" in item["body"], f"Expected project-a memory, got: {item['body']}"

    # Pack with limit=50 for project-b should get at most 50 from project-b
    pack_b = store.build_memory_pack("memory", limit=50, filters={"project": "/tmp/project-b"})
    b_items = pack_b["items"]
    assert len(b_items) <= 50, f"Expected at most 50 items from project-b, got {len(b_items)}"
    for item in b_items:
        assert "Project B" in item["body"], f"Expected project-b memory, got: {item['body']}"

    # Pack without project filter should get memories from both projects
    pack_all = store.build_memory_pack("memory", limit=50)
    all_items = pack_all["items"]
    assert len(all_items) <= 50, f"Expected at most 50 items total, got {len(all_items)}"
    assert len(all_items) > 0, "Expected some items in unfiltered pack"


def test_remember_observation_populates_tags_text(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    memory_id = store.remember_observation(
        session,
        kind="discovery",
        title="Investigated tagging",
        narrative="Found that tags_text was empty.",
        concepts=["postgres indexing"],
        files_modified=["opencode_mem/store.py"],
    )
    store.end_session(session)

    row = store.conn.execute(
        "SELECT tags_text FROM memory_items WHERE id = ?",
        (memory_id,),
    ).fetchone()
    assert row is not None
    tags_text = str(row["tags_text"] or "")
    assert "postgres-indexing" in tags_text


def test_search_finds_by_tag_only(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    memory_id = store.remember(
        session,
        kind="note",
        title="Unrelated",
        body_text="Nothing about databases here.",
        tags=["postgres"],
    )
    store.end_session(session)

    results = store.search("postgres", limit=5)
    assert any(result.id == memory_id for result in results)


def test_backfill_tags_text_is_idempotent(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    memory_id = store.remember(session, kind="note", title="Alpha", body_text="Alpha body")
    store.end_session(session)

    result = store.backfill_tags_text()
    assert result["updated"] == 1

    result2 = store.backfill_tags_text()
    assert result2["updated"] == 0

    row = store.conn.execute(
        "SELECT tags_text FROM memory_items WHERE id = ?",
        (memory_id,),
    ).fetchone()
    assert row is not None
    assert str(row["tags_text"] or "") != ""


def test_backfill_tags_text_dry_run_does_not_modify(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    memory_id = store.remember(session, kind="note", title="Alpha", body_text="Alpha body")
    store.end_session(session)

    result = store.backfill_tags_text(dry_run=True)
    assert result["updated"] == 1

    row = store.conn.execute(
        "SELECT tags_text FROM memory_items WHERE id = ?",
        (memory_id,),
    ).fetchone()
    assert row is not None
    assert str(row["tags_text"] or "") == ""


def test_record_raw_event_is_idempotent(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    inserted = store.record_raw_event(
        opencode_session_id="sess-123",
        event_seq=1,
        event_type="tool.execute.after",
        payload={"hello": "world"},
        ts_wall_ms=123,
        ts_mono_ms=456.0,
    )
    assert inserted is True
    inserted2 = store.record_raw_event(
        opencode_session_id="sess-123",
        event_seq=1,
        event_type="tool.execute.after",
        payload={"hello": "world"},
        ts_wall_ms=124,
        ts_mono_ms=457.0,
    )
    assert inserted2 is False

    row = store.conn.execute(
        "SELECT COUNT(*) AS n FROM raw_events WHERE opencode_session_id = ?",
        ("sess-123",),
    ).fetchone()
    assert row is not None
    assert int(row["n"]) == 1
