from __future__ import annotations

import datetime as dt
import sqlite3
import time
from typing import Any

from .. import db

RAW_EVENT_QUEUE_PENDING = "pending"
RAW_EVENT_QUEUE_CLAIMED = "claimed"
RAW_EVENT_QUEUE_COMPLETED = "completed"
RAW_EVENT_QUEUE_FAILED = "failed"

_RAW_EVENT_QUEUE_DB_TO_CANONICAL = {
    "started": RAW_EVENT_QUEUE_PENDING,
    "running": RAW_EVENT_QUEUE_CLAIMED,
    RAW_EVENT_QUEUE_PENDING: RAW_EVENT_QUEUE_PENDING,
    RAW_EVENT_QUEUE_CLAIMED: RAW_EVENT_QUEUE_CLAIMED,
    "completed": RAW_EVENT_QUEUE_COMPLETED,
    RAW_EVENT_QUEUE_COMPLETED: RAW_EVENT_QUEUE_COMPLETED,
    "error": RAW_EVENT_QUEUE_FAILED,
    RAW_EVENT_QUEUE_FAILED: RAW_EVENT_QUEUE_FAILED,
}


def _update_raw_event_ingest_stats(
    conn: sqlite3.Connection,
    *,
    inserted_events: int,
    skipped_invalid: int,
    skipped_duplicate: int,
    skipped_conflict: int,
) -> None:
    now = dt.datetime.now(dt.UTC).isoformat()
    skipped_events = skipped_invalid + skipped_duplicate + skipped_conflict
    conn.execute(
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
        (now, inserted_events, skipped_invalid, skipped_duplicate, skipped_conflict),
    )
    conn.execute(
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
        VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            inserted_events = inserted_events + excluded.inserted_events,
            skipped_events = skipped_events + excluded.skipped_events,
            skipped_invalid = skipped_invalid + excluded.skipped_invalid,
            skipped_duplicate = skipped_duplicate + excluded.skipped_duplicate,
            skipped_conflict = skipped_conflict + excluded.skipped_conflict,
            updated_at = excluded.updated_at
        """,
        (
            inserted_events,
            skipped_events,
            skipped_invalid,
            skipped_duplicate,
            skipped_conflict,
            now,
        ),
    )


def get_or_create_raw_event_flush_batch(
    conn: sqlite3.Connection,
    *,
    opencode_session_id: str,
    start_event_seq: int,
    end_event_seq: int,
    extractor_version: str,
) -> tuple[int, str]:
    now = dt.datetime.now(dt.UTC).isoformat()
    cur = conn.execute(
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
        ON CONFLICT(opencode_session_id, start_event_seq, end_event_seq, extractor_version)
        DO UPDATE SET updated_at = excluded.updated_at
        RETURNING id, status
        """,
        (
            opencode_session_id,
            start_event_seq,
            end_event_seq,
            extractor_version,
            RAW_EVENT_QUEUE_PENDING,
            now,
            now,
        ),
    )
    row = cur.fetchone()
    if row is None:
        raise RuntimeError("Failed to create flush batch")
    conn.commit()
    db_status = str(row["status"])
    return int(row["id"]), _RAW_EVENT_QUEUE_DB_TO_CANONICAL.get(db_status, db_status)


def update_raw_event_flush_batch_status(
    conn: sqlite3.Connection, batch_id: int, status: str
) -> None:
    now = dt.datetime.now(dt.UTC).isoformat()
    conn.execute(
        "UPDATE raw_event_flush_batches SET status = ?, updated_at = ? WHERE id = ?",
        (status, now, batch_id),
    )
    conn.commit()


