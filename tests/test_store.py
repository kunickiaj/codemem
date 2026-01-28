import http.client
import json
import sqlite3
import threading
from http.server import HTTPServer
from pathlib import Path
from typing import cast

from opencode_mem import db
from opencode_mem import store as store_module
from opencode_mem import viewer as viewer_module
from opencode_mem.store import MemoryStore, ReplicationOp
from opencode_mem.viewer import ViewerHandler


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


def test_replication_schema_bootstrap(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        table_rows = store.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
        tables = {row["name"] for row in table_rows if row["name"]}
        assert "replication_ops" in tables
        assert "replication_cursors" in tables
        assert "sync_peers" in tables
        assert "sync_attempts" in tables

        memory_columns = {
            row["name"]
            for row in store.conn.execute("PRAGMA table_info(memory_items)").fetchall()
            if row["name"]
        }
        assert "deleted_at" in memory_columns
        assert "rev" in memory_columns
    finally:
        store.close()


def test_replication_ops_roundtrip(tmp_path: Path) -> None:
    store_a = MemoryStore(tmp_path / "a.sqlite")
    store_b = MemoryStore(tmp_path / "b.sqlite")
    try:
        session_id = store_a.start_session(
            cwd=str(tmp_path),
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project-a",
        )
        store_a.remember(session_id, kind="note", title="Alpha", body_text="Alpha body")
        ops, cursor = store_a.load_replication_ops_since(None, limit=10)
        assert len(ops) == 1
        assert cursor

        result = store_b.apply_replication_ops(ops)
        assert result["inserted"] == 1
        entity_id = ops[0]["entity_id"]
        row = store_b.conn.execute(
            "SELECT title FROM memory_items WHERE import_key = ?",
            (entity_id,),
        ).fetchone()
        assert row is not None
        assert row["title"] == "Alpha"

        more_ops, next_cursor = store_a.load_replication_ops_since(cursor, limit=10)
        assert more_ops == []
        assert next_cursor is None
    finally:
        store_a.close()
        store_b.close()


def test_replication_ops_idempotent(tmp_path: Path) -> None:
    store_a = MemoryStore(tmp_path / "a.sqlite")
    store_b = MemoryStore(tmp_path / "b.sqlite")
    try:
        session_id = store_a.start_session(
            cwd=str(tmp_path),
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project-a",
        )
        store_a.remember(session_id, kind="note", title="Beta", body_text="Beta body")
        ops, _ = store_a.load_replication_ops_since(None, limit=10)

        first = store_b.apply_replication_ops(ops)
        assert first["inserted"] == 1
        second = store_b.apply_replication_ops(ops)
        assert second["skipped"] == len(ops)
    finally:
        store_a.close()
        store_b.close()


def test_replication_delete_wins_over_older_upsert(tmp_path: Path) -> None:
    store_a = MemoryStore(tmp_path / "a.sqlite")
    store_b = MemoryStore(tmp_path / "b.sqlite")
    try:
        session_id = store_a.start_session(
            cwd=str(tmp_path),
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project-a",
        )
        memory_id = store_a.remember(
            session_id,
            kind="note",
            title="Gamma",
            body_text="Gamma body",
        )
        store_a.forget(memory_id)
        ops, _ = store_a.load_replication_ops_since(None, limit=10)
        delete_op = next(op for op in ops if op["op_type"] == "delete")
        upsert_op = next(op for op in ops if op["op_type"] == "upsert")

        result = store_b.apply_replication_ops([delete_op, upsert_op])
        assert result["inserted"] == 1
        row = store_b.conn.execute(
            "SELECT active, deleted_at FROM memory_items WHERE import_key = ?",
            (delete_op["entity_id"],),
        ).fetchone()
        assert row is not None
        assert row["active"] == 0
        assert row["deleted_at"]
    finally:
        store_a.close()
        store_b.close()


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

    assert "tags_coverage" in stats["database"]
    assert "raw_events" in stats["database"]

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


def test_pack_metrics_dedupe_work_by_discovery_group(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    meta = {
        "discovery_group": "sess-1:p1",
        "discovery_tokens": 100,
        "discovery_source": "usage",
    }
    store.remember(
        session,
        kind="note",
        title="Alpha database index",
        body_text="Shared keyword content",
        metadata=meta,
    )
    store.remember(
        session,
        kind="note",
        title="Beta networking sync",
        body_text="Shared keyword content",
        metadata=meta,
    )
    store.end_session(session)

    pack = store.build_memory_pack("Shared keyword", limit=10)
    metrics = pack.get("metrics") or {}
    assert metrics.get("work_tokens_unique") == 100
    assert metrics.get("work_tokens") == 200


def test_pack_metrics_work_estimates_and_reliability(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    missing_one = store.remember(
        session,
        kind="note",
        title="Missing tokens one",
        body_text="savings-check unique-missing-1",
    )
    known = store.remember(
        session,
        kind="note",
        title="Has tokens",
        body_text="savings-check unique-known-1",
        metadata={"discovery_tokens": 150, "discovery_source": "usage"},
    )
    missing_two = store.remember(
        session,
        kind="note",
        title="Missing tokens two",
        body_text="savings-check unique-missing-2",
    )
    store.end_session(session)

    pack_missing = store.build_memory_pack("unique-missing-1", limit=1)
    missing_items = {item.get("id") for item in pack_missing.get("items", [])}
    assert missing_items == {missing_one}
    missing_metrics = pack_missing.get("metrics") or {}
    assert missing_metrics.get("work_tokens_unique", 0) >= 2000

    pack_known = store.build_memory_pack("unique-known-1", limit=1)
    known_items = {item.get("id") for item in pack_known.get("items", [])}
    assert known_items == {known}
    known_metrics = pack_known.get("metrics") or {}
    assert known_metrics.get("work_tokens_unique") == 150
    assert known_metrics.get("savings_reliable") is True

    pack_mixed = store.build_memory_pack("savings-check", limit=10)
    mixed_items = {item.get("id") for item in pack_mixed.get("items", [])}
    assert known in mixed_items
    assert missing_one in mixed_items
    assert missing_two in mixed_items
    mixed_metrics = pack_mixed.get("metrics") or {}
    assert mixed_metrics.get("savings_reliable") is False


def test_migrate_legacy_import_keys_prefixes_device_id(tmp_path: Path) -> None:
    db_a = tmp_path / "a.sqlite"
    db_b = tmp_path / "b.sqlite"
    conn_a = db.connect(db_a)
    conn_b = db.connect(db_b)
    try:
        db.initialize_schema(conn_a)
        db.initialize_schema(conn_b)
        conn_a.execute(
            "INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
            ("dev-a", "pk", "fp", "2026-01-01T00:00:00Z"),
        )
        conn_b.execute(
            "INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
            ("dev-b", "pk", "fp", "2026-01-01T00:00:00Z"),
        )
        conn_a.commit()
        conn_b.commit()
    finally:
        conn_a.close()
        conn_b.close()

    store_a = MemoryStore(db_a)
    store_b = MemoryStore(db_b)
    try:
        session_a = store_a.start_session(
            cwd="/tmp",
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project-a",
        )
        session_b = store_b.start_session(
            cwd="/tmp",
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project-b",
        )
        mid_a = store_a.remember(
            session_a,
            kind="note",
            title="A",
            body_text="A",
        )
        mid_b = store_b.remember(
            session_b,
            kind="note",
            title="B",
            body_text="B",
        )

        store_a.conn.execute(
            "UPDATE memory_items SET import_key = ? WHERE id = ?",
            (f"legacy:memory_item:{mid_a}", mid_a),
        )
        store_b.conn.execute(
            "UPDATE memory_items SET import_key = ? WHERE id = ?",
            (f"legacy:memory_item:{mid_b}", mid_b),
        )
        store_a.conn.commit()
        store_b.conn.commit()

        updated_a = store_a.migrate_legacy_import_keys()
        updated_b = store_b.migrate_legacy_import_keys()
        assert updated_a == 1
        assert updated_b == 1

        row_a = store_a.conn.execute(
            "SELECT id, import_key FROM memory_items WHERE title = ?",
            ("A",),
        ).fetchone()
        row_b = store_b.conn.execute(
            "SELECT id, import_key FROM memory_items WHERE title = ?",
            ("B",),
        ).fetchone()
        assert row_a is not None
        assert row_b is not None
        assert row_a["import_key"] == f"legacy:dev-a:memory_item:{row_a['id']}"
        assert row_b["import_key"] == f"legacy:dev-b:memory_item:{row_b['id']}"
        assert row_a["import_key"] != row_b["import_key"]
    finally:
        store_a.close()
        store_b.close()


def test_repair_legacy_import_keys_merges_old_and_new(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.conn.execute(
            "INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
            ("dev-b", "pk", "fp", "2026-01-01T00:00:00Z"),
        )
        store.conn.commit()
        session = store.start_session(
            cwd="/tmp",
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project-b",
        )
        now = "2026-01-01T00:00:00Z"
        store.conn.execute(
            """
            INSERT INTO memory_items(
                session_id, kind, title, body_text, confidence, tags_text, active,
                created_at, updated_at, metadata_json, prompt_number, import_key, deleted_at, rev
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session,
                "note",
                "Dup",
                "Same",
                0.5,
                "",
                1,
                now,
                now,
                json.dumps({"clock_device_id": "dev-a"}),
                1,
                "legacy:memory_item:1",
                None,
                1,
            ),
        )
        store.conn.execute(
            """
            INSERT INTO memory_items(
                session_id, kind, title, body_text, confidence, tags_text, active,
                created_at, updated_at, metadata_json, prompt_number, import_key, deleted_at, rev
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session,
                "note",
                "Dup",
                "Same",
                0.5,
                "",
                1,
                now,
                now,
                json.dumps({"clock_device_id": "dev-a"}),
                1,
                "legacy:dev-a:memory_item:1",
                None,
                1,
            ),
        )
        store.conn.commit()

        result = store.repair_legacy_import_keys()
        assert result["merged"] == 1
        assert result["tombstoned"] == 1

        old_row = store.conn.execute(
            "SELECT active, deleted_at FROM memory_items WHERE import_key = ?",
            ("legacy:memory_item:1",),
        ).fetchone()
        new_row = store.conn.execute(
            "SELECT active, deleted_at FROM memory_items WHERE import_key = ?",
            ("legacy:dev-a:memory_item:1",),
        ).fetchone()
        assert old_row is not None
        assert new_row is not None
        assert int(old_row["active"]) == 0
        assert old_row["deleted_at"]
        assert int(new_row["active"]) == 1

        op = store.conn.execute(
            "SELECT 1 FROM replication_ops WHERE entity_id = ? AND op_type = 'delete' LIMIT 1",
            ("legacy:memory_item:1",),
        ).fetchone()
        assert op is not None
    finally:
        store.close()


def test_repair_legacy_import_keys_prefers_existing_new_key(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.conn.execute(
            "INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
            ("dev-b", "pk", "fp", "2026-01-01T00:00:00Z"),
        )
        store.conn.commit()
        session = store.start_session(
            cwd="/tmp",
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project-b",
        )
        now = "2026-01-01T00:00:00Z"
        store.conn.execute(
            """
            INSERT INTO memory_items(
                session_id, kind, title, body_text, confidence, tags_text, active,
                created_at, updated_at, metadata_json, prompt_number, import_key, deleted_at, rev
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session,
                "note",
                "Dup",
                "Same",
                0.5,
                "",
                1,
                now,
                now,
                json.dumps({"clock_device_id": "local"}),
                1,
                "legacy:memory_item:1",
                None,
                1,
            ),
        )
        store.conn.execute(
            """
            INSERT INTO memory_items(
                session_id, kind, title, body_text, confidence, tags_text, active,
                created_at, updated_at, metadata_json, prompt_number, import_key, deleted_at, rev
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session,
                "note",
                "Dup",
                "Same",
                0.5,
                "",
                1,
                now,
                now,
                json.dumps({"clock_device_id": "dev-a"}),
                1,
                "legacy:dev-a:memory_item:1",
                None,
                1,
            ),
        )
        store.conn.commit()

        dry = store.repair_legacy_import_keys(dry_run=True)
        assert dry["merged"] == 1
        assert dry["renamed"] == 0

        applied = store.repair_legacy_import_keys()
        assert applied["merged"] == 1
        assert applied["tombstoned"] == 1
        count = store.conn.execute(
            "SELECT COUNT(*) AS c FROM memory_items WHERE active = 1"
        ).fetchone()["c"]
        assert int(count) == 1

        again = store.repair_legacy_import_keys()
        assert again["checked"] == 0
        assert again["renamed"] == 0
        assert again["merged"] == 0
        assert again["tombstoned"] == 0
        assert again["ops"] == 0
    finally:
        store.close()


def test_apply_replication_ops_upsert_aliases_legacy_keys(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        session = store.start_session(
            cwd="/tmp",
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project",
        )
        now = "2026-01-01T00:00:00Z"
        store.conn.execute(
            """
            INSERT INTO memory_items(
                session_id, kind, title, body_text, confidence, tags_text, active,
                created_at, updated_at, metadata_json, prompt_number, import_key, deleted_at, rev
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session,
                "note",
                "One",
                "Body",
                0.5,
                "",
                1,
                now,
                now,
                json.dumps({"clock_device_id": "dev-a"}),
                1,
                "legacy:memory_item:1",
                None,
                1,
            ),
        )
        store.conn.commit()
        op = {
            "op_id": "op-1",
            "entity_type": "memory_item",
            "entity_id": "legacy:dev-a:memory_item:1",
            "op_type": "upsert",
            "payload": {
                "session_id": session,
                "kind": "note",
                "title": "One",
                "body_text": "Body",
                "confidence": 0.5,
                "tags_text": "",
                "active": 1,
                "created_at": now,
                "updated_at": now,
                "metadata_json": {"clock_device_id": "dev-a"},
                "prompt_number": 1,
                "import_key": "legacy:dev-a:memory_item:1",
                "deleted_at": None,
                "rev": 2,
            },
            "clock": {"rev": 2, "updated_at": now, "device_id": "dev-a"},
            "device_id": "dev-a",
            "created_at": now,
        }
        result = store.apply_replication_ops(cast(list[ReplicationOp], [op]))
        assert result["updated"] == 1
        count = store.conn.execute("SELECT COUNT(*) AS c FROM memory_items").fetchone()["c"]
        assert int(count) == 1
        key = store.conn.execute("SELECT import_key FROM memory_items LIMIT 1").fetchone()[
            "import_key"
        ]
        assert key == "legacy:dev-a:memory_item:1"
    finally:
        store.close()


def test_backfill_replication_ops_emits_delete_for_new_rev(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.conn.execute(
            "INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
            ("dev-a", "pk", "fp", "2026-01-01T00:00:00Z"),
        )
        store.conn.commit()
        session = store.start_session(
            cwd="/tmp",
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project",
        )
        mid = store.remember(session, kind="note", title="X", body_text="Y")
        import_key = f"legacy:dev-a:memory_item:{mid}"
        store.conn.execute(
            "UPDATE memory_items SET import_key = ?, rev = 1 WHERE id = ?",
            (import_key, mid),
        )
        store.conn.commit()
        count = store.backfill_replication_ops(limit=50)
        assert count >= 1

        now = "2026-01-02T00:00:00Z"
        store.conn.execute(
            "UPDATE memory_items SET active = 0, deleted_at = ?, updated_at = ?, rev = 2 WHERE id = ?",
            (now, now, mid),
        )
        store.conn.commit()
        count2 = store.backfill_replication_ops(limit=50)
        assert count2 >= 1
        row = store.conn.execute(
            """
            SELECT op_type, clock_rev
            FROM replication_ops
            WHERE entity_id = ? AND clock_rev = 2
            LIMIT 1
            """,
            (import_key,),
        ).fetchone()
        assert row is not None
        assert row["op_type"] == "delete"
    finally:
        store.close()


def test_backfill_replication_ops_emits_delete_even_if_rev_does_not_change(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.conn.execute(
            "INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
            ("dev-a", "pk", "fp", "2026-01-01T00:00:00Z"),
        )
        store.conn.commit()
        session = store.start_session(
            cwd="/tmp",
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project",
        )
        mid = store.remember(session, kind="note", title="X", body_text="Y")
        import_key = f"legacy:dev-a:memory_item:{mid}"
        store.conn.execute(
            "UPDATE memory_items SET import_key = ?, rev = 1 WHERE id = ?",
            (import_key, mid),
        )
        store.conn.commit()
        store.backfill_replication_ops(limit=50)

        now = "2026-01-02T00:00:00Z"
        store.conn.execute(
            "UPDATE memory_items SET active = 0, deleted_at = ?, updated_at = ? WHERE id = ?",
            (now, now, mid),
        )
        store.conn.commit()
        count = store.backfill_replication_ops(limit=50)
        assert count >= 1
        row = store.conn.execute(
            """
            SELECT op_type, clock_rev
            FROM replication_ops
            WHERE entity_id = ? AND op_type = 'delete'
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (import_key,),
        ).fetchone()
        assert row is not None
        assert row["op_type"] == "delete"
        assert int(row["clock_rev"]) == 1
    finally:
        store.close()


def test_load_replication_ops_since_filters_by_device_id(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.record_replication_op(
            op_id="op-a",
            entity_type="memory_item",
            entity_id="k1",
            op_type="upsert",
            payload={"import_key": "k1", "session_id": 1, "rev": 1, "metadata_json": {}},
            clock={"rev": 1, "updated_at": "2026-01-01T00:00:00Z", "device_id": "dev-a"},
            device_id="dev-a",
            created_at="2026-01-01T00:00:00Z",
        )
        store.record_replication_op(
            op_id="op-b",
            entity_type="memory_item",
            entity_id="k2",
            op_type="upsert",
            payload={"import_key": "k2", "session_id": 1, "rev": 1, "metadata_json": {}},
            clock={"rev": 1, "updated_at": "2026-01-01T00:00:00Z", "device_id": "dev-b"},
            device_id="dev-b",
            created_at="2026-01-01T00:00:01Z",
        )
        ops, _ = store.load_replication_ops_since(None, limit=10, device_id="dev-a")
        assert [op["op_id"] for op in ops] == ["op-a"]
    finally:
        store.close()


def test_normalize_outbound_cursor_resets_when_ahead_of_local_stream(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        store.record_replication_op(
            op_id="op-a",
            entity_type="memory_item",
            entity_id="k1",
            op_type="upsert",
            payload={"import_key": "k1", "session_id": 1, "rev": 1, "metadata_json": {}},
            clock={"rev": 1, "updated_at": "2026-01-01T00:00:01Z", "device_id": "dev-a"},
            device_id="dev-a",
            created_at="2026-01-01T00:00:00Z",
        )
        cursor = "2099-01-01T00:00:00Z|zzz"
        assert store.normalize_outbound_cursor(cursor, device_id="dev-a") is None
    finally:
        store.close()


def test_apply_replication_ops_skips_excluded_project(tmp_path: Path, monkeypatch) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"sync_projects_exclude": ["opencode-mem"]}) + "\n")
    monkeypatch.setenv("OPENCODE_MEM_CONFIG", str(config_path))

    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        op = {
            "op_id": "op-1",
            "entity_type": "memory_item",
            "entity_id": "k1",
            "op_type": "upsert",
            "payload": {
                "session_id": 1,
                "project": "opencode-mem",
                "kind": "note",
                "title": "Nope",
                "body_text": "Nope",
                "confidence": 0.5,
                "tags_text": "",
                "active": 1,
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
                "metadata_json": {"clock_device_id": "dev-a"},
                "prompt_number": 1,
                "import_key": "k1",
                "deleted_at": None,
                "rev": 1,
            },
            "clock": {"rev": 1, "updated_at": "2026-01-01T00:00:00Z", "device_id": "dev-a"},
            "device_id": "dev-a",
            "created_at": "2026-01-01T00:00:00Z",
        }
        result = store.apply_replication_ops(cast(list[ReplicationOp], [op]))
        assert result["inserted"] == 0
        assert store.conn.execute("SELECT COUNT(*) AS c FROM memory_items").fetchone()["c"] == 0
        assert store.conn.execute("SELECT COUNT(*) AS c FROM replication_ops").fetchone()["c"] == 1
    finally:
        store.close()


def test_recent_pack_events_project_filter_includes_session_project_when_metadata_missing(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        session = store.start_session(
            cwd="/tmp",
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="opencode-mem",
        )
        store.record_usage(
            "pack",
            session_id=session,
            tokens_read=10,
            tokens_written=0,
            tokens_saved=5,
            metadata={},
        )
        rows = store.recent_pack_events(limit=10, project="opencode-mem")
        assert len(rows) == 1
        assert rows[0]["event"] == "pack"
    finally:
        store.close()


def test_stats_work_investment_uses_discovery_tokens(tmp_path: Path) -> None:
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
        body_text="Alpha body",
        metadata={"discovery_tokens": 111},
    )
    store.remember(
        session,
        kind="note",
        title="Beta",
        body_text="Beta body",
        metadata={"discovery_tokens": 222},
    )
    store.record_usage("observe", session_id=session, tokens_written=999)
    store.end_session(session)

    stats = store.stats()
    assert stats["usage"]["totals"]["work_investment_tokens"] == 333
    assert stats["usage"]["totals"]["work_investment_tokens_sum"] == 333


def test_stats_work_investment_dedupes_discovery_group(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    meta = {"discovery_group": "sess:p1", "discovery_tokens": 500}
    store.remember(session, kind="note", title="A", body_text="A", metadata=meta)
    store.remember(session, kind="note", title="B", body_text="B", metadata=meta)
    store.end_session(session)

    stats = store.stats()
    assert stats["usage"]["totals"]["work_investment_tokens"] == 500
    assert stats["usage"]["totals"]["work_investment_tokens_sum"] == 1000


def test_backfill_discovery_tokens_from_raw_events(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.get_or_create_opencode_session(
        opencode_session_id="sess-1",
        cwd="/tmp",
        project="/tmp/project-a",
    )
    store.remember(
        session,
        kind="feature",
        title="First",
        body_text="First body",
        metadata={"source": "observer"},
    )
    store.remember(
        session,
        kind="feature",
        title="Second",
        body_text="Second body",
        metadata={"source": "observer"},
    )
    store.record_raw_events_batch(
        opencode_session_id="sess-1",
        events=[
            {
                "event_id": "e1",
                "event_type": "assistant_usage",
                "payload": {
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 5,
                        "cache_creation_input_tokens": 0,
                        "cache_read_input_tokens": 0,
                    }
                },
            }
        ],
    )

    updated = store.backfill_discovery_tokens(limit_sessions=10)
    assert updated == 2
    updated_again = store.backfill_discovery_tokens(limit_sessions=10)
    assert updated_again == 0

    rows = store.conn.execute(
        "SELECT metadata_json FROM memory_items WHERE session_id = ? ORDER BY id ASC",
        (session,),
    ).fetchall()
    meta_a = json.loads(rows[0]["metadata_json"])
    meta_b = json.loads(rows[1]["metadata_json"])
    assert meta_a["discovery_tokens"] == 15
    assert meta_b["discovery_tokens"] == 15
    assert meta_a["discovery_source"] == "usage"

    assert meta_a["discovery_group"] == "sess-1:unknown"
    assert meta_a["discovery_backfill_version"] == 2

    stats = store.stats()
    assert stats["usage"]["totals"]["work_investment_tokens"] == 15


def test_backfill_discovery_tokens_uses_existing_when_no_artifacts(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.get_or_create_opencode_session(
        opencode_session_id="sess-2",
        cwd="/tmp",
        project="/tmp/project-a",
    )
    store.remember_observation(
        session,
        kind="feature",
        title="One",
        narrative="One",
        prompt_number=1,
        metadata={"source": "observer", "discovery_tokens": 7, "discovery_source": "estimate"},
    )
    store.remember_observation(
        session,
        kind="feature",
        title="Two",
        narrative="Two",
        prompt_number=1,
        metadata={"source": "observer", "discovery_tokens": 7, "discovery_source": "estimate"},
    )

    updated = store.backfill_discovery_tokens(limit_sessions=10)
    assert updated == 2

    rows = store.conn.execute(
        "SELECT metadata_json FROM memory_items WHERE session_id = ? ORDER BY id ASC",
        (session,),
    ).fetchall()
    meta_a = json.loads(rows[0]["metadata_json"])
    meta_b = json.loads(rows[1]["metadata_json"])
    assert meta_a["discovery_group"] == "sess-2:p1"
    assert meta_a["discovery_tokens"] == 14
    assert meta_b["discovery_tokens"] == 14
    assert meta_a["discovery_source"] == "fallback"


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


def test_project_full_path_filter_matches_basename_sessions(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp/project-a",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="project-a",
    )
    store.remember(session, kind="note", title="Note", body_text="Alpha only")
    store.end_session(session)

    recent_results = store.recent(limit=5, filters={"project": "/tmp/project-a"})
    assert len(recent_results) == 1
    assert recent_results[0]["body_text"] == "Alpha only"


def test_normalize_projects_rewrites_basenames_and_git_errors(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")

    full = store.start_session(
        cwd="/tmp/opencode-mem",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/opencode-mem",
    )
    short = store.start_session(
        cwd="/tmp/opencode-mem",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="opencode-mem",
    )
    fatal = store.start_session(
        cwd="/tmp/not-a-repo",
        git_remote=None,
        git_branch=None,
        user="tester",
        tool_version="test",
        project="fatal: not a git repository",
    )
    store.end_session(full)
    store.end_session(short)
    store.end_session(fatal)

    store.normalize_projects(dry_run=False)

    short_row = store.conn.execute("SELECT project FROM sessions WHERE id = ?", (short,)).fetchone()
    assert short_row is not None
    assert short_row["project"] == "opencode-mem"

    full_row = store.conn.execute("SELECT project FROM sessions WHERE id = ?", (full,)).fetchone()
    assert full_row is not None
    assert full_row["project"] == "opencode-mem"

    fatal_row = store.conn.execute("SELECT project FROM sessions WHERE id = ?", (fatal,)).fetchone()
    assert fatal_row is not None
    assert fatal_row["project"] == "not-a-repo"


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


def test_semantic_search_respects_project_filter(monkeypatch, tmp_path: Path) -> None:
    class FakeEmbeddingClient:
        def embed(self, texts):
            vectors = []
            for text in texts:
                lowered = text.lower()
                if "alpha" in lowered:
                    vectors.append([1.0, 0.0])
                else:
                    vectors.append([0.0, 1.0])
            return vectors

    monkeypatch.setattr(store_module, "get_embedding_client", lambda: FakeEmbeddingClient())

    store = MemoryStore(tmp_path / "mem.sqlite")
    session_a = store.start_session(
        cwd="/tmp/a",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    a_id = store.remember(session_a, kind="note", title="Alpha", body_text="Alpha A")
    store.end_session(session_a)

    session_b = store.start_session(
        cwd="/tmp/b",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-b",
    )
    b_id = store.remember(session_b, kind="note", title="Alpha", body_text="Alpha B")
    store.end_session(session_b)

    results = store._semantic_search("alpha", limit=5, filters={"project": "/tmp/project-a"})
    ids = {item["id"] for item in results}
    assert a_id in ids
    assert b_id not in ids


def test_semantic_search_respects_kind_filter(monkeypatch, tmp_path: Path) -> None:
    class FakeEmbeddingClient:
        def embed(self, texts):
            return [[1.0, 0.0] for _ in texts]

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
    note_id = store.remember(session, kind="note", title="Alpha", body_text="Alpha")
    obs_id = store.remember_observation(
        session,
        kind="discovery",
        title="Alpha obs",
        narrative="Alpha",
    )
    store.end_session(session)

    results = store._semantic_search("alpha", limit=10, filters={"kind": "note"})
    ids = {item["id"] for item in results}
    assert note_id in ids
    assert obs_id not in ids


def test_semantic_search_respects_project_and_kind_filter(monkeypatch, tmp_path: Path) -> None:
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
    a_note = store.remember(a, kind="note", title="Alpha", body_text="Alpha")
    store.end_session(a)

    b = store.start_session(
        cwd="/tmp/b",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-b",
    )
    b_note = store.remember(b, kind="note", title="Alpha", body_text="Alpha")
    store.end_session(b)

    results = store._semantic_search(
        "alpha",
        limit=10,
        filters={"project": "/tmp/project-a", "kind": "note"},
    )
    ids = {item["id"] for item in results}
    assert a_note in ids
    assert b_note not in ids


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
        event_id="evt-1",
        event_type="tool.execute.after",
        payload={"hello": "world"},
        ts_wall_ms=123,
        ts_mono_ms=456.0,
    )
    assert inserted is True
    inserted2 = store.record_raw_event(
        opencode_session_id="sess-123",
        event_id="evt-1",
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

    seqs = [
        r[0]
        for r in store.conn.execute(
            "SELECT event_seq FROM raw_events WHERE opencode_session_id = ? ORDER BY event_seq",
            ("sess-123",),
        ).fetchall()
    ]
    assert seqs == [0]


def test_record_raw_events_batch_assigns_monotonic_seqs(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    result = store.record_raw_events_batch(
        opencode_session_id="sess",
        events=[
            {"event_id": "a", "event_type": "t", "payload": {}},
            {"event_id": "b", "event_type": "t", "payload": {}},
        ],
    )
    assert result["inserted"] == 2
    seqs = [
        r[0]
        for r in store.conn.execute(
            "SELECT event_seq FROM raw_events WHERE opencode_session_id = ? ORDER BY event_seq",
            ("sess",),
        ).fetchall()
    ]
    assert seqs == [0, 1]


def test_raw_events_since_orders_by_ts_mono(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    store.record_raw_events_batch(
        opencode_session_id="sess",
        events=[
            {"event_id": "a", "event_type": "t", "payload": {}, "ts_mono_ms": 2.0},
            {"event_id": "b", "event_type": "t", "payload": {}, "ts_mono_ms": 1.0},
        ],
    )
    events = store.raw_events_since(opencode_session_id="sess", after_event_seq=-1)
    assert [e["event_id"] for e in events] == ["b", "a"]


def test_raw_event_flush_state_roundtrip(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    assert store.raw_event_flush_state("sess") == -1
    store.update_raw_event_flush_state("sess", 12)
    assert store.raw_event_flush_state("sess") == 12


def test_get_or_create_raw_event_flush_batch_is_idempotent(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    batch_id, status = store.get_or_create_raw_event_flush_batch(
        opencode_session_id="sess",
        start_event_seq=0,
        end_event_seq=2,
        extractor_version="v1",
    )
    assert status == "started"
    batch_id2, status2 = store.get_or_create_raw_event_flush_batch(
        opencode_session_id="sess",
        start_event_seq=0,
        end_event_seq=2,
        extractor_version="v1",
    )
    assert batch_id2 == batch_id
    assert status2 == "started"


def test_raw_event_backlog(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    store.record_raw_event(
        opencode_session_id="sess",
        event_id="evt-0",
        event_type="user_prompt",
        payload={"type": "user_prompt", "prompt_text": "A"},
        ts_wall_ms=100,
        ts_mono_ms=1.0,
    )
    store.update_raw_event_session_meta(
        opencode_session_id="sess",
        cwd="/tmp",
        project="p",
        started_at="2026-01-01T00:00:00Z",
        last_seen_ts_wall_ms=100,
    )
    items = store.raw_event_backlog(limit=10)
    assert len(items) == 1
    assert items[0]["opencode_session_id"] == "sess"
    assert items[0]["pending"] == 1

    totals = store.raw_event_backlog_totals()
    assert totals["sessions"] == 1
    assert totals["pending"] == 1


def test_pack_prefers_tag_overlap(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    a = store.start_session(
        cwd=str(tmp_path),
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    id_relevant = store.remember(
        a,
        kind="discovery",
        title="Vector search scoring",
        body_text="Notes on retrieval.",
        tags=["sqlite", "fts", "vector"],
    )
    store.remember(
        a,
        kind="discovery",
        title="Unrelated",
        body_text="Nothing about databases.",
        tags=["frontend"],
    )
    store.end_session(a)

    pack = store.build_memory_pack("sqlite vector", limit=3)
    ids = [item.get("id") for item in pack.get("items", [])]
    assert id_relevant in ids
    assert len(ids) > 0


def test_pack_dedupes_similar_titles(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    a = store.start_session(
        cwd=str(tmp_path),
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    store.remember(
        a,
        kind="discovery",
        title="Investigated flushing",
        body_text="A",
        tags=["flush"],
    )
    store.remember(
        a,
        kind="discovery",
        title="Investigated flushing (again)",
        body_text="B",
        tags=["flush"],
    )
    store.end_session(a)

    pack = store.build_memory_pack("flush", limit=5)
    titles = [item.get("title") for item in pack.get("items", [])]
    assert len(titles) == len(set(t[:48].lower() for t in titles if t))


def test_pack_reports_avoided_work_metrics(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd=str(tmp_path),
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    store.remember_observation(
        session,
        kind="discovery",
        title="Expensive debug",
        narrative="Did a lot of work.",
        metadata={"discovery_tokens": 5000, "discovery_source": "usage"},
    )
    store.end_session(session)
    pack = store.build_memory_pack("debug", limit=5)
    metrics = pack.get("metrics")
    assert isinstance(metrics, dict)
    assert metrics.get("avoided_work_tokens") == 5000
    assert metrics.get("avoided_work_known_items") == 1


def test_viewer_accepts_raw_events(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    server = HTTPServer(("127.0.0.1", 0), ViewerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = int(server.server_address[1])
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        body = {
            "opencode_session_id": "sess-1",
            "event_id": "evt-1",
            "event_seq": 1,
            "event_type": "tool.execute.after",
            "payload": {"tool": "read", "text": "hi <private>secret</private>"},
            "ts_wall_ms": 123,
            "ts_mono_ms": 456.0,
            "cwd": str(tmp_path),
            "project": "test-project",
            "started_at": "2026-01-01T00:00:00Z",
        }
        conn.request(
            "POST",
            "/api/raw-events",
            body=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        data = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert data["inserted"] == 1

        conn.request(
            "POST",
            "/api/raw-events",
            body=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        resp2 = conn.getresponse()
        data2 = json.loads(resp2.read().decode("utf-8"))
        assert resp2.status == 200
        assert data2["inserted"] == 0
        conn.close()

        store = MemoryStore(db_path)
        try:
            row = store.conn.execute(
                "SELECT COUNT(*) AS n FROM raw_events WHERE opencode_session_id = ?",
                ("sess-1",),
            ).fetchone()
            assert row is not None
            assert int(row["n"]) == 1

            payload_json = store.conn.execute(
                "SELECT payload_json FROM raw_events WHERE opencode_session_id = ?",
                ("sess-1",),
            ).fetchone()[0]
            assert "secret" not in str(payload_json)

            meta = store.raw_event_session_meta("sess-1")
            assert meta.get("cwd") == str(tmp_path)
            assert meta.get("project") == "test-project"
            assert meta.get("started_at") == "2026-01-01T00:00:00Z"

            last_received = store.conn.execute(
                "SELECT last_received_event_seq FROM raw_event_sessions WHERE opencode_session_id = ?",
                ("sess-1",),
            ).fetchone()[0]
            assert int(last_received) == 0
        finally:
            store.close()
    finally:
        server.shutdown()


def test_viewer_accepts_multi_session_legacy_event_ids(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    server = HTTPServer(("127.0.0.1", 0), ViewerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = int(server.server_address[1])
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        body = {
            "events": [
                {
                    "opencode_session_id": "sess-a",
                    "event_seq": 1,
                    "event_type": "tool.execute.after",
                    "payload": {"tool": "read"},
                    "ts_wall_ms": 123,
                    "ts_mono_ms": 456.0,
                },
                {
                    "opencode_session_id": "sess-b",
                    "event_id": "evt-b",
                    "event_seq": 2,
                    "event_type": "tool.execute.after",
                    "payload": {"tool": "write"},
                    "ts_wall_ms": 124,
                    "ts_mono_ms": 457.0,
                },
            ]
        }
        conn.request(
            "POST",
            "/api/raw-events",
            body=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        data = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert data["inserted"] == 2
        conn.close()

        store = MemoryStore(db_path)
        try:
            row = store.conn.execute(
                "SELECT event_id FROM raw_events WHERE opencode_session_id = ?",
                ("sess-a",),
            ).fetchone()
            assert row is not None
            assert row["event_id"].startswith("legacy-seq-")

            row_b = store.conn.execute(
                "SELECT event_id FROM raw_events WHERE opencode_session_id = ?",
                ("sess-b",),
            ).fetchone()
            assert row_b is not None
            assert row_b["event_id"] == "evt-b"
        finally:
            store.close()
    finally:
        server.shutdown()


def test_viewer_legacy_seq_event_id_does_not_collide_on_restart(
    monkeypatch, tmp_path: Path
) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    server = HTTPServer(("127.0.0.1", 0), ViewerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = int(server.server_address[1])
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        body1 = {
            "opencode_session_id": "sess-1",
            "event_seq": 1,
            "event_type": "tool.execute.after",
            "payload": {"tool": "read", "args": {"filePath": "a"}},
            "ts_wall_ms": 123,
            "ts_mono_ms": 456.0,
        }
        conn.request(
            "POST",
            "/api/raw-events",
            body=json.dumps(body1).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        resp1 = conn.getresponse()
        data1 = json.loads(resp1.read().decode("utf-8"))
        assert resp1.status == 200
        assert data1["inserted"] == 1

        # Simulate legacy sender restart: same event_seq, different payload.
        body2 = {
            "opencode_session_id": "sess-1",
            "event_seq": 1,
            "event_type": "tool.execute.after",
            "payload": {"tool": "read", "args": {"filePath": "b"}},
            "ts_wall_ms": 124,
            "ts_mono_ms": 457.0,
        }
        conn.request(
            "POST",
            "/api/raw-events",
            body=json.dumps(body2).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        resp2 = conn.getresponse()
        data2 = json.loads(resp2.read().decode("utf-8"))
        assert resp2.status == 200
        assert data2["inserted"] == 1
        conn.close()

        store = MemoryStore(db_path)
        try:
            row = store.conn.execute(
                "SELECT COUNT(*) AS n FROM raw_events WHERE opencode_session_id = ?",
                ("sess-1",),
            ).fetchone()
            assert row is not None
            assert int(row["n"]) == 2

            ids = [
                r["event_id"]
                for r in store.conn.execute(
                    "SELECT event_id FROM raw_events WHERE opencode_session_id = ? ORDER BY id",
                    ("sess-1",),
                ).fetchall()
            ]
            assert ids[0] != ids[1]
        finally:
            store.close()
    finally:
        server.shutdown()


def test_viewer_multi_session_updates_meta_and_notes_activity(monkeypatch, tmp_path: Path) -> None:
    import opencode_mem.viewer as viewer_module

    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))

    noted: list[str] = []

    class DummyFlusher:
        def note_activity(self, opencode_session_id: str) -> None:
            noted.append(opencode_session_id)

    monkeypatch.setattr(viewer_module, "RAW_EVENT_FLUSHER", DummyFlusher())

    server = HTTPServer(("127.0.0.1", 0), ViewerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = int(server.server_address[1])
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        body = {
            "events": [
                {
                    "opencode_session_id": "sess-a",
                    "event_seq": 1,
                    "event_type": "tool.execute.after",
                    "payload": {"tool": "read"},
                    "cwd": str(tmp_path),
                    "project": "test-project",
                    "started_at": "2026-01-01T00:00:00Z",
                    "ts_wall_ms": 123,
                    "ts_mono_ms": 456.0,
                },
                {
                    "opencode_session_id": "sess-b",
                    "event_seq": 2,
                    "event_type": "tool.execute.after",
                    "payload": {"tool": "write"},
                    "cwd": str(tmp_path),
                    "project": "test-project",
                    "started_at": "2026-01-01T00:00:00Z",
                    "ts_wall_ms": 124,
                    "ts_mono_ms": 457.0,
                },
            ],
        }
        conn.request(
            "POST",
            "/api/raw-events",
            body=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        data = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert data["inserted"] == 2
        conn.close()

        store = MemoryStore(db_path)
        try:
            meta_a = store.raw_event_session_meta("sess-a")
            assert meta_a.get("cwd") == str(tmp_path)
            assert meta_a.get("project") == "test-project"
            assert meta_a.get("started_at") == "2026-01-01T00:00:00Z"
            assert int(meta_a.get("last_seen_ts_wall_ms") or 0) == 123

            meta_b = store.raw_event_session_meta("sess-b")
            assert int(meta_b.get("last_seen_ts_wall_ms") or 0) == 124
        finally:
            store.close()

        assert set(noted) == {"sess-a", "sess-b"}
    finally:
        server.shutdown()


def test_viewer_rejects_missing_session_id(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    server = HTTPServer(("127.0.0.1", 0), ViewerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = int(server.server_address[1])
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        body = {
            "events": [
                {
                    "event_seq": 1,
                    "event_type": "tool.execute.after",
                    "payload": {"tool": "read"},
                    "ts_wall_ms": 123,
                    "ts_mono_ms": 456.0,
                }
            ]
        }
        conn.request(
            "POST",
            "/api/raw-events",
            body=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        resp.read()
        assert resp.status == 400
        conn.close()
    finally:
        server.shutdown()


def test_viewer_rejects_missing_event_type(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    server = HTTPServer(("127.0.0.1", 0), ViewerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = int(server.server_address[1])
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        body = {
            "opencode_session_id": "sess-1",
            "event_id": "evt-1",
            "event_seq": 1,
            "payload": {"tool": "read"},
            "ts_wall_ms": 123,
            "ts_mono_ms": 456.0,
        }
        conn.request(
            "POST",
            "/api/raw-events",
            body=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        resp.read()
        assert resp.status == 400
        conn.close()
    finally:
        server.shutdown()


def test_viewer_stats_migrates_legacy_raw_events_table(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "legacy.sqlite"
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE raw_events (
                id INTEGER PRIMARY KEY,
                opencode_session_id TEXT NOT NULL,
                event_seq INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(opencode_session_id, event_seq)
            );
            """
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    server = HTTPServer(("127.0.0.1", 0), ViewerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = int(server.server_address[1])
    try:
        http_conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        http_conn.request("GET", "/api/stats")
        resp = http_conn.getresponse()
        data = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 200
        assert isinstance(data, dict)
        assert "database" in data
    finally:
        server.shutdown()


def test_viewer_api_returns_json_500_on_store_init_failure(monkeypatch, tmp_path: Path) -> None:
    class BoomStore:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            raise RuntimeError("boom")

    monkeypatch.setattr(viewer_module, "MemoryStore", BoomStore)
    monkeypatch.setenv("OPENCODE_MEM_DB", str(tmp_path / "mem.sqlite"))
    server = HTTPServer(("127.0.0.1", 0), ViewerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = int(server.server_address[1])
    try:
        http_conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        http_conn.request("GET", "/api/stats")
        resp = http_conn.getresponse()
        data = json.loads(resp.read().decode("utf-8"))
        assert resp.status == 500
        assert data.get("error") == "internal server error"
    finally:
        server.shutdown()


def test_viewer_rejects_message_id_as_session_id(monkeypatch, tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    monkeypatch.setenv("OPENCODE_MEM_DB", str(db_path))
    server = HTTPServer(("127.0.0.1", 0), ViewerHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = int(server.server_address[1])
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        body = {
            "opencode_session_id": "msg_123",
            "event_id": "evt-1",
            "event_seq": 1,
            "event_type": "tool.execute.after",
            "payload": {"tool": "read"},
            "ts_wall_ms": 123,
            "cwd": str(tmp_path),
            "project": "test-project",
            "started_at": "2026-01-01T00:00:00Z",
        }
        conn.request(
            "POST",
            "/api/raw-events",
            body=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        resp.read()
        assert resp.status == 400
        conn.close()
    finally:
        server.shutdown()
