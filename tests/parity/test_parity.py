"""Parity test runner — validates store methods against golden JSON fixtures.

Builds the same deterministic seed database used by generate_fixtures.py,
loads each fixture JSON, runs the method with the fixture's input, and
asserts the output matches.

Run:
    CODEMEM_EMBEDDING_DISABLED=1 uv run pytest tests/parity/test_parity.py -v

If fixtures are missing, run the generator first:
    CODEMEM_EMBEDDING_DISABLED=1 uv run python tests/parity/generate_fixtures.py
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from codemem.store import MemoryStore  # noqa: E402

from .generate_fixtures import (  # noqa: E402
    FIXTURES_DIR,
    build_seed_database,
)

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _parity_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set device ID and disable embeddings for parity tests without leaking."""
    monkeypatch.setenv("CODEMEM_DEVICE_ID", "device-local-001")
    monkeypatch.setenv("CODEMEM_EMBEDDING_DISABLED", "1")


@pytest.fixture()
def seed_store(tmp_path: Path) -> MemoryStore:
    """Build the deterministic seed database and return the store.

    Each test gets its own isolated copy.
    """
    db_path = tmp_path / "parity_seed.sqlite"
    store, memory_ids, session_ids = build_seed_database(db_path)
    # Attach helpers for tests that need IDs
    store._parity_memory_ids = memory_ids  # type: ignore[attr-defined]
    store._parity_session_ids = session_ids  # type: ignore[attr-defined]
    yield store
    store.close()


def _load_fixture(name: str) -> dict[str, Any]:
    path = FIXTURES_DIR / f"{name}.json"
    if not path.exists():
        pytest.skip(
            f"Fixture {path.name} not found — run: "
            "CODEMEM_EMBEDDING_DISABLED=1 uv run python tests/parity/generate_fixtures.py"
        )
    return json.loads(path.read_text())


# ---------------------------------------------------------------------------
# Search tests
# ---------------------------------------------------------------------------