def record_raw_event(
    conn: sqlite3.Connection,
    *,
    opencode_session_id: str,
    event_id: str,
    event_type: str,
    payload: dict[str, Any],
    ts_wall_ms: int | None = None,
    ts_mono_ms: float | None = None,
) -> bool:
    if not opencode_session_id.strip():
        raise ValueError("opencode_session_id is required")
    if not event_id.strip():
        raise ValueError("event_id is required")
    if not event_type.strip():
        raise ValueError("event_type is required")

    # Server-assigned sequencing. This avoids event_seq collisions when the plugin reloads.
    cur = conn.execute(
        "SELECT 1 FROM raw_events WHERE opencode_session_id = ? AND event_id = ?",
        (opencode_session_id, event_id),
    ).fetchone()
    if cur is not None:
        _update_raw_event_ingest_stats(
            conn,
            inserted_events=0,
            skipped_invalid=0,
            skipped_duplicate=1,
            skipped_conflict=0,
        )
        conn.commit()
        return False

    existing = conn.execute(
        "SELECT 1 FROM raw_event_sessions WHERE opencode_session_id = ?",
        (opencode_session_id,),
    ).fetchone()
    if existing is None:
        now = dt.datetime.now(dt.UTC).isoformat()
        conn.execute(
            """
            INSERT INTO raw_event_sessions(opencode_session_id, updated_at)
            VALUES (?, ?)
            """,
            (opencode_session_id, now),
        )

    row = conn.execute(
        """
        UPDATE raw_event_sessions
        SET last_received_event_seq = last_received_event_seq + 1,
            updated_at = ?
        WHERE opencode_session_id = ?
        RETURNING last_received_event_seq
        """,
        (dt.datetime.now(dt.UTC).isoformat(), opencode_session_id),
    ).fetchone()
    if row is None:
        raise RuntimeError("Failed to allocate raw event seq")
    event_seq = int(row["last_received_event_seq"])

    created_at = dt.datetime.now(dt.UTC).isoformat()
    conn.execute(
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
        (
            opencode_session_id,
            event_id,
            event_seq,
            event_type,
            ts_wall_ms,
            ts_mono_ms,
            db.to_json(payload),
            created_at,
        ),
    )
    _update_raw_event_ingest_stats(
        conn,
        inserted_events=1,
        skipped_invalid=0,
        skipped_duplicate=0,
        skipped_conflict=0,
    )
    conn.commit()
    return True


def record_raw_events_batch(
    conn: sqlite3.Connection,
    *,
    opencode_session_id: str,
    events: list[dict[str, Any]],
) -> dict[str, int]:
    if not opencode_session_id.strip():
        raise ValueError("opencode_session_id is required")
    inserted = 0
    skipped_invalid = 0
    skipped_duplicate = 0
    skipped_conflict = 0
    now = dt.datetime.now(dt.UTC).isoformat()
    with conn:
        existing = conn.execute(
            "SELECT 1 FROM raw_event_sessions WHERE opencode_session_id = ?",
            (opencode_session_id,),
        ).fetchone()
        if existing is None:
            conn.execute(
                "INSERT INTO raw_event_sessions(opencode_session_id, updated_at) VALUES (?, ?)",
                (opencode_session_id, now),
            )

        normalized: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for event in events:
            event_id = str(event.get("event_id") or "")
            event_type = str(event.get("event_type") or "")
            payload = event.get("payload")
            if not isinstance(payload, dict):
                payload = {}
            ts_wall_ms = event.get("ts_wall_ms")
            ts_mono_ms = event.get("ts_mono_ms")
            if not event_id or not event_type:
                skipped_invalid += 1
                continue
            if event_id in seen_ids:
                skipped_duplicate += 1
                continue
            seen_ids.add(event_id)
            normalized.append(
                {
                    "event_id": event_id,
                    "event_type": event_type,
                    "payload": payload,
                    "ts_wall_ms": ts_wall_ms,
                    "ts_mono_ms": ts_mono_ms,
                }
            )

        if not normalized:
            _update_raw_event_ingest_stats(
                conn,
                inserted_events=0,
                skipped_invalid=skipped_invalid,
                skipped_duplicate=skipped_duplicate,
                skipped_conflict=skipped_conflict,
            )
            skipped = skipped_invalid + skipped_duplicate + skipped_conflict
            return {"inserted": 0, "skipped": skipped}

        existing_ids: set[str] = set()
        chunk_size = 500
        for i in range(0, len(normalized), chunk_size):
            chunk = normalized[i : i + chunk_size]
            placeholders = ",".join("?" for _ in chunk)
            rows = conn.execute(
                f"SELECT event_id FROM raw_events WHERE opencode_session_id = ? AND event_id IN ({placeholders})",
                [opencode_session_id, *[e["event_id"] for e in chunk]],
            ).fetchall()
            for row in rows:
                existing_ids.add(str(row["event_id"]))

        new_events = [event for event in normalized if event["event_id"] not in existing_ids]
        skipped_duplicate += len(normalized) - len(new_events)
        if not new_events:
            _update_raw_event_ingest_stats(
                conn,
                inserted_events=0,
                skipped_invalid=skipped_invalid,
                skipped_duplicate=skipped_duplicate,
                skipped_conflict=skipped_conflict,
            )
            skipped = skipped_invalid + skipped_duplicate + skipped_conflict
            return {"inserted": 0, "skipped": skipped}

        row = conn.execute(
            """
            UPDATE raw_event_sessions
            SET last_received_event_seq = last_received_event_seq + ?,
                updated_at = ?
            WHERE opencode_session_id = ?
            RETURNING last_received_event_seq
            """,
            (len(new_events), now, opencode_session_id),
        ).fetchone()
        if row is None:
            raise RuntimeError("Failed to allocate raw event seq")
        end_seq = int(row["last_received_event_seq"])
        start_seq = end_seq - len(new_events) + 1

        for offset, event in enumerate(new_events):
            try:
                conn.execute(
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
                    (
                        opencode_session_id,
                        event["event_id"],
                        start_seq + offset,
                        event["event_type"],
                        event["ts_wall_ms"],
                        event["ts_mono_ms"],
                        db.to_json(event["payload"]),
                        now,
                    ),
                )
            except sqlite3.IntegrityError:
                skipped_conflict += 1
                continue
            inserted += 1
        _update_raw_event_ingest_stats(
            conn,
            inserted_events=inserted,
            skipped_invalid=skipped_invalid,
            skipped_duplicate=skipped_duplicate,
            skipped_conflict=skipped_conflict,
        )
    skipped = skipped_invalid + skipped_duplicate + skipped_conflict
    return {"inserted": inserted, "skipped": skipped}


