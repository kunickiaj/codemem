from __future__ import annotations

import datetime as dt
from pathlib import Path

from opencode_mem.store import MemoryStore


def test_mark_stuck_raw_event_batches_as_error(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    now = dt.datetime.now(dt.UTC)
    old = (now - dt.timedelta(minutes=10)).isoformat()
    recent = (now - dt.timedelta(minutes=1)).isoformat()

    store.conn.execute(
        """
        INSERT INTO raw_event_flush_batches(
            opencode_session_id,
            start_event_seq,
            end_event_seq,
            extractor_version,
            status,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        ("sess", 0, 1, "v1", "started", old, old),
    )
    store.conn.execute(
        """
        INSERT INTO raw_event_flush_batches(
            opencode_session_id,
            start_event_seq,
            end_event_seq,
            extractor_version,
            status,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        ("sess", 2, 3, "v1", "started", recent, recent),
    )
    store.conn.commit()

    cutoff = (now - dt.timedelta(minutes=5)).isoformat()
    updated = store.mark_stuck_raw_event_batches_as_error(older_than_iso=cutoff, limit=10)
    assert updated == 1

    statuses = {
        row["start_event_seq"]: row["status"]
        for row in store.conn.execute(
            "SELECT start_event_seq, status FROM raw_event_flush_batches ORDER BY start_event_seq"
        ).fetchall()
    }
    assert statuses[0] == "error"
    assert statuses[2] == "started"
