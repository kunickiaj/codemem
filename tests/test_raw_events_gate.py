from __future__ import annotations

import datetime as dt
from pathlib import Path

from typer.testing import CliRunner

from codemem.cli import app
from codemem.store import MemoryStore

runner = CliRunner()


def _seed_reliability_fixture(store: MemoryStore) -> None:
    now = dt.datetime.now(dt.UTC).isoformat()
    store.conn.execute(
        """
        INSERT INTO raw_event_sessions(opencode_session_id, project, started_at, updated_at)
        VALUES (?, ?, ?, ?)
        """,
        ("sess-a", "proj-a", now, now),
    )
    store.conn.execute(
        """
        INSERT INTO raw_event_sessions(opencode_session_id, project, started_at, updated_at)
        VALUES (?, ?, ?, ?)
        """,
        ("sess-b", "proj-b", None, now),
    )
    store.conn.execute(
        """
        INSERT INTO raw_events(
            opencode_session_id,
            event_id,
            event_seq,
            event_type,
            ts_wall_ms,
            ts_mono_ms,
            payload_json,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("sess-a", "evt-a-1", 0, "user_prompt", 1, 1.0, "{}", now),
    )
    store.conn.execute(
        """
        INSERT INTO raw_events(
            opencode_session_id,
            event_id,
            event_seq,
            event_type,
            ts_wall_ms,
            ts_mono_ms,
            payload_json,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("sess-b", "evt-b-1", 0, "user_prompt", 2, 2.0, "{}", now),
    )

    store.conn.execute(
        """
        INSERT INTO raw_event_ingest_stats(
            id,
            inserted_events,
            skipped_events,
            skipped_invalid,
            skipped_duplicate,
            skipped_conflict,
            updated_at
        )
        VALUES (1, 90, 10, 10, 0, 0, ?)
        ON CONFLICT(id) DO UPDATE SET
            inserted_events = excluded.inserted_events,
            skipped_events = excluded.skipped_events,
            skipped_invalid = excluded.skipped_invalid,
            skipped_duplicate = excluded.skipped_duplicate,
            skipped_conflict = excluded.skipped_conflict,
            updated_at = excluded.updated_at
        """,
        (now,),
    )
    store.conn.execute(
        """
        INSERT INTO raw_event_ingest_samples(
            created_at,
            inserted_events,
            skipped_invalid,
            skipped_duplicate,
            skipped_conflict
        )
        VALUES (?, ?, ?, ?, ?)
        """,
        (now, 90, 10, 0, 0),
    )
    for i in range(9):
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
            ("sess-a", i, i, "v1", "completed", now, now, 1),
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
            updated_at,
            attempt_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("sess-a", 10, 10, "v1", "error", now, now, 2),
    )
    store.conn.commit()


def test_raw_event_reliability_metrics_formula_values(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        _seed_reliability_fixture(store)
        metrics = store.raw_event_reliability_metrics(window_hours=24)
    finally:
        store.close()

    assert metrics["rates"]["flush_success_rate"] == 0.9
    assert metrics["rates"]["dropped_event_rate"] == 0.1
    assert metrics["rates"]["session_boundary_accuracy"] == 0.5
    assert metrics["retry_depth_max"] == 1


def test_store_stats_includes_reliability_block(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        _seed_reliability_fixture(store)
        payload = store.stats()
    finally:
        store.close()

    assert "reliability" in payload
    assert "formulas" in payload["reliability"]


def test_raw_events_gate_exits_nonzero_on_threshold_violation(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    store = MemoryStore(db_path)
    try:
        _seed_reliability_fixture(store)
    finally:
        store.close()

    result = runner.invoke(
        app,
        [
            "raw-events-gate",
            "--db-path",
            str(db_path),
            "--min-flush-success-rate",
            "0.95",
        ],
    )

    assert result.exit_code == 1
    assert "reliability gate failed" in result.stdout


def test_raw_events_gate_passes_on_empty_database(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    store = MemoryStore(db_path)
    store.close()

    result = runner.invoke(app, ["raw-events-gate", "--db-path", str(db_path)])

    assert result.exit_code == 1
    assert "eligible_events=0 < min 1" in result.stdout


def test_raw_events_gate_can_allow_empty_sample_when_requested(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    store = MemoryStore(db_path)
    store.close()

    result = runner.invoke(
        app,
        [
            "raw-events-gate",
            "--db-path",
            str(db_path),
            "--min-events",
            "0",
            "--min-batches",
            "0",
            "--min-sessions",
            "0",
        ],
    )

    assert result.exit_code == 0
    assert "reliability gate passed" in result.stdout


def test_duplicate_replay_does_not_increase_dropped_rate(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    try:
        assert (
            store.record_raw_event(
                opencode_session_id="sess",
                event_id="evt-1",
                event_type="user_prompt",
                payload={"type": "user_prompt", "prompt_text": "hello"},
                ts_wall_ms=1,
                ts_mono_ms=1.0,
            )
            is True
        )
        assert (
            store.record_raw_event(
                opencode_session_id="sess",
                event_id="evt-1",
                event_type="user_prompt",
                payload={"type": "user_prompt", "prompt_text": "hello"},
                ts_wall_ms=2,
                ts_mono_ms=2.0,
            )
            is False
        )
        metrics = store.raw_event_reliability_metrics()
    finally:
        store.close()

    assert metrics["counts"]["inserted_events"] == 1
    assert metrics["counts"]["skipped_duplicate"] == 1
    assert metrics["counts"]["dropped_events"] == 0
    assert metrics["rates"]["dropped_event_rate"] == 0.0


def test_raw_events_gate_rejects_invalid_threshold_args(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    store = MemoryStore(db_path)
    store.close()

    result = runner.invoke(
        app,
        ["raw-events-gate", "--db-path", str(db_path), "--min-flush-success-rate", "1.5"],
    )

    assert result.exit_code != 0
    assert "Invalid value" in result.stderr