def raw_event_reliability_metrics(conn: sqlite3.Connection) -> dict[str, Any]:
    return raw_event_reliability_metrics_windowed(conn, window_hours=None)


def raw_event_reliability_metrics_windowed(
    conn: sqlite3.Connection, *, window_hours: float | None
) -> dict[str, Any]:
    cutoff_iso: str | None = None
    if window_hours is not None:
        cutoff_iso = (dt.datetime.now(dt.UTC) - dt.timedelta(hours=window_hours)).isoformat()

    if cutoff_iso is None:
        ingest = conn.execute(
            """
            SELECT
                inserted_events,
                skipped_events,
                skipped_invalid,
                skipped_duplicate,
                skipped_conflict
            FROM raw_event_ingest_stats
            WHERE id = 1
            """
        ).fetchone()
    else:
        ingest = conn.execute(
            """
            SELECT
                COALESCE(SUM(inserted_events), 0) AS inserted_events,
                COALESCE(SUM(skipped_invalid + skipped_duplicate + skipped_conflict), 0) AS skipped_events,
                COALESCE(SUM(skipped_invalid), 0) AS skipped_invalid,
                COALESCE(SUM(skipped_duplicate), 0) AS skipped_duplicate,
                COALESCE(SUM(skipped_conflict), 0) AS skipped_conflict
            FROM raw_event_ingest_samples
            WHERE created_at >= ?
            """,
            (cutoff_iso,),
        ).fetchone()

    inserted_events = int((ingest["inserted_events"] if ingest else 0) or 0)
    skipped_events = int((ingest["skipped_events"] if ingest else 0) or 0)
    skipped_invalid = int((ingest["skipped_invalid"] if ingest else 0) or 0)
    skipped_duplicate = int((ingest["skipped_duplicate"] if ingest else 0) or 0)
    skipped_conflict = int((ingest["skipped_conflict"] if ingest else 0) or 0)
    dropped_events = skipped_invalid + skipped_conflict
    dropped_denominator = inserted_events + dropped_events
    dropped_event_rate = (
        float(dropped_events) / float(dropped_denominator) if dropped_denominator else 0.0
    )

    batch_query = """
        SELECT
            SUM(CASE WHEN status IN ('started', 'pending') THEN 1 ELSE 0 END) AS started,
            SUM(CASE WHEN status IN ('running', 'claimed') THEN 1 ELSE 0 END) AS running,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status IN ('error', 'failed') THEN 1 ELSE 0 END) AS errored,
            COALESCE(MAX(CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END), 0) AS retry_depth_max
        FROM raw_event_flush_batches
    """
    if cutoff_iso is None:
        batch_counts = conn.execute(batch_query).fetchone()
    else:
        batch_counts = conn.execute(
            batch_query + " WHERE updated_at >= ?", (cutoff_iso,)
        ).fetchone()

    started_batches = int((batch_counts["started"] if batch_counts else 0) or 0)
    running_batches = int((batch_counts["running"] if batch_counts else 0) or 0)
    completed_batches = int((batch_counts["completed"] if batch_counts else 0) or 0)
    errored_batches = int((batch_counts["errored"] if batch_counts else 0) or 0)
    retry_depth_max = int((batch_counts["retry_depth_max"] if batch_counts else 0) or 0)
    terminal_batches = completed_batches + errored_batches
    flush_success_rate = (
        float(completed_batches) / float(terminal_batches) if terminal_batches else 1.0
    )

    boundary_query = """
        WITH has_events AS (
            SELECT DISTINCT opencode_session_id
            FROM raw_events
        )
        SELECT
            COUNT(1) AS sessions_with_events,
            SUM(CASE WHEN COALESCE(s.started_at, '') != '' THEN 1 ELSE 0 END) AS sessions_with_started_at
        FROM has_events e
        LEFT JOIN raw_event_sessions s ON s.opencode_session_id = e.opencode_session_id
    """
    if cutoff_iso is None:
        boundary_counts = conn.execute(boundary_query).fetchone()
    else:
        boundary_counts = conn.execute(
            """
            WITH has_events AS (
                SELECT DISTINCT opencode_session_id
                FROM raw_events
                WHERE created_at >= ?
            )
            SELECT
                COUNT(1) AS sessions_with_events,
                SUM(CASE WHEN COALESCE(s.started_at, '') != '' THEN 1 ELSE 0 END) AS sessions_with_started_at
            FROM has_events e
            LEFT JOIN raw_event_sessions s ON s.opencode_session_id = e.opencode_session_id
            """,
            (cutoff_iso,),
        ).fetchone()
    sessions_with_events = int(
        (boundary_counts["sessions_with_events"] if boundary_counts else 0) or 0
    )
    sessions_with_started_at = int(
        (boundary_counts["sessions_with_started_at"] if boundary_counts else 0) or 0
    )
    session_boundary_accuracy = (
        float(sessions_with_started_at) / float(sessions_with_events)
        if sessions_with_events
        else 1.0
    )

    return {
        "formulas": {
            "flush_success_rate": "completed_batches / terminal_batches",
            "dropped_event_rate": "(skipped_invalid + skipped_conflict) / (inserted_events + skipped_invalid + skipped_conflict)",
            "session_boundary_accuracy": "sessions_with_started_at / sessions_with_events",
            "retry_depth_max": "MAX(attempt_count - 1)",
        },
        "counts": {
            "inserted_events": inserted_events,
            "skipped_events": skipped_events,
            "skipped_invalid": skipped_invalid,
            "skipped_duplicate": skipped_duplicate,
            "skipped_conflict": skipped_conflict,
            "dropped_events": dropped_events,
            "started_batches": started_batches,
            "running_batches": running_batches,
            "completed_batches": completed_batches,
            "errored_batches": errored_batches,
            "terminal_batches": terminal_batches,
            "sessions_with_events": sessions_with_events,
            "sessions_with_started_at": sessions_with_started_at,
        },
        "rates": {
            "flush_success_rate": flush_success_rate,
            "dropped_event_rate": dropped_event_rate,
            "session_boundary_accuracy": session_boundary_accuracy,
        },
        "retry_depth_max": retry_depth_max,
        "window_hours": window_hours,
    }