class TestSearch:
    def test_search_memory_layer(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("search_memory_layer")
        inp = fixture["input"]
        results = seed_store.search(inp["query"], limit=inp["limit"])

        expected = fixture["expected_output"]
        assert len(results) == expected["count"]
        assert [r.id for r in results] == expected["ordered_ids"]

        for actual, exp in zip(results, expected["results"], strict=True):
            assert actual.id == exp["id"]
            assert actual.kind == exp["kind"]
            assert actual.title == exp["title"]
            assert actual.score >= exp["score_gte"]

    def test_search_refactor(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("search_refactor")
        inp = fixture["input"]
        results = seed_store.search(inp["query"], limit=inp["limit"])

        expected = fixture["expected_output"]
        assert len(results) == expected["count"]
        assert [r.id for r in results] == expected["ordered_ids"]

        for actual, exp in zip(results, expected["results"], strict=True):
            assert actual.id == exp["id"]
            assert actual.kind == exp["kind"]
            assert actual.score >= exp["score_gte"]


# ---------------------------------------------------------------------------
# Timeline tests
# ---------------------------------------------------------------------------


class TestTimeline:
    def test_timeline_memory(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("timeline_memory")
        inp = fixture["input"]
        results = seed_store.timeline(
            query=inp["query"],
            memory_id=inp.get("memory_id"),
            depth_before=inp.get("depth_before", 3),
            depth_after=inp.get("depth_after", 3),
        )

        expected = fixture["expected_output"]
        assert len(results) == expected["count"]
        assert [r["id"] for r in results] == expected["ordered_ids"]

        for actual, exp in zip(results, expected["results"], strict=True):
            assert actual["id"] == exp["id"]
            assert actual["kind"] == exp["kind"]


# ---------------------------------------------------------------------------
# Recent tests
# ---------------------------------------------------------------------------


class TestRecent:
    def test_recent_limit5(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("recent_limit5")
        inp = fixture["input"]
        results = seed_store.recent(limit=inp["limit"])

        expected = fixture["expected_output"]
        assert len(results) == expected["count"]
        assert [r["id"] for r in results] == expected["ordered_ids"]

    def test_recent_kind_discovery(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("recent_kind_discovery")
        inp = fixture["input"]
        results = seed_store.recent(limit=inp["limit"], filters=inp["filters"])

        expected = fixture["expected_output"]
        assert len(results) == expected["count"]
        assert [r["id"] for r in results] == expected["ordered_ids"]
        assert all(r["kind"] == "discovery" for r in results)


# ---------------------------------------------------------------------------
# Get tests
# ---------------------------------------------------------------------------


class TestGet:
    def test_get_existing(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("get_existing")
        inp = fixture["input"]
        result = seed_store.get(inp["memory_id"])

        expected = fixture["expected_output"]
        assert expected["found"] is True
        assert result is not None
        assert result["id"] == expected["id"]
        assert result["kind"] == expected["kind"]
        assert result["title"] == expected["title"]
        assert result["body_text"] == expected["body_text"]
        assert result["active"] == expected["active"]
        assert result["confidence"] == pytest.approx(expected["confidence"], abs=0.01)
        assert result.get("tags_text", "") == expected.get("tags_text", "")
        assert result.get("visibility") == expected.get("visibility")
        assert result.get("workspace_kind") == expected.get("workspace_kind")

    def test_get_missing(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("get_missing")
        inp = fixture["input"]
        result = seed_store.get(inp["memory_id"])

        expected = fixture["expected_output"]
        assert expected["found"] is False
        assert result is None


# ---------------------------------------------------------------------------
# Explain tests
# ---------------------------------------------------------------------------


class TestExplain:
    def test_explain_memory(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("explain_memory")
        inp = fixture["input"]
        result = seed_store.explain(
            query=inp["query"],
            ids=inp.get("ids"),
            limit=inp.get("limit", 10),
            filters=inp.get("filters"),
        )

        expected = fixture["expected_output"]
        items = result.get("items", [])
        assert len(items) == expected["item_count"]
        assert result.get("missing_ids", []) == expected["missing_ids"]
        assert [item["id"] for item in items] == expected["ordered_ids"]

        for actual, exp in zip(items, expected["items"], strict=True):
            assert actual["id"] == exp["id"]
            assert actual["kind"] == exp["kind"]
            assert actual["retrieval"]["source"] == exp["retrieval_source"]
            # Score components should be non-negative
            if actual["score"]["total"] is not None:
                assert actual["score"]["total"] >= exp["score_total_gte"]
            if actual["score"]["components"]["base"] is not None:
                assert actual["score"]["components"]["base"] >= exp["score_components"]["base_gte"]


# ---------------------------------------------------------------------------
# Remember tests
# ---------------------------------------------------------------------------


class TestRemember:
    def test_remember(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("remember")
        inp = fixture["input"]
        session_ids = seed_store._parity_session_ids  # type: ignore[attr-defined]
        mid = seed_store.remember(
            session_ids[0],  # Use the first session
            kind=inp["kind"],
            title=inp["title"],
            body_text=inp["body_text"],
            confidence=inp["confidence"],
            tags=inp.get("tags"),
            metadata=inp.get("metadata"),
        )

        expected = fixture["expected_output"]
        assert mid > expected["id_gt"]

        stored = seed_store.get(mid)
        assert stored is not None
        assert expected["stored"] is True
        assert stored["kind"] == expected["kind"]
        assert stored["title"] == expected["title"]
        assert stored["body_text"] == expected["body_text"]
        assert stored["active"] == expected["active"]
        assert stored.get("visibility") == expected["visibility"]


# ---------------------------------------------------------------------------
# Forget tests
# ---------------------------------------------------------------------------


class TestForget:
    def test_forget(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("forget")
        # Use a seed memory to test forget — pick the last active memory
        memory_ids = seed_store._parity_memory_ids  # type: ignore[attr-defined]
        mid = memory_ids[-1]

        before = seed_store.get(mid)
        assert before is not None

        expected = fixture["expected_output"]
        assert before["active"] == expected["before_active"]

        seed_store.forget(mid)
        after = seed_store.get(mid)
        assert after is not None
        assert after["active"] == expected["after_active"]
        assert (after.get("deleted_at") is not None) == expected["after_deleted_at_present"]


# ---------------------------------------------------------------------------
# Recent by kinds tests
# ---------------------------------------------------------------------------


class TestRecentByKinds:
    def test_recent_by_kinds(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("recent_by_kinds")
        inp = fixture["input"]
        results = seed_store.recent_by_kinds(inp["kinds"], limit=inp["limit"])

        expected = fixture["expected_output"]
        assert len(results) == expected["count"]
        assert [r["id"] for r in results] == expected["ordered_ids"]
        assert expected["all_kinds_valid"] is True
        assert all(r["kind"] in ("discovery", "change") for r in results)


# ---------------------------------------------------------------------------
# Stats tests
# ---------------------------------------------------------------------------


class TestStats:
    def test_stats(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("stats")
        stats = seed_store.stats()

        expected = fixture["expected_output"]
        assert expected["has_database_key"] is True
        assert "database" in stats
        assert expected["has_usage_key"] is True
        assert "usage" in stats

        db_section = stats.get("database", {})
        assert sorted(db_section.keys()) == expected["database_keys"]
        assert db_section.get("memory_items", 0) >= expected["database_total_memories_gte"]
        assert db_section.get("active_memory_items", 0) >= expected["database_active_memories_gte"]


# ---------------------------------------------------------------------------
# Update visibility tests
# ---------------------------------------------------------------------------


class TestUpdateVisibility:
    def test_update_visibility(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("update_visibility")
        memory_ids = seed_store._parity_memory_ids  # type: ignore[attr-defined]
        inp = fixture["input"]

        # The fixture targets memory index 3 (the private feature memory)
        target_id = memory_ids[3]

        before = seed_store.get(target_id)
        assert before is not None

        expected = fixture["expected_output"]
        assert before.get("visibility") == expected["before_visibility"]

        updated = seed_store.update_memory_visibility(target_id, visibility=inp["visibility"])
        assert updated.get("visibility") == expected["after_visibility"]
        assert updated.get("workspace_kind") == expected["after_workspace_kind"]


# ---------------------------------------------------------------------------
# Pack tests
# ---------------------------------------------------------------------------


class TestPack:
    def test_pack_memory_layer(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("pack_memory_layer")
        inp = fixture["input"]
        pack = seed_store.build_memory_pack(inp["context"], limit=inp["limit"], log_usage=False)

        expected = fixture["expected_output"]
        assert pack["context"] == expected["context"]
        assert expected["has_items"] is True
        assert len(pack.get("items", [])) >= expected["item_count_gte"]
        assert bool(pack.get("pack_text")) == expected["has_pack_text"]
        assert bool(pack.get("metrics")) == expected["has_metrics"]


# ---------------------------------------------------------------------------
# Multi-filter tests
# ---------------------------------------------------------------------------


class TestMultiFilter:
    def test_search_visibility_kind_filter(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("search_visibility_kind_filter")
        inp = fixture["input"]
        results = list(seed_store.search(inp["query"], limit=inp["limit"], filters=inp["filters"]))

        expected = fixture["expected_output"]
        assert len(results) == expected["count"]
        if results:
            assert all(r.kind == "discovery" for r in results)

    def test_recent_kind_change_filter(self, seed_store: MemoryStore) -> None:
        fixture = _load_fixture("recent_kind_change_filter")
        inp = fixture["input"]
        results = seed_store.recent(limit=inp["limit"], filters=inp["filters"])

        expected = fixture["expected_output"]
        assert len(results) == expected["count"]
        if results:
            assert all(r.get("kind") == "change" for r in results)
