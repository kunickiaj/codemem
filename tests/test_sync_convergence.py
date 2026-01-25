from pathlib import Path

from opencode_mem.store import MemoryStore


def test_sync_converges_between_two_peers(tmp_path: Path) -> None:
    store_a = MemoryStore(tmp_path / "a.sqlite")
    store_b = MemoryStore(tmp_path / "b.sqlite")
    try:
        session_a = store_a.start_session(
            cwd=str(tmp_path),
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project-a",
        )
        session_b = store_b.start_session(
            cwd=str(tmp_path),
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="/tmp/project-b",
        )
        store_a.remember(session_a, kind="note", title="One", body_text="First")
        store_b.remember(session_b, kind="note", title="Two", body_text="Second")

        # Simulate late pairing: clear replication_ops then backfill.
        store_a.conn.execute("DELETE FROM replication_ops")
        store_b.conn.execute("DELETE FROM replication_ops")
        store_a.conn.commit()
        store_b.conn.commit()
        assert store_a.backfill_replication_ops(limit=100) >= 1
        assert store_b.backfill_replication_ops(limit=100) >= 1

        ops_a, _ = store_a.load_replication_ops_since(None, limit=100)
        ops_b, _ = store_b.load_replication_ops_since(None, limit=100)
        store_b.apply_replication_ops(ops_a)
        store_a.apply_replication_ops(ops_b)

        rows_a = store_a.conn.execute(
            "SELECT title FROM memory_items WHERE active = 1 ORDER BY title"
        ).fetchall()
        rows_b = store_b.conn.execute(
            "SELECT title FROM memory_items WHERE active = 1 ORDER BY title"
        ).fetchall()
        titles_a = [row["title"] for row in rows_a]
        titles_b = [row["title"] for row in rows_b]
        assert titles_a == titles_b
        assert titles_a == ["One", "Two"]
    finally:
        store_a.close()
        store_b.close()