def raw_event_flush_state(conn: sqlite3.Connection, opencode_session_id: str) -> int:
    row = conn.execute(
        "SELECT last_flushed_event_seq FROM raw_event_sessions WHERE opencode_session_id = ?",
        (opencode_session_id,),
    ).fetchone()
    if row is None:
        return -1
    return int(row["last_flushed_event_seq"])


def update_raw_event_session_meta(
    conn: sqlite3.Connection,
    *,
    opencode_session_id: str,
    cwd: str | None = None,
    project: str | None = None,
    started_at: str | None = None,
    last_seen_ts_wall_ms: int | None = None,
) -> None:
    now = dt.datetime.now(dt.UTC).isoformat()
    conn.execute(
        """
        INSERT INTO raw_event_sessions(
            opencode_session_id,
            cwd,
            project,
            started_at,
            last_seen_ts_wall_ms,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(opencode_session_id) DO UPDATE SET
            cwd = COALESCE(excluded.cwd, raw_event_sessions.cwd),
            project = COALESCE(excluded.project, raw_event_sessions.project),
            started_at = COALESCE(excluded.started_at, raw_event_sessions.started_at),
            last_seen_ts_wall_ms = COALESCE(excluded.last_seen_ts_wall_ms, raw_event_sessions.last_seen_ts_wall_ms),
            updated_at = excluded.updated_at
        """,
        (opencode_session_id, cwd, project, started_at, last_seen_ts_wall_ms, now),
    )
    conn.commit()


