"""Generate language-neutral golden fixtures for store parity testing.

Creates a deterministic seed database and captures the exact behavior
of critical MemoryStore methods as JSON fixtures.  Both the Python
implementation and any future TypeScript port must produce identical
results against these fixtures.

Usage:
    CODEMEM_EMBEDDING_DISABLED=1 uv run python tests/parity/generate_fixtures.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from codemem import db  # noqa: E402
from codemem.store import MemoryStore  # noqa: E402

FIXTURES_DIR = Path(__file__).parent / "fixtures"
SEED_VERSION = "seed_v1"

# ---------------------------------------------------------------------------
# Fixed timestamps — deterministic, no time.time() anywhere
# ---------------------------------------------------------------------------
FIXED_TIMESTAMPS = [
    "2026-01-10T10:00:00+00:00",
    "2026-01-10T10:05:00+00:00",
    "2026-01-10T10:10:00+00:00",
    "2026-01-10T10:15:00+00:00",
    "2026-01-10T10:20:00+00:00",
    "2026-01-10T10:25:00+00:00",
    "2026-01-10T10:30:00+00:00",
    "2026-01-10T10:35:00+00:00",
    "2026-01-10T10:40:00+00:00",
    "2026-01-10T10:45:00+00:00",
    "2026-01-10T10:50:00+00:00",
    "2026-01-10T10:55:00+00:00",
]

# ---------------------------------------------------------------------------
# Seed data definitions
# ---------------------------------------------------------------------------
SESSIONS = [
    {
        "cwd": "/home/dev/alpha-project",
        "project": "alpha-project",
        "git_remote": "git@github.com:team/alpha.git",
        "git_branch": "main",
        "user": "alice",
        "tool_version": "parity-test-v1",
    },
    {
        "cwd": "/home/dev/beta-service",
        "project": "beta-service",
        "git_remote": "git@github.com:team/beta.git",
        "git_branch": "feature/api",
        "user": "alice",
        "tool_version": "parity-test-v1",
    },
    {
        "cwd": "/home/dev/gamma-lib",
        "project": "gamma-lib",
        "git_remote": None,
        "git_branch": "develop",
        "user": "bob",
        "tool_version": "parity-test-v1",
    },
]

# Memories: (session_index, kind, title, body, confidence, tags, visibility, active)
MEMORIES = [
    # session 0 — alpha-project
    (
        0,
        "discovery",
        "Discovered memory layer architecture",
        "The memory layer uses SQLite FTS5 for full-text search with BM25 ranking. "
        "Vectors are stored in sqlite-vec for semantic recall. "
        "The store exposes search, timeline, and pack operations.",
        0.8,
        ["architecture", "sqlite", "fts5"],
        "shared",
        True,
    ),
    (
        0,
        "change",
        "Refactored search ranking pipeline",
        "Moved BM25 reranking into a separate module. "
        "Added recency decay and kind bonus to the scoring formula. "
        "Search results now include metadata provenance fields.",
        0.7,
        ["search", "ranking"],
        "shared",
        True,
    ),
    (
        0,
        "decision",
        "Chose SQLite over PostgreSQL for embedded storage",
        "SQLite was chosen because it runs in-process, needs no server, "
        "and supports FTS5 natively. WAL mode provides concurrency for the viewer.",
        0.9,
        ["database", "sqlite"],
        "shared",
        True,
    ),
    (
        0,
        "feature",
        "Implemented memory pack builder",
        "Pack builder aggregates search results into a context window. "
        "Includes deduplication, token budgeting, and work-investment metrics. "
        "Memory layer packs are the primary retrieval interface for agents.",
        0.75,
        ["pack", "context"],
        "private",
        True,
    ),
    # session 1 — beta-service
    (
        1,
        "bugfix",
        "Fixed memory search returning stale results",
        "The FTS index was not being updated after memory deactivation. "
        "Added a trigger to sync the FTS table on UPDATE. "
        "Search now correctly excludes deactivated memories.",
        0.85,
        ["search", "bugfix", "fts"],
        "shared",
        True,
    ),
    (
        1,
        "refactor",
        "Extracted replication module from store",
        "Moved all replication logic (clock comparison, op recording, "
        "apply-ops) into store/replication.py. "
        "The main store now delegates to the replication submodule.",
        0.7,
        ["refactor", "replication"],
        "shared",
        True,
    ),
    (
        1,
        "exploration",
        "Explored vector quantization for memory embeddings",
        "Tested int8 quantization for sqlite-vec embeddings. "
        "Precision loss was acceptable for top-10 recall. "
        "Did not ship — decided to keep float32 for now.",
        0.5,
        ["vectors", "exploration"],
        "shared",
        True,
    ),
    (
        1,
        "discovery",
        "Found memory layer performance bottleneck",
        "Timeline queries were scanning all memories instead of using the session index. "
        "Adding a session_id filter reduced query time from 200ms to 15ms.",
        0.8,
        ["performance", "timeline"],
        "private",
        True,
    ),
    # session 2 — gamma-lib (actor: bob / remote peer)
    (
        2,
        "change",
        "Updated memory schema for identity columns",
        "Added actor_id, visibility, workspace_id, workspace_kind, "
        "origin_device_id, origin_source, trust_state columns to memory_items. "
        "These enable multi-device sync and sharing controls.",
        0.7,
        ["schema", "identity"],
        "shared",
        True,
    ),
    (
        2,
        "note",
        "Memory layer testing strategy",
        "Unit tests cover store roundtrips, search ranking, and replication. "
        "Parity fixtures capture behavior for cross-language porting. "
        "Integration tests use tmp_path for isolated databases.",
        0.6,
        ["testing", "parity"],
        "shared",
        True,
    ),
    # Deactivated memory
    (
        0,
        "observation",
        "Obsolete memory layer observation",
        "This observation was superseded by later discoveries. "
        "It should not appear in active search or recent results.",
        0.3,
        [],
        "shared",
        False,
    ),
    # Another private memory
    (
        2,
        "decision",
        "Private decision about gamma-lib API surface",
        "Decided to keep the gamma-lib API minimal and not expose internal helpers. "
        "This is a private decision scoped to personal workspace.",
        0.65,
        ["api", "design"],
        "private",
        True,
    ),
]

REMOTE_ACTOR_ID = "actor:bob-remote-001"
REMOTE_ACTOR_NAME = "Bob (remote)"


def _write_fixture(name: str, data: dict[str, Any]) -> None:
    """Write a single fixture file as pretty-printed JSON."""
    path = FIXTURES_DIR / f"{name}.json"
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str) + "\n")
    print(f"  wrote {path.relative_to(Path.cwd())}")


def build_seed_database(db_path: Path) -> tuple[MemoryStore, list[int], list[int]]:
    """Create the deterministic seed database and return (store, memory_ids, session_ids)."""
    store = MemoryStore(db_path)

    # Create remote actor
    store.create_actor(display_name=REMOTE_ACTOR_NAME, actor_id=REMOTE_ACTOR_ID)

    # Create a sync peer assigned to the remote actor
    now_iso = FIXED_TIMESTAMPS[0]
    store.conn.execute(
        """
        INSERT INTO sync_peers(peer_device_id, name, addresses_json, actor_id,
                               claimed_local_actor, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        ("device-remote-bob", "bob-laptop", "[]", REMOTE_ACTOR_ID, 0, now_iso),
    )
    store.conn.commit()

    # Create sessions
    session_ids: list[int] = []
    for sess_def in SESSIONS:
        sid = store.start_session(
            cwd=sess_def["cwd"],
            project=sess_def["project"],
            git_remote=sess_def["git_remote"],
            git_branch=sess_def["git_branch"],
            user=sess_def["user"],
            tool_version=sess_def["tool_version"],
        )
        session_ids.append(sid)

    # Insert memories with deterministic timestamps via direct SQL
    # (store.remember uses _now_iso which is non-deterministic)
    memory_ids: list[int] = []
    for idx, mem_def in enumerate(MEMORIES):
        sess_idx, kind, title, body, confidence, tags, visibility, active = mem_def
        session_id = session_ids[sess_idx]
        ts = FIXED_TIMESTAMPS[idx]
        tags_text = " ".join(sorted(set(tags)))

        # Determine actor based on session
        if sess_idx == 2:
            actor_id = REMOTE_ACTOR_ID
            actor_display_name = REMOTE_ACTOR_NAME
        else:
            actor_id = store.actor_id
            actor_display_name = store.actor_display_name

        workspace_kind = "personal" if visibility == "private" else "shared"
        workspace_id = f"personal:{actor_id}" if visibility == "private" else "shared:default"

        metadata = {
            "clock_device_id": store.device_id,
            "visibility": visibility,
        }
        import_key = f"parity-fixture-{idx:03d}"

        cur = store.conn.execute(
            """
            INSERT INTO memory_items(
                session_id, kind, title, body_text, confidence, tags_text,
                active, created_at, updated_at, metadata_json,
                actor_id, actor_display_name, visibility,
                workspace_id, workspace_kind,
                origin_device_id, origin_source, trust_state,
                user_prompt_id, deleted_at, rev, import_key
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                kind,
                title,
                body,
                confidence,
                tags_text,
                1 if active else 0,
                ts,
                ts,
                db.to_json(metadata),
                actor_id,
                actor_display_name,
                visibility,
                workspace_id,
                workspace_kind,
                store.device_id if sess_idx != 2 else "device-remote-bob",
                None,
                "trusted",
                None,
                None if active else ts,
                1,
                import_key,
            ),
        )
        lastrowid = cur.lastrowid
        assert lastrowid is not None
        memory_ids.append(lastrowid)
    store.conn.commit()

    # Insert a few replication ops
    for i, _mid in enumerate(memory_ids[:3]):
        store.conn.execute(
            """
            INSERT INTO replication_ops(
                op_id, entity_type, entity_id, op_type,
                payload_json, clock_rev, clock_updated_at, clock_device_id,
                device_id, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"op-parity-{i:03d}",
                "memory_item",
                f"parity-fixture-{i:03d}",
                "upsert",
                db.to_json({"title": MEMORIES[i][2]}),
                1,
                FIXED_TIMESTAMPS[i],
                store.device_id,
                store.device_id,
                FIXED_TIMESTAMPS[i],
            ),
        )
    store.conn.commit()

    # Insert raw event sessions + events
    for i in range(2):
        stream_id = f"parity-stream-{i:03d}"
        store.conn.execute(
            """
            INSERT INTO raw_event_sessions(
                source, stream_id, opencode_session_id,
                last_received_event_seq, last_flushed_event_seq,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            ("opencode", stream_id, stream_id, 5, 3, FIXED_TIMESTAMPS[i]),
        )
        for seq in range(3):
            store.conn.execute(
                """
                INSERT INTO raw_events(
                    source, stream_id, opencode_session_id,
                    event_id, event_seq, event_type,
                    ts_wall_ms, payload_json, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "opencode",
                    stream_id,
                    stream_id,
                    f"evt-{i}-{seq}",
                    seq,
                    "tool_use",
                    1704067200000 + (i * 1000) + seq,
                    db.to_json({"tool": "read", "seq": seq}),
                    FIXED_TIMESTAMPS[i],
                ),
            )
    store.conn.commit()

    # Insert usage events
    for event_name in ("search", "pack", "get"):
        store.conn.execute(
            """
            INSERT INTO usage_events(event, tokens_read, tokens_written,
                                     tokens_saved, created_at, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (event_name, 100, 0, 20, FIXED_TIMESTAMPS[0], db.to_json({})),
        )
    store.conn.commit()

    return store, memory_ids, session_ids


def generate_search_fixtures(store: MemoryStore, memory_ids: list[int]) -> None:
    """Capture search behavior."""
    # Search 1: "memory layer"
    results = store.search("memory layer", limit=10)
    _write_fixture(
        "search_memory_layer",
        {
            "method": "search",
            "description": "FTS search for 'memory layer'",
            "seed_db": SEED_VERSION,
            "input": {"query": "memory layer", "limit": 10, "filters": None},
            "expected_output": {
                "count": len(results),
                "results": [
                    {
                        "id": r.id,
                        "kind": r.kind,
                        "title": r.title,
                        "score_gte": 0.0,
                    }
                    for r in results
                ],
                "ordered_ids": [r.id for r in results],
            },
        },
    )

    # Search 2: "refactor"
    results2 = store.search("refactor", limit=10)
    _write_fixture(
        "search_refactor",
        {
            "method": "search",
            "description": "FTS search for 'refactor'",
            "seed_db": SEED_VERSION,
            "input": {"query": "refactor", "limit": 10, "filters": None},
            "expected_output": {
                "count": len(results2),
                "results": [
                    {
                        "id": r.id,
                        "kind": r.kind,
                        "title": r.title,
                        "score_gte": 0.0,
                    }
                    for r in results2
                ],
                "ordered_ids": [r.id for r in results2],
            },
        },
    )


def generate_timeline_fixture(store: MemoryStore) -> None:
    """Capture timeline behavior."""
    results = store.timeline(query="memory")
    _write_fixture(
        "timeline_memory",
        {
            "method": "timeline",
            "description": "Timeline anchored on query 'memory'",
            "seed_db": SEED_VERSION,
            "input": {
                "query": "memory",
                "memory_id": None,
                "depth_before": 3,
                "depth_after": 3,
            },
            "expected_output": {
                "count": len(results),
                "ordered_ids": [r["id"] for r in results],
                "results": [
                    {
                        "id": r["id"],
                        "kind": r["kind"],
                        "title": r["title"],
                    }
                    for r in results
                ],
            },
        },
    )


def generate_recent_fixtures(store: MemoryStore) -> None:
    """Capture recent with and without filters."""
    # recent(limit=5)
    results = store.recent(limit=5)
    _write_fixture(
        "recent_limit5",
        {
            "method": "recent",
            "description": "Recent memories, limit=5, no filters",
            "seed_db": SEED_VERSION,
            "input": {"limit": 5, "filters": None},
            "expected_output": {
                "count": len(results),
                "ordered_ids": [r["id"] for r in results],
                "results": [
                    {"id": r["id"], "kind": r["kind"], "title": r["title"]} for r in results
                ],
            },
        },
    )

    # recent(limit=5, filters={"kind": "discovery"})
    results2 = store.recent(limit=5, filters={"kind": "discovery"})
    _write_fixture(
        "recent_kind_discovery",
        {
            "method": "recent",
            "description": "Recent memories filtered to kind=discovery",
            "seed_db": SEED_VERSION,
            "input": {"limit": 5, "filters": {"kind": "discovery"}},
            "expected_output": {
                "count": len(results2),
                "ordered_ids": [r["id"] for r in results2],
                "results": [
                    {"id": r["id"], "kind": r["kind"], "title": r["title"]} for r in results2
                ],
            },
        },
    )


def generate_get_fixtures(store: MemoryStore, memory_ids: list[int]) -> None:
    """Capture get for existing and non-existing IDs."""
    existing_id = memory_ids[0]
    result = store.get(existing_id)
    assert result is not None, f"Expected memory {existing_id} to exist"
    _write_fixture(
        "get_existing",
        {
            "method": "get",
            "description": f"Get memory with id={existing_id}",
            "seed_db": SEED_VERSION,
            "input": {"memory_id": existing_id},
            "expected_output": {
                "found": True,
                "id": result["id"],
                "kind": result["kind"],
                "title": result["title"],
                "body_text": result["body_text"],
                "active": result["active"],
                "confidence": result["confidence"],
                "tags_text": result.get("tags_text", ""),
                "visibility": result.get("visibility"),
                "workspace_kind": result.get("workspace_kind"),
            },
        },
    )

    # Non-existing ID
    missing_id = 99999
    _result_missing = store.get(missing_id)
    _write_fixture(
        "get_missing",
        {
            "method": "get",
            "description": f"Get memory with non-existing id={missing_id}",
            "seed_db": SEED_VERSION,
            "input": {"memory_id": missing_id},
            "expected_output": {"found": False},
        },
    )


def generate_explain_fixture(store: MemoryStore) -> None:
    """Capture explain behavior."""
    result = store.explain(query="memory")
    items = result.get("items", [])
    _write_fixture(
        "explain_memory",
        {
            "method": "explain",
            "description": "Explain scores for query 'memory'",
            "seed_db": SEED_VERSION,
            "input": {
                "query": "memory",
                "ids": None,
                "limit": 10,
                "filters": None,
            },
            "expected_output": {
                "item_count": len(items),
                "missing_ids": result.get("missing_ids", []),
                "errors": result.get("errors", []),
                "items": [
                    {
                        "id": item["id"],
                        "kind": item["kind"],
                        "title": item["title"],
                        "retrieval_source": item["retrieval"]["source"],
                        "score_total_gte": 0.0,
                        "score_components": {
                            "base_gte": 0.0,
                            "recency_gte": 0.0,
                            "kind_bonus_gte": 0.0,
                        },
                    }
                    for item in items
                ],
                "ordered_ids": [item["id"] for item in items],
            },
        },
    )


def generate_remember_fixture(store: MemoryStore, session_ids: list[int]) -> None:
    """Capture remember behavior."""
    session_id = session_ids[0]
    mid = store.remember(
        session_id,
        kind="note",
        title="Parity fixture remember test",
        body_text="This memory was created by the fixture generator to test remember().",
        confidence=0.6,
        tags=["parity", "test"],
        metadata={"visibility": "shared", "import_key": "parity-remember-test"},
    )
    # Verify it was stored
    result = store.get(mid)
    assert result is not None, f"Expected memory {mid} to exist after remember()"
    _write_fixture(
        "remember",
        {
            "method": "remember",
            "description": "Create a new memory and verify storage",
            "seed_db": SEED_VERSION,
            "input": {
                "session_id": session_id,
                "kind": "note",
                "title": "Parity fixture remember test",
                "body_text": "This memory was created by the fixture generator to test remember().",
                "confidence": 0.6,
                "tags": ["parity", "test"],
                "metadata": {"visibility": "shared"},
            },
            "expected_output": {
                "id_gt": 0,
                "stored": True,
                "kind": "note",
                "title": "Parity fixture remember test",
                "body_text": "This memory was created by the fixture generator to test remember().",
                "active": 1,
                "visibility": "shared",
            },
        },
    )


def generate_forget_fixture(
    store: MemoryStore, memory_ids: list[int], _session_ids: list[int]
) -> None:
    """Capture forget behavior using a seed memory (not a newly created one)."""
    mid = memory_ids[-1]  # Use the last seed memory
    before = store.get(mid)
    assert before is not None
    store.forget(mid)
    after = store.get(mid)
    assert after is not None

    _write_fixture(
        "forget",
        {
            "method": "forget",
            "description": "Forget (deactivate) a seed memory and verify state change",
            "seed_db": SEED_VERSION,
            "input": {"memory_id": mid},
            "expected_output": {
                "before_active": before["active"],
                "after_active": after["active"],
                "after_deleted_at_present": after.get("deleted_at") is not None,
            },
        },
    )


def generate_recent_by_kinds_fixture(store: MemoryStore) -> None:
    """Capture recent_by_kinds behavior."""
    results = store.recent_by_kinds(["discovery", "change"], limit=3)
    _write_fixture(
        "recent_by_kinds",
        {
            "method": "recent_by_kinds",
            "description": "Recent memories filtered to kinds=[discovery, change]",
            "seed_db": SEED_VERSION,
            "input": {"kinds": ["discovery", "change"], "limit": 3},
            "expected_output": {
                "count": len(results),
                "ordered_ids": [r["id"] for r in results],
                "results": [
                    {"id": r["id"], "kind": r["kind"], "title": r["title"]} for r in results
                ],
                "all_kinds_valid": all(r["kind"] in ("discovery", "change") for r in results),
            },
        },
    )


def generate_stats_fixture(store: MemoryStore) -> None:
    """Capture stats output shape (not exact counts, since remember/forget add more)."""
    stats = store.stats()
    _write_fixture(
        "stats",
        {
            "method": "stats",
            "description": "Full stats dict — captures structure and key presence",
            "seed_db": SEED_VERSION,
            "input": {},
            "expected_output": {
                "has_database_key": "database" in stats,
                "has_usage_key": "usage" in stats,
                "database_keys": sorted(stats.get("database", {}).keys()),
                "database_total_memories_gte": 1,
                "database_active_memories_gte": 1,
            },
        },
    )


def generate_update_visibility_fixture(store: MemoryStore, memory_ids: list[int]) -> None:
    """Capture update_memory_visibility behavior."""
    # Use memory index 3 (private feature memory)
    target_id = memory_ids[3]
    before = store.get(target_id)
    assert before is not None
    updated = store.update_memory_visibility(target_id, visibility="shared")
    _write_fixture(
        "update_visibility",
        {
            "method": "update_memory_visibility",
            "description": "Change visibility from private to shared",
            "seed_db": SEED_VERSION,
            "input": {"memory_id": target_id, "visibility": "shared"},
            "expected_output": {
                "before_visibility": before.get("visibility"),
                "after_visibility": updated.get("visibility"),
                "after_workspace_kind": updated.get("workspace_kind"),
            },
        },
    )


def generate_pack_fixture(store: MemoryStore) -> None:
    """Capture build_memory_pack behavior."""
    pack = store.build_memory_pack("memory layer coding", limit=5, log_usage=False)
    _write_fixture(
        "pack_memory_layer",
        {
            "method": "build_memory_pack",
            "description": "Pack assembly for 'memory layer coding' — exercises search, dedup, section formatting",
            "seed_db": SEED_VERSION,
            "input": {"context": "memory layer coding", "limit": 5},
            "expected_output": {
                "context": pack["context"],
                "has_items": len(pack.get("items", [])) > 0,
                "item_count_gte": 1,
                "has_pack_text": bool(pack.get("pack_text")),
                "has_metrics": bool(pack.get("metrics")),
                "item_ids": [it["id"] for it in pack.get("items", []) if "id" in it],
            },
        },
    )


def generate_multi_filter_fixtures(store: MemoryStore) -> None:
    """Capture search/recent with multiple filters combined."""
    # visibility + kind filter
    filters_vk: dict[str, Any] = {"kind": "discovery", "include_visibility": ["shared"]}
    results_vk = list(store.search("memory", limit=10, filters=filters_vk))
    _write_fixture(
        "search_visibility_kind_filter",
        {
            "method": "search",
            "description": "Search with include_visibility=shared AND kind=discovery filters combined",
            "seed_db": SEED_VERSION,
            "input": {"query": "memory", "limit": 10, "filters": filters_vk},
            "expected_output": {
                "count": len(results_vk),
                "all_discovery": all(r.kind == "discovery" for r in results_vk),
                "ordered_ids": [r.id for r in results_vk],
            },
        },
    )

    # recent with kind filter
    filters_rk: dict[str, Any] = {"kind": "change"}
    recent_vk = store.recent(limit=10, filters=filters_rk)
    _write_fixture(
        "recent_kind_change_filter",
        {
            "method": "recent",
            "description": "Recent with kind=change filter",
            "seed_db": SEED_VERSION,
            "input": {"limit": 10, "filters": filters_rk},
            "expected_output": {
                "count": len(recent_vk),
                "all_change": all(r.get("kind") == "change" for r in recent_vk),
                "ordered_ids": [r["id"] for r in recent_vk],
            },
        },
    )


def main() -> None:
    import tempfile

    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "parity_seed.sqlite"
        print(f"Building seed database at {db_path}")
        store, memory_ids, session_ids = build_seed_database(db_path)

        print("Generating fixtures...")
        generate_search_fixtures(store, memory_ids)
        generate_timeline_fixture(store)
        generate_recent_fixtures(store)
        generate_get_fixtures(store, memory_ids)
        generate_explain_fixture(store)
        generate_remember_fixture(store, session_ids)
        generate_forget_fixture(store, memory_ids, session_ids)
        generate_recent_by_kinds_fixture(store)
        generate_stats_fixture(store)
        generate_update_visibility_fixture(store, memory_ids)
        generate_pack_fixture(store)
        generate_multi_filter_fixtures(store)

        store.close()

    print(f"\nDone — {len(list(FIXTURES_DIR.glob('*.json')))} fixture files written.")


if __name__ == "__main__":
    # Set env vars only when run as a script, not when imported by tests
    os.environ.setdefault("CODEMEM_EMBEDDING_DISABLED", "1")
    os.environ.setdefault("CODEMEM_DEVICE_ID", "device-local-001")
    main()
