from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .. import db

if TYPE_CHECKING:
    from ._store import MemoryStore


def record_usage(
    store: MemoryStore,
    event: str,
    session_id: int | None = None,
    tokens_read: int = 0,
    tokens_written: int = 0,
    tokens_saved: int = 0,
    metadata: dict[str, Any] | None = None,
) -> int:
    created_at = dt.datetime.now(dt.UTC).isoformat()
    cur = store.conn.execute(
        """
        INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            session_id,
            event,
            int(tokens_read),
            int(tokens_written),
            int(tokens_saved),
            created_at,
            db.to_json(metadata),
        ),
    )
    store.conn.commit()
    lastrowid = cur.lastrowid
    if lastrowid is None:
        raise RuntimeError("Failed to record usage")
    return int(lastrowid)


def usage_summary(store: MemoryStore, project: str | None = None) -> list[dict[str, Any]]:
    if not project:
        rows = store.conn.execute(
            """
            SELECT event,
                   COUNT(*) AS count,
                   COALESCE(SUM(tokens_read), 0) AS tokens_read,
                   COALESCE(SUM(tokens_written), 0) AS tokens_written,
                   COALESCE(SUM(tokens_saved), 0) AS tokens_saved
            FROM usage_events
            GROUP BY event
            ORDER BY event
            """
        ).fetchall()
        return db.rows_to_dicts(rows)

    session_clause, session_params = store._project_column_clause("sessions.project", project)
    meta_project_expr = (
        "CASE WHEN json_valid(usage_events.metadata_json) = 1 "
        "THEN json_extract(usage_events.metadata_json, '$.project') ELSE NULL END"
    )
    meta_clause, meta_params = store._project_column_clause(meta_project_expr, project)
    if not session_clause and not meta_clause:
        return []
    rows = store.conn.execute(
        f"""
        SELECT usage_events.event AS event,
               COUNT(*) AS count,
               COALESCE(SUM(usage_events.tokens_read), 0) AS tokens_read,
               COALESCE(SUM(usage_events.tokens_written), 0) AS tokens_written,
               COALESCE(SUM(usage_events.tokens_saved), 0) AS tokens_saved
        FROM usage_events
        LEFT JOIN sessions ON sessions.id = usage_events.session_id
        WHERE ({session_clause} OR {meta_clause})
        GROUP BY usage_events.event
        ORDER BY usage_events.event
        """,
        (*session_params, *meta_params),
    ).fetchall()
    return db.rows_to_dicts(rows)


def usage_totals(store: MemoryStore, project: str | None = None) -> dict[str, Any]:
    if not project:
        row = store.conn.execute(
            """
            SELECT COUNT(*) as count,
                   COALESCE(SUM(tokens_read), 0) as tokens_read,
                   COALESCE(SUM(tokens_written), 0) as tokens_written,
                   COALESCE(SUM(tokens_saved), 0) as tokens_saved
            FROM usage_events
            """
        ).fetchone()
        return {
            "events": int(row["count"] or 0) if row else 0,
            "tokens_read": int(row["tokens_read"] or 0) if row else 0,
            "tokens_written": int(row["tokens_written"] or 0) if row else 0,
            "tokens_saved": int(row["tokens_saved"] or 0) if row else 0,
            "work_investment_tokens": store.work_investment_tokens(),
            "work_investment_tokens_sum": store.work_investment_tokens_sum(),
        }

    session_clause, session_params = store._project_column_clause("sessions.project", project)
    meta_project_expr = (
        "CASE WHEN json_valid(usage_events.metadata_json) = 1 "
        "THEN json_extract(usage_events.metadata_json, '$.project') ELSE NULL END"
    )
    meta_clause, meta_params = store._project_column_clause(meta_project_expr, project)
    if not session_clause and not meta_clause:
        return {
            "events": 0,
            "tokens_read": 0,
            "tokens_written": 0,
            "tokens_saved": 0,
            "work_investment_tokens": 0,
            "work_investment_tokens_sum": 0,
        }
    row = store.conn.execute(
        f"""
        SELECT COUNT(*) as count,
               COALESCE(SUM(usage_events.tokens_read), 0) as tokens_read,
               COALESCE(SUM(usage_events.tokens_written), 0) as tokens_written,
               COALESCE(SUM(usage_events.tokens_saved), 0) as tokens_saved
        FROM usage_events
        LEFT JOIN sessions ON sessions.id = usage_events.session_id
        WHERE ({session_clause} OR {meta_clause})
        """,
        (*session_params, *meta_params),
    ).fetchone()
    return {
        "events": int(row["count"] or 0) if row else 0,
        "tokens_read": int(row["tokens_read"] or 0) if row else 0,
        "tokens_written": int(row["tokens_written"] or 0) if row else 0,
        "tokens_saved": int(row["tokens_saved"] or 0) if row else 0,
        "work_investment_tokens": store.work_investment_tokens(project=project),
        "work_investment_tokens_sum": store.work_investment_tokens_sum(project=project),
    }


def recent_pack_events(
    store: MemoryStore, limit: int = 10, project: str | None = None
) -> list[dict[str, Any]]:
    if project:
        session_clause, session_params = store._project_column_clause("sessions.project", project)
        meta_project_expr = (
            "CASE WHEN json_valid(usage_events.metadata_json) = 1 "
            "THEN json_extract(usage_events.metadata_json, '$.project') ELSE NULL END"
        )
        meta_clause, meta_params = store._project_column_clause(meta_project_expr, project)
        if not session_clause and not meta_clause:
            return []
        rows = store.conn.execute(
            f"""
            SELECT usage_events.id, usage_events.session_id, usage_events.event,
                   usage_events.tokens_read, usage_events.tokens_written, usage_events.tokens_saved,
                   usage_events.created_at, usage_events.metadata_json
            FROM usage_events
            LEFT JOIN sessions ON sessions.id = usage_events.session_id
            WHERE event = 'pack'
              AND ({session_clause} OR {meta_clause})
            ORDER BY usage_events.created_at DESC, usage_events.id DESC
            LIMIT ?
            """,
            (*session_params, *meta_params, limit),
        ).fetchall()
    else:
        rows = store.conn.execute(
            """
            SELECT id, session_id, event, tokens_read, tokens_written, tokens_saved,
                   created_at, metadata_json
            FROM usage_events
            WHERE event = 'pack'
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    results = db.rows_to_dicts(rows)
    for item in results:
        item["metadata_json"] = db.from_json(item.get("metadata_json"))
    return results


def latest_pack_per_project(store: MemoryStore) -> list[dict[str, Any]]:
    """Return the most recent pack event for each project."""
    rows = store.conn.execute(
        """
        SELECT id, session_id, event, tokens_read, tokens_written, tokens_saved,
               created_at, metadata_json
        FROM usage_events
        WHERE event = 'pack'
          AND id IN (
              SELECT MAX(id)
              FROM usage_events
              WHERE event = 'pack'
                AND json_extract(metadata_json, '$.project') IS NOT NULL
              GROUP BY json_extract(metadata_json, '$.project')
          )
        ORDER BY created_at DESC
        """
    ).fetchall()
    results = db.rows_to_dicts(rows)
    for item in results:
        item["metadata_json"] = db.from_json(item.get("metadata_json"))
    return results


def stats(store: MemoryStore) -> dict[str, Any]:
    total_memories = store.conn.execute("SELECT COUNT(*) FROM memory_items").fetchone()[0]
    active_memories = store.conn.execute(
        "SELECT COUNT(*) FROM memory_items WHERE active = 1"
    ).fetchone()[0]
    sessions = store.conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    artifacts = store.conn.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0]
    db_path = str(store.db_path)
    size_bytes = Path(db_path).stat().st_size if Path(db_path).exists() else 0

    vector_rows = store.conn.execute("SELECT COUNT(*) FROM memory_vectors").fetchone()
    vector_count = vector_rows[0] if vector_rows else 0
    vector_coverage = 0.0
    if active_memories:
        vector_coverage = min(1.0, float(vector_count) / float(active_memories))

    tags_filled = store.conn.execute(
        "SELECT COUNT(*) FROM memory_items WHERE active = 1 AND TRIM(tags_text) != ''"
    ).fetchone()[0]
    tags_coverage = 0.0
    if active_memories:
        tags_coverage = min(1.0, float(tags_filled) / float(active_memories))

    raw_events = store.conn.execute("SELECT COUNT(*) FROM raw_events").fetchone()[0]

    usage_rows = store.conn.execute(
        """
        SELECT event, COUNT(*) as count, SUM(tokens_read) as tokens_read,
               SUM(tokens_written) as tokens_written, SUM(tokens_saved) as tokens_saved
        FROM usage_events
        GROUP BY event
        ORDER BY count DESC
        """
    ).fetchall()
    usage = {
        "events": [dict(row) for row in usage_rows],
        "totals": {
            "events": sum(row["count"] for row in usage_rows),
            "tokens_read": sum(row["tokens_read"] or 0 for row in usage_rows),
            "tokens_written": sum(row["tokens_written"] or 0 for row in usage_rows),
            "tokens_saved": sum(row["tokens_saved"] or 0 for row in usage_rows),
            "work_investment_tokens": store.work_investment_tokens(),
            "work_investment_tokens_sum": store.work_investment_tokens_sum(),
        },
    }

    return {
        "database": {
            "path": db_path,
            "size_bytes": size_bytes,
            "sessions": sessions,
            "memory_items": total_memories,
            "active_memory_items": active_memories,
            "artifacts": artifacts,
            "vector_rows": vector_count,
            "vector_coverage": vector_coverage,
            "tags_filled": tags_filled,
            "tags_coverage": tags_coverage,
            "raw_events": raw_events,
        },
        "usage": usage,
        "reliability": store.raw_event_reliability_metrics(),
    }
