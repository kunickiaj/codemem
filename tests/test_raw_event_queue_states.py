from __future__ import annotations

import datetime as dt
from pathlib import Path

from codemem.store import MemoryStore


def test_raw_event_queue_status_counts_maps_legacy_states(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        now = dt.datetime.now(dt.UTC).isoformat()
        rows = [
            ("started", 0),
            ("running", 1),
            ("completed", 2),
            ("error", 3),
        ]
        for status, seq in rows:
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
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                ("sess", seq, seq, "v1", status, now, now),
            )
        store.conn.commit()

        counts = store.raw_event_queue_status_counts("sess")
    finally:
        store.close()

    assert counts == {"pending": 1, "claimed": 1, "completed": 1, "failed": 1}


def test_raw_event_batch_status_counts_handles_canonical_states(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        now = dt.datetime.now(dt.UTC).isoformat()
        rows = [
            ("pending", 0),
            ("claimed", 1),
            ("completed", 2),
            ("failed", 3),
        ]
        for status, seq in rows:
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
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                ("sess", seq, seq, "v1", status, now, now),
            )
        store.conn.commit()

        legacy_counts = store.raw_event_batch_status_counts("sess")
        canonical_counts = store.raw_event_queue_status_counts("sess")
    finally:
        store.close()

    assert legacy_counts == {"started": 1, "running": 1, "completed": 1, "error": 1}
    assert canonical_counts == {"pending": 1, "claimed": 1, "completed": 1, "failed": 1}


def test_raw_event_flush_batch_claim_is_single_owner(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        batch_id, _status = store.get_or_create_raw_event_flush_batch(
            opencode_session_id="sess",
            start_event_seq=0,
            end_event_seq=1,
            extractor_version="v1",
        )

        first_claim = store.claim_raw_event_flush_batch(batch_id)
        second_claim = store.claim_raw_event_flush_batch(batch_id)

        row = store.conn.execute(
            "SELECT status, attempt_count FROM raw_event_flush_batches WHERE id = ?",
            (batch_id,),
        ).fetchone()
    finally:
        store.close()

    assert first_claim is True
    assert second_claim is False
    assert row is not None
    assert row["status"] == "claimed"
    assert int(row["attempt_count"]) == 1


def test_raw_event_failed_batch_is_recoverable_by_reclaim(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        batch_id, _status = store.get_or_create_raw_event_flush_batch(
            opencode_session_id="sess",
            start_event_seq=5,
            end_event_seq=6,
            extractor_version="v1",
        )
        assert store.claim_raw_event_flush_batch(batch_id) is True
        store.update_raw_event_flush_batch_status(batch_id, "error")

        reclaimed = store.claim_raw_event_flush_batch(batch_id)
        row = store.conn.execute(
            "SELECT status, attempt_count FROM raw_event_flush_batches WHERE id = ?",
            (batch_id,),
        ).fetchone()
    finally:
        store.close()

    assert reclaimed is True
    assert row is not None
    assert row["status"] == "claimed"
    assert int(row["attempt_count"]) == 2


def test_raw_event_failed_canonical_batch_is_recoverable_by_reclaim(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        now = dt.datetime.now(dt.UTC).isoformat()
        store.conn.execute(
            """
            INSERT INTO raw_event_flush_batches(
                opencode_session_id,
                start_event_seq,
                end_event_seq,
                extractor_version,
                status,
                created_at,
                updated_at,
                attempt_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            ("sess", 10, 11, "v1", "failed", now, now, 1),
        )
        batch_id = int(store.conn.execute("SELECT id FROM raw_event_flush_batches").fetchone()[0])
        store.conn.commit()

        reclaimed = store.claim_raw_event_flush_batch(batch_id)
        row = store.conn.execute(
            "SELECT status, attempt_count FROM raw_event_flush_batches WHERE id = ?",
            (batch_id,),
        ).fetchone()
    finally:
        store.close()

    assert reclaimed is True
    assert row is not None
    assert row["status"] == "claimed"
    assert int(row["attempt_count"]) == 2