def raw_event_session_meta(conn: sqlite3.Connection, opencode_session_id: str) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT cwd, project, started_at, last_seen_ts_wall_ms, last_flushed_event_seq
        FROM raw_event_sessions
        WHERE opencode_session_id = ?
        """,
        (opencode_session_id,),
    ).fetchone()
    if row is None:
        return {}
    return {
        "cwd": row["cwd"],
        "project": row["project"],
        "started_at": row["started_at"],
        "last_seen_ts_wall_ms": row["last_seen_ts_wall_ms"],
        "last_flushed_event_seq": row["last_flushed_event_seq"],
    }


def update_raw_event_flush_state(
    conn: sqlite3.Connection, opencode_session_id: str, last_flushed: int
) -> None:
    now = dt.datetime.now(dt.UTC).isoformat()
    conn.execute(
        """
        INSERT INTO raw_event_sessions(opencode_session_id, last_flushed_event_seq, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(opencode_session_id) DO UPDATE SET
            last_flushed_event_seq = excluded.last_flushed_event_seq,
            updated_at = excluded.updated_at
        """,
        (opencode_session_id, last_flushed, now),
    )
    conn.commit()


def max_raw_event_seq(conn: sqlite3.Connection, opencode_session_id: str) -> int:
    row = conn.execute(
        "SELECT MAX(event_seq) AS max_seq FROM raw_events WHERE opencode_session_id = ?",
        (opencode_session_id,),
    ).fetchone()
    if row is None:
        return -1
    value = row["max_seq"]
    return int(value) if value is not None else -1


def raw_events_since(
    conn: sqlite3.Connection,
    *,
    opencode_session_id: str,
    after_event_seq: int,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    limit_clause = "LIMIT ?" if limit else ""
    params: list[Any] = [opencode_session_id, after_event_seq]
    if limit:
        params.append(limit)
    rows = conn.execute(
        f"""
        SELECT event_seq, event_type, ts_wall_ms, ts_mono_ms, payload_json, event_id
        FROM raw_events
        WHERE opencode_session_id = ? AND event_seq > ?
        ORDER BY (ts_mono_ms IS NULL) ASC, ts_mono_ms ASC, event_seq ASC
        {limit_clause}
        """,
        params,
    ).fetchall()
    results: list[dict[str, Any]] = []
    for row in rows:
        payload = db.from_json(row["payload_json"])
        if not isinstance(payload, dict):
            payload = {}
        payload["type"] = payload.get("type") or row["event_type"]
        payload["timestamp_wall_ms"] = row["ts_wall_ms"]
        payload["timestamp_mono_ms"] = row["ts_mono_ms"]
        payload["event_seq"] = row["event_seq"]
        payload["event_id"] = row["event_id"]
        results.append(payload)
    return results


def raw_event_sessions_pending_idle_flush(
    conn: sqlite3.Connection,
    *,
    idle_before_ts_wall_ms: int,
    limit: int = 25,
) -> list[str]:
    rows = conn.execute(
        """
        WITH max_events AS (
            SELECT opencode_session_id, MAX(event_seq) AS max_seq
            FROM raw_events
            GROUP BY opencode_session_id
        )
        SELECT s.opencode_session_id
        FROM raw_event_sessions s
        JOIN max_events e ON e.opencode_session_id = s.opencode_session_id
        WHERE s.last_seen_ts_wall_ms IS NOT NULL
          AND s.last_seen_ts_wall_ms <= ?
          AND e.max_seq > s.last_flushed_event_seq
        ORDER BY s.last_seen_ts_wall_ms ASC
        LIMIT ?
        """,
        (idle_before_ts_wall_ms, limit),
    ).fetchall()
    return [str(row["opencode_session_id"]) for row in rows if row["opencode_session_id"]]


def raw_event_sessions_with_pending_queue(
    conn: sqlite3.Connection,
    *,
    limit: int = 25,
) -> list[str]:
    rows = conn.execute(
        """
        WITH pending_batches AS (
            SELECT
              b.opencode_session_id,
              MIN(b.updated_at) AS oldest_pending_update
            FROM raw_event_flush_batches b
            WHERE b.status IN ('pending', 'failed', 'started', 'error')
            GROUP BY b.opencode_session_id
        ),
        max_events AS (
            SELECT opencode_session_id, MAX(event_seq) AS max_seq
            FROM raw_events
            GROUP BY opencode_session_id
        )
        SELECT b.opencode_session_id
        FROM pending_batches b
        JOIN max_events e ON e.opencode_session_id = b.opencode_session_id
        LEFT JOIN raw_event_sessions s ON s.opencode_session_id = b.opencode_session_id
        WHERE e.max_seq > COALESCE(s.last_flushed_event_seq, -1)
        ORDER BY b.oldest_pending_update ASC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [str(row["opencode_session_id"]) for row in rows if row["opencode_session_id"]]


def purge_raw_events_before(conn: sqlite3.Connection, cutoff_ts_wall_ms: int) -> int:
    cutoff_iso = dt.datetime.fromtimestamp(cutoff_ts_wall_ms / 1000.0, tz=dt.UTC).isoformat()
    conn.execute(
        "DELETE FROM raw_event_ingest_samples WHERE created_at < ?",
        (cutoff_iso,),
    )
    cur = conn.execute(
        "DELETE FROM raw_events WHERE ts_wall_ms IS NOT NULL AND ts_wall_ms < ?",
        (cutoff_ts_wall_ms,),
    )
    conn.commit()
    return int(cur.rowcount or 0)


def purge_raw_events(conn: sqlite3.Connection, max_age_ms: int) -> int:
    if max_age_ms <= 0:
        return 0
    now_ms = int(time.time() * 1000)
    cutoff = now_ms - max_age_ms
    return purge_raw_events_before(conn, cutoff)


def raw_event_backlog(conn: sqlite3.Connection, *, limit: int = 25) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        WITH max_events AS (
            SELECT opencode_session_id, MAX(event_seq) AS max_seq
            FROM raw_events
            GROUP BY opencode_session_id
        )
        SELECT
          s.opencode_session_id,
          s.project,
          s.cwd,
          s.started_at,
          s.last_seen_ts_wall_ms,
          s.last_flushed_event_seq,
          e.max_seq,
          (e.max_seq - s.last_flushed_event_seq) AS pending
        FROM raw_event_sessions s
        JOIN max_events e ON e.opencode_session_id = s.opencode_session_id
        WHERE e.max_seq > s.last_flushed_event_seq
        ORDER BY s.last_seen_ts_wall_ms DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]


