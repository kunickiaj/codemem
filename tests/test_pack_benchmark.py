from __future__ import annotations

from pathlib import Path

from opencode_mem.pack_benchmark import read_queries, run_pack_benchmark
from opencode_mem.store import MemoryStore


def test_read_queries_filters_comments() -> None:
    text = """
    # comment

    first query
    second query
    """
    assert read_queries(text) == ["first query", "second query"]


def test_pack_benchmark_does_not_record_usage(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd=str(tmp_path),
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    store.remember(
        session,
        kind="discovery",
        title="Vector search",
        body_text="Notes on sqlite vector recall.",
        tags=["sqlite", "vector"],
    )
    store.end_session(session)

    before = store.conn.execute(
        "SELECT COUNT(*) AS n FROM usage_events WHERE event = 'pack'",
    ).fetchone()[0]
    result = run_pack_benchmark(
        store,
        queries=["sqlite vector"],
        limit=3,
        token_budget=None,
        filters=None,
    )
    after = store.conn.execute(
        "SELECT COUNT(*) AS n FROM usage_events WHERE event = 'pack'",
    ).fetchone()[0]
    assert int(before) == int(after)
    assert result["summary"]["queries"] == 1
    assert result["results"][0]["query"] == "sqlite vector"
    assert "compression_ratio" in result["summary"]
    assert "avoided_work_saved" in result["summary"]
