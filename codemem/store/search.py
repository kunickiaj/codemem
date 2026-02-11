from __future__ import annotations

import datetime as dt
import difflib
import re
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any, cast

from .. import db
from ..semantic import embed_texts
from .types import MemoryResult

if TYPE_CHECKING:
    from ._store import MemoryStore


def search_index(
    store: MemoryStore,
    query: str,
    limit: int = 10,
    filters: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    results = search(store, query, limit=limit, filters=filters, log_usage=False)
    index_items = [
        {
            "id": item.id,
            "kind": item.kind,
            "title": item.title,
            "score": item.score,
            "created_at": item.created_at,
            "session_id": item.session_id,
        }
        for item in results
    ]
    tokens_read = sum(store.estimate_tokens(item["title"]) for item in index_items)
    store.record_usage(
        "search_index",
        tokens_read=tokens_read,
        metadata={
            "limit": limit,
            "results": len(index_items),
            "project": (filters or {}).get("project"),
        },
    )
    return index_items


def timeline(
    store: MemoryStore,
    query: str | None = None,
    memory_id: int | None = None,
    depth_before: int = 3,
    depth_after: int = 3,
    filters: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    anchor: MemoryResult | dict[str, Any] | None = None
    if memory_id is not None:
        item = store.get(memory_id)
        if item:
            anchor = item
    if anchor is None and query:
        matches = search(store, query, limit=1, filters=filters, log_usage=False)
        if matches:
            anchor = matches[0]
    if anchor is None:
        return []
    timeline_items = _timeline_around(store, anchor, depth_before, depth_after, filters)
    tokens_read = sum(
        store.estimate_tokens(f"{item.get('title', '')} {item.get('body_text', '')}")
        for item in timeline_items
    )
    store.record_usage(
        "timeline",
        tokens_read=tokens_read,
        metadata={
            "depth_before": depth_before,
            "depth_after": depth_after,
            "project": (filters or {}).get("project"),
        },
    )
    return timeline_items


def _expand_query(query: str) -> str:
    tokens = re.findall(r"[A-Za-z0-9_]+", query)
    tokens = [token for token in tokens if token.lower() not in {"or", "and", "not"}]
    if not tokens:
        return ""
    if len(tokens) == 1:
        return tokens[0]
    return " OR ".join(tokens)


def _query_looks_like_tasks(query: str) -> bool:
    lowered = query.lower()
    if any(
        token in lowered
        for token in (
            "todo",
            "todos",
            "pending",
            "task",
            "tasks",
            "next",
            "resume",
            "continue",
            "backlog",
        )
    ):
        return True
    return any(
        phrase in lowered
        for phrase in (
            "follow up",
            "follow-up",
            "followups",
            "pick up",
            "pick-up",
            "left off",
            "where we left off",
            "work on next",
            "what's next",
            "what was next",
        )
    )


def _query_looks_like_recall(query: str) -> bool:
    lowered = query.lower()
    if any(
        token in lowered
        for token in (
            "remember",
            "remind",
            "recall",
            "recap",
            "summary",
            "summarize",
        )
    ):
        return True
    return any(
        phrase in lowered
        for phrase in (
            "what did we do",
            "what did we work on",
            "what did we decide",
            "what happened",
            "last time",
            "previous session",
            "previous work",
            "where were we",
            "catch me up",
            "catch up",
        )
    )


def _task_query_hint() -> str:
    return "todo todos task tasks pending follow up follow-up next resume continue backlog pick up pick-up"


def _recall_query_hint() -> str:
    return "session summary recap remember last time previous work"


def _task_fallback_recent(
    store: MemoryStore, limit: int, filters: dict[str, Any] | None
) -> list[dict[str, Any]]:
    expanded_limit = max(limit * 3, limit)
    results = store.recent(limit=expanded_limit, filters=filters)
    return _prioritize_task_results(results, limit)


def _recall_fallback_recent(
    store: MemoryStore, limit: int, filters: dict[str, Any] | None
) -> list[dict[str, Any]]:
    summary_filters = dict(filters or {})
    summary_filters["kind"] = "session_summary"
    summaries = store.recent(limit=limit, filters=summary_filters)
    if len(summaries) >= limit:
        return summaries[:limit]
    expanded_limit = max(limit * 3, limit)
    recent_all = store.recent(limit=expanded_limit, filters=filters)
    summary_ids = {item.get("id") for item in summaries}
    remainder = [item for item in recent_all if item.get("id") not in summary_ids]
    remainder = _prioritize_task_results(remainder, limit - len(summaries))
    return summaries + remainder


def _created_at_for(item: MemoryResult | dict[str, Any]) -> str:
    if isinstance(item, MemoryResult):
        return item.created_at
    return item.get("created_at", "")


def _parse_created_at(value: str) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=dt.UTC)
    return parsed


def _recency_score(created_at: str) -> float:
    parsed = _parse_created_at(created_at)
    if not parsed:
        return 0.0
    days_ago = (dt.datetime.now(dt.UTC) - parsed).days
    return 1.0 / (1.0 + (days_ago / 7.0))


def _kind_bonus(kind: str | None) -> float:
    if kind == "session_summary":
        return 0.25
    if kind == "decision":
        return 0.2
    if kind == "note":
        return 0.15
    if kind == "observation":
        return 0.1
    if kind == "entities":
        return 0.05
    return 0.0


def _filter_recent_results(
    results: Sequence[MemoryResult | dict[str, Any]],
    days: int,
) -> list[MemoryResult | dict[str, Any]]:
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(days=days)
    filtered: list[MemoryResult | dict[str, Any]] = []
    for item in results:
        created_at = _parse_created_at(_created_at_for(item))
        if created_at and created_at >= cutoff:
            filtered.append(item)
    return filtered


def _tokenize_query(query: str, stopwords: set[str]) -> list[str]:
    tokens = [token.lower() for token in re.findall(r"[A-Za-z0-9_]+", query)]
    return [token for token in tokens if token not in stopwords]


def _fuzzy_score(query_tokens: list[str], query: str, text: str) -> float:
    text_lower = text.lower()
    if not text_lower.strip():
        return 0.0
    match_tokens = set(re.findall(r"[A-Za-z0-9_]+", text_lower))
    overlap = 0.0
    if query_tokens:
        overlap = len(set(query_tokens) & match_tokens) / max(len(query_tokens), 1)
    ratio = difflib.SequenceMatcher(None, query.lower(), text_lower).ratio()
    return max(overlap, ratio)


def _fuzzy_search(
    store: MemoryStore,
    query: str,
    limit: int,
    filters: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    query_tokens = _tokenize_query(query, store.STOPWORDS)
    if not query_tokens:
        return []
    candidate_limit = max(store.FUZZY_CANDIDATE_LIMIT, limit * 10)
    candidates = store.recent(limit=candidate_limit, filters=filters)
    scored: list[tuple[float, dict[str, Any]]] = []
    for item in candidates:
        text = f"{item.get('title', '')} {item.get('body_text', '')}"
        score = _fuzzy_score(query_tokens, query, text)
        if score >= store.FUZZY_MIN_SCORE:
            scored.append((score, item))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in scored[:limit]]


def _semantic_search(
    store: MemoryStore,
    query: str,
    limit: int,
    filters: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    if len(query.strip()) < 3:
        return []
    embeddings = embed_texts([query])
    if not embeddings:
        return []
    query_embedding = embeddings[0]
    params: list[Any] = [query_embedding, limit]
    where_clauses = ["memory_items.active = 1"]
    join_sessions = False
    if filters:
        if filters.get("kind"):
            where_clauses.append("memory_items.kind = ?")
            params.append(filters["kind"])
        if filters.get("session_id"):
            where_clauses.append("memory_items.session_id = ?")
            params.append(filters["session_id"])
        if filters.get("since"):
            where_clauses.append("memory_items.created_at >= ?")
            params.append(filters["since"])
        if filters.get("project"):
            clause, clause_params = store._project_clause(filters["project"])
            if clause:
                where_clauses.append(clause)
                params.extend(clause_params)
            join_sessions = True
    where = " AND ".join(where_clauses)
    join_clause = "JOIN sessions ON sessions.id = memory_items.session_id" if join_sessions else ""
    sql = f"""
        SELECT memory_items.*, memory_vectors.distance
        FROM memory_vectors
        JOIN memory_items ON memory_items.id = memory_vectors.memory_id
        {join_clause}
        WHERE memory_vectors.embedding MATCH ?
          AND k = ?
          AND {where}
        ORDER BY memory_vectors.distance ASC
    """
    rows = store.conn.execute(sql, params).fetchall()
    results = []
    for row in rows:
        results.append(
            {
                "id": row["id"],
                "kind": row["kind"],
                "title": row["title"],
                "body_text": row["body_text"],
                "confidence": row["confidence"],
                "tags_text": row["tags_text"],
                "metadata_json": row["metadata_json"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "session_id": row["session_id"],
                "score": 1.0 / (1.0 + float(row["distance"])),
            }
        )
    return results


def _prioritize_task_results(
    results: list[dict[str, Any]],
    limit: int,
) -> list[dict[str, Any]]:
    def kind_rank(item: dict[str, Any]) -> int:
        kind = item.get("kind")
        if kind == "note":
            return 0
        if kind == "decision":
            return 1
        if kind == "observation":
            return 2
        return 3

    ordered = sorted(results, key=lambda item: item.get("created_at") or "", reverse=True)
    ordered = sorted(ordered, key=kind_rank)
    return ordered[:limit]


def _prioritize_recall_results(
    results: list[MemoryResult | dict[str, Any]],
    limit: int,
) -> list[MemoryResult | dict[str, Any]]:
    def kind_rank(item: MemoryResult | dict[str, Any]) -> int:
        kind = item.kind if isinstance(item, MemoryResult) else item.get("kind")
        if kind == "session_summary":
            return 0
        if kind == "decision":
            return 1
        if kind == "note":
            return 2
        if kind == "observation":
            return 3
        if kind == "entities":
            return 4
        return 5

    ordered = sorted(results, key=lambda item: _created_at_for(item) or "", reverse=True)
    ordered = sorted(ordered, key=kind_rank)
    return ordered[:limit]


def _rerank_results(
    results: list[MemoryResult],
    limit: int,
    recency_days: int | None = None,
) -> list[MemoryResult]:
    if recency_days:
        recent_results = _filter_recent_results(results, recency_days)
        if recent_results:
            results = cast(list[MemoryResult], list(recent_results))

    def score(item: MemoryResult) -> float:
        return (item.score * 1.5) + _recency_score(item.created_at) + _kind_bonus(item.kind)

    ordered = sorted(results, key=score, reverse=True)
    return ordered[:limit]


def _merge_ranked_results(
    store: MemoryStore,
    results: Sequence[MemoryResult | dict[str, Any]],
    query: str,
    limit: int,
    filters: dict[str, Any] | None,
) -> list[MemoryResult]:
    fts_ids = {
        item.id if isinstance(item, MemoryResult) else item.get("id")
        for item in results
        if item is not None
    }
    vector_results = _semantic_search(store, query, limit=limit, filters=filters)
    merged: list[MemoryResult | dict[str, Any]] = list(results)
    for item in vector_results:
        if item.get("id") in fts_ids:
            continue
        merged.append(item)
    if not merged:
        return []
    reranked: list[MemoryResult] = []
    for item in merged:
        if isinstance(item, MemoryResult):
            reranked.append(item)
            continue
        memory_id = item.get("id")
        kind = item.get("kind")
        title = item.get("title")
        body_text = item.get("body_text")
        created_at = item.get("created_at")
        updated_at = item.get("updated_at")
        session_id = item.get("session_id")
        confidence = item.get("confidence")
        if memory_id is None or kind is None or title is None or body_text is None:
            continue
        if created_at is None or updated_at is None or session_id is None:
            continue
        raw_metadata = item.get("metadata_json") or item.get("metadata")
        metadata = raw_metadata if isinstance(raw_metadata, dict) else db.from_json(raw_metadata)
        reranked.append(
            MemoryResult(
                id=int(memory_id),
                kind=str(kind),
                title=str(title),
                body_text=str(body_text),
                confidence=float(confidence or 0.0),
                created_at=str(created_at),
                updated_at=str(updated_at),
                tags_text=str(item.get("tags_text") or ""),
                score=float(item.get("score") or 0.0),
                session_id=int(session_id),
                metadata=metadata,
            )
        )
    return _rerank_results(reranked, limit=limit, recency_days=store.RECALL_RECENCY_DAYS)


def _timeline_around(
    store: MemoryStore,
    anchor: MemoryResult | dict[str, Any],
    depth_before: int,
    depth_after: int,
    filters: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    anchor_id = anchor.id if isinstance(anchor, MemoryResult) else anchor.get("id")
    anchor_created_at = (
        anchor.created_at if isinstance(anchor, MemoryResult) else anchor.get("created_at")
    )
    anchor_session_id = (
        anchor.session_id if isinstance(anchor, MemoryResult) else anchor.get("session_id")
    )
    if not anchor_id or not anchor_created_at:
        return []
    filters = filters or {}
    params: list[Any] = []
    join_sessions = False
    where_base = ["memory_items.active = 1"]
    if filters.get("project"):
        clause, clause_params = store._project_clause(filters["project"])
        if clause:
            where_base.append(clause)
            params.extend(clause_params)
        join_sessions = True
    if anchor_session_id:
        where_base.append("memory_items.session_id = ?")
        params.append(anchor_session_id)
    where_clause = " AND ".join(where_base)
    join_clause = "JOIN sessions ON sessions.id = memory_items.session_id" if join_sessions else ""

    before_rows = store.conn.execute(
        f"""
        SELECT memory_items.*
        FROM memory_items
        {join_clause}
        WHERE {where_clause} AND memory_items.created_at < ?
        ORDER BY memory_items.created_at DESC
        LIMIT ?
        """,
        (*params, anchor_created_at, depth_before),
    ).fetchall()
    after_rows = store.conn.execute(
        f"""
        SELECT memory_items.*
        FROM memory_items
        {join_clause}
        WHERE {where_clause} AND memory_items.created_at > ?
        ORDER BY memory_items.created_at ASC
        LIMIT ?
        """,
        (*params, anchor_created_at, depth_after),
    ).fetchall()
    anchor_row = store.conn.execute(
        "SELECT * FROM memory_items WHERE id = ? AND active = 1",
        (anchor_id,),
    ).fetchone()
    rows = list(reversed(before_rows))
    if anchor_row:
        rows.append(anchor_row)
    rows.extend(after_rows)
    results = db.rows_to_dicts(rows)
    for item in results:
        item["metadata_json"] = db.from_json(item.get("metadata_json"))
    return results


def search(
    store: MemoryStore,
    query: str,
    limit: int = 10,
    filters: dict[str, Any] | None = None,
    log_usage: bool = True,
) -> list[MemoryResult]:
    filters = filters or {}
    expanded_query = _expand_query(query)
    if not expanded_query:
        return []
    params: list[Any] = [expanded_query]
    where_clauses = ["memory_items.active = 1", "memory_fts MATCH ?"]
    join_sessions = False
    if filters.get("kind"):
        where_clauses.append("memory_items.kind = ?")
        params.append(filters["kind"])
    if filters.get("session_id"):
        where_clauses.append("memory_items.session_id = ?")
        params.append(filters["session_id"])
    if filters.get("since"):
        where_clauses.append("memory_items.created_at >= ?")
        params.append(filters["since"])
    if filters.get("project"):
        clause, clause_params = store._project_clause(filters["project"])
        if clause:
            where_clauses.append(clause)
            params.extend(clause_params)
        join_sessions = True
    where = " AND ".join(where_clauses)
    join_clause = "JOIN sessions ON sessions.id = memory_items.session_id" if join_sessions else ""
    sql = f"""
        SELECT memory_items.*, -bm25(memory_fts, 1.0, 1.0, 0.25) AS score,
            (1.0 / (1.0 + ((julianday('now') - julianday(memory_items.created_at)) / 7.0))) AS recency
        FROM memory_fts
        JOIN memory_items ON memory_items.id = memory_fts.rowid
        {join_clause}
        WHERE {where}
        ORDER BY (score * 1.5 + recency) DESC
        LIMIT ?
    """
    params.append(limit)
    rows = store.conn.execute(sql, params).fetchall()
    results: list[MemoryResult] = []
    for row in rows:
        metadata = db.from_json(row["metadata_json"])
        results.append(
            MemoryResult(
                id=row["id"],
                kind=row["kind"],
                title=row["title"],
                body_text=row["body_text"],
                confidence=row["confidence"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                tags_text=row["tags_text"],
                score=float(row["score"]),
                session_id=row["session_id"],
                metadata=metadata,
            )
        )
    if log_usage:
        tokens_read = sum(
            store.estimate_tokens(f"{item.title} {item.body_text}") for item in results
        )
        store.record_usage(
            "search",
            tokens_read=tokens_read,
            metadata={
                "limit": limit,
                "results": len(results),
                "kind": filters.get("kind"),
                "project": filters.get("project"),
            },
        )
    return results