def raw_event_backlog_totals(conn: sqlite3.Connection) -> dict[str, int]:
    row = conn.execute(
        """
        WITH max_events AS (
            SELECT opencode_session_id, MAX(event_seq) AS max_seq
            FROM raw_events
            GROUP BY opencode_session_id
        )
        SELECT
          COUNT(1) AS sessions,
          SUM(e.max_seq - s.last_flushed_event_seq) AS pending
        FROM raw_event_sessions s
        JOIN max_events e ON e.opencode_session_id = s.opencode_session_id
        WHERE e.max_seq > s.last_flushed_event_seq
        """
    ).fetchone()
    if row is None:
        return {"sessions": 0, "pending": 0}
    sessions = int(row["sessions"] or 0)
    pending = int(row["pending"] or 0)
    return {"sessions": sessions, "pending": pending}


def raw_event_batch_status_counts(
    conn: sqlite3.Connection, opencode_session_id: str
) -> dict[str, int]:
    rows = conn.execute(
        """
        SELECT status, COUNT(*) AS n
        FROM raw_event_flush_batches
        WHERE opencode_session_id = ?
        GROUP BY status
        """,
        (opencode_session_id,),
    ).fetchall()
    counts = {"started": 0, "running": 0, "completed": 0, "error": 0}
    for row in rows:
        status = str(row["status"] or "")
        canonical = _RAW_EVENT_QUEUE_DB_TO_CANONICAL.get(status)
        if canonical == RAW_EVENT_QUEUE_PENDING:
            counts["started"] += int(row["n"])
        elif canonical == RAW_EVENT_QUEUE_CLAIMED:
            counts["running"] += int(row["n"])
        elif canonical == RAW_EVENT_QUEUE_COMPLETED:
            counts["completed"] += int(row["n"])
        elif canonical == RAW_EVENT_QUEUE_FAILED:
            counts["error"] += int(row["n"])
    return counts


def raw_event_queue_status_counts(
    conn: sqlite3.Connection, opencode_session_id: str
) -> dict[str, int]:
    rows = conn.execute(
        """
        SELECT status, COUNT(*) AS n
        FROM raw_event_flush_batches
        WHERE opencode_session_id = ?
        GROUP BY status
        """,
        (opencode_session_id,),
    ).fetchall()
    counts = {
        RAW_EVENT_QUEUE_PENDING: 0,
        RAW_EVENT_QUEUE_CLAIMED: 0,
        RAW_EVENT_QUEUE_COMPLETED: 0,
        RAW_EVENT_QUEUE_FAILED: 0,
    }
    for row in rows:
        db_status = str(row["status"] or "")
        canonical = _RAW_EVENT_QUEUE_DB_TO_CANONICAL.get(db_status)
        if canonical is None:
            continue
        counts[canonical] += int(row["n"] or 0)
    return counts


def claim_raw_event_flush_batch(conn: sqlite3.Connection, batch_id: int) -> bool:
    now = dt.datetime.now(dt.UTC).isoformat()
    row = conn.execute(
        """
        UPDATE raw_event_flush_batches
        SET status = ?, updated_at = ?, attempt_count = attempt_count + 1
        WHERE id = ? AND status IN (?, ?, 'started', 'error')
        RETURNING id
        """,
        (
            RAW_EVENT_QUEUE_CLAIMED,
            now,
            batch_id,
            RAW_EVENT_QUEUE_PENDING,
            RAW_EVENT_QUEUE_FAILED,
        ),
    ).fetchone()
    conn.commit()
    return row is not None


def raw_event_error_batches(
    conn: sqlite3.Connection, opencode_session_id: str, limit: int = 10
) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, start_event_seq, end_event_seq, extractor_version, status, updated_at
        FROM raw_event_flush_batches
        WHERE opencode_session_id = ? AND status IN ('error', ?)
        ORDER BY updated_at DESC
        LIMIT ?
        """,
        (opencode_session_id, RAW_EVENT_QUEUE_FAILED, limit),
    ).fetchall()
    items: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["status"] = "error"
        items.append(item)
    return items


def mark_stuck_raw_event_batches_as_error(
    conn: sqlite3.Connection,
    *,
    older_than_iso: str,
    limit: int = 100,
) -> int:
    now = dt.datetime.now(dt.UTC).isoformat()
    cur = conn.execute(
        """
        WITH candidates AS (
            SELECT id
            FROM raw_event_flush_batches
            WHERE status IN ('started', 'running', ?, ?) AND updated_at < ?
            ORDER BY updated_at
            LIMIT ?
        )
        UPDATE raw_event_flush_batches
        SET status = ?, updated_at = ?
        WHERE id IN (SELECT id FROM candidates)
        """,
        (
            RAW_EVENT_QUEUE_PENDING,
            RAW_EVENT_QUEUE_CLAIMED,
            older_than_iso,
            limit,
            RAW_EVENT_QUEUE_FAILED,
            now,
        ),
    )
    conn.commit()
    changes = cur.rowcount
    if changes is None or changes < 0:
        row = conn.execute("SELECT changes() AS count").fetchone()
        changes = row["count"] if row else 0
    return int(changes or 0)
