from __future__ import annotations

import datetime as dt
import difflib
import random
import re
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any, cast

from .. import db
from ..memory_kinds import MEMORY_KIND_BONUS, normalize_memory_kind
from ..semantic import embed_texts
from .types import MemoryResult

if TYPE_CHECKING:
    from ._store import MemoryStore


SQLITE_INT64_MIN = -(2**63)
SQLITE_INT64_MAX = (2**63) - 1


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


def explain(
    store: MemoryStore,
    *,
    query: str | None = None,
    ids: Sequence[Any] | None = None,
    limit: int = 10,
    filters: dict[str, Any] | None = None,
    include_pack_context: bool = False,
) -> dict[str, Any]:
    filters = dict(filters or {})
    normalized_query = (query or "").strip()
    ordered_ids, invalid_ids = _dedupe_ordered_ids(ids or [])
    errors: list[dict[str, Any]] = []
    if invalid_ids:
        errors.append(
            {
                "code": "INVALID_ARGUMENT",
                "field": "ids",
                "message": "some ids are not valid integers",
                "ids": invalid_ids,
            }
        )

    if not normalized_query and not ordered_ids:
        errors.append(
            {
                "code": "INVALID_ARGUMENT",
                "field": "query",
                "message": "at least one of query or ids is required",
            }
        )
        return {
            "items": [],
            "missing_ids": [],
            "errors": errors,
            "metadata": {
                "query": None,
                "project": filters.get("project"),
                "requested_ids_count": len(ordered_ids),
                "returned_items_count": 0,
                "include_pack_context": include_pack_context,
            },
        }

    query_results: list[MemoryResult] = []
    if normalized_query:
        query_results = search(
            store,
            normalized_query,
            limit=max(1, int(limit)),
            filters=filters or None,
            log_usage=False,
        )

    query_rank = {item.id: index for index, item in enumerate(query_results, start=1)}
    id_rows, missing_not_found, missing_project_mismatch, missing_filter_mismatch = (
        _load_items_by_ids_for_explain(
            store,
            ordered_ids,
            filters,
        )
    )
    id_by_id = {
        int(item["id"]): MemoryResult(
            id=int(item["id"]),
            kind=str(item["kind"]),
            title=str(item["title"]),
            body_text=str(item["body_text"]),
            confidence=float(item.get("confidence") or 0.0),
            created_at=str(item["created_at"]),
            updated_at=str(item["updated_at"]),
            tags_text=str(item.get("tags_text") or ""),
            score=float(item.get("score") or 0.0),
            session_id=int(item["session_id"]),
            metadata=(
                item["metadata_json"]
                if isinstance(item.get("metadata_json"), dict)
                else db.from_json(item.get("metadata_json"))
            ),
        )
        for item in id_rows
    }

    ordered_items: list[tuple[MemoryResult, str, int | None]] = []
    selected_ids: set[int] = set()
    explicit_id_set = set(ordered_ids)
    for item in query_results:
        selected_ids.add(item.id)
        source = "query+id_lookup" if item.id in explicit_id_set else "query"
        ordered_items.append((item, source, query_rank.get(item.id)))
    for memory_id in ordered_ids:
        if memory_id in selected_ids:
            continue
        item = id_by_id.get(memory_id)
        if item is None:
            continue
        ordered_items.append((item, "id_lookup", None))
        selected_ids.add(memory_id)

    session_projects = _load_session_projects(
        store,
        {item.session_id for item, _, _ in ordered_items},
    )
    query_tokens = _tokenize_query(normalized_query, store.STOPWORDS) if normalized_query else []
    reference_now = dt.datetime.now(dt.UTC)

    items_payload = [
        _explain_item(
            store,
            item=item,
            source=source,
            rank=rank,
            query_tokens=query_tokens,
            project_filter=filters.get("project"),
            project_value=session_projects.get(item.session_id),
            include_pack_context=include_pack_context,
            reference_now=reference_now,
        )
        for item, source, rank in ordered_items
    ]

    missing_not_found_set = set(missing_not_found)
    missing_project_mismatch_set = set(missing_project_mismatch)
    missing_filter_mismatch_set = set(missing_filter_mismatch)
    missing_ids = [
        memory_id
        for memory_id in ordered_ids
        if (
            memory_id in missing_not_found_set
            or memory_id in missing_project_mismatch_set
            or memory_id in missing_filter_mismatch_set
        )
    ]
    if missing_not_found:
        errors.append(
            {
                "code": "NOT_FOUND",
                "field": "ids",
                "message": "some requested ids were not found",
                "ids": missing_not_found,
            }
        )
    if missing_project_mismatch:
        errors.append(
            {
                "code": "PROJECT_MISMATCH",
                "field": "project",
                "message": "some requested ids are outside the requested project scope",
                "ids": missing_project_mismatch,
            }
        )
    if missing_filter_mismatch:
        errors.append(
            {
                "code": "FILTER_MISMATCH",
                "field": "filters",
                "message": "some requested ids do not match the provided filters",
                "ids": missing_filter_mismatch,
            }
        )

    tokens_read = sum(
        store.estimate_tokens(f"{item.title} {item.body_text}") for item, _, _ in ordered_items
    )
    store.record_usage(
        "search_explain",
        tokens_read=tokens_read,
        metadata={
            "query_present": bool(normalized_query),
            "requested_ids": len(ordered_ids),
            "returned_items": len(items_payload),
            "missing_ids": len(missing_ids),
            "project": filters.get("project"),
            "include_pack_context": include_pack_context,
        },
    )

    return {
        "items": items_payload,
        "missing_ids": missing_ids,
        "errors": errors,
        "metadata": {
            "query": normalized_query or None,
            "project": filters.get("project"),
            "requested_ids_count": len(ordered_ids),
            "returned_items_count": len(items_payload),
            "include_pack_context": include_pack_context,
        },
    }


def _expand_query(query: str) -> str:
    tokens = re.findall(r"[A-Za-z0-9_]+", query)
    tokens = [token for token in tokens if token.lower() not in {"or", "and", "not"}]
    if not tokens:
        return ""
    if len(tokens) == 1:
        return tokens[0]
    return " OR ".join(tokens)


def _dedupe_ordered_ids(ids: Sequence[Any]) -> tuple[list[int], list[str]]:
    deduped: list[int] = []
    seen: set[int] = set()
    invalid: list[str] = []
    for raw_id in ids:
        if isinstance(raw_id, bool):
            invalid.append(str(raw_id))
            continue
        if isinstance(raw_id, float):
            invalid.append(str(raw_id))
            continue
        try:
            memory_id = int(raw_id)
        except (TypeError, ValueError, OverflowError):
            invalid.append(str(raw_id))
            continue
        if not isinstance(raw_id, int) and not (isinstance(raw_id, str) and raw_id.isdigit()):
            invalid.append(str(raw_id))
            continue
        if memory_id < SQLITE_INT64_MIN or memory_id > SQLITE_INT64_MAX:
            invalid.append(str(raw_id))
            continue
        if memory_id <= 0:
            invalid.append(str(raw_id))
            continue
        if memory_id in seen:
            continue
        seen.add(memory_id)
        deduped.append(memory_id)
    return deduped, invalid


def _load_items_by_ids_for_explain(
    store: MemoryStore,
    ids: list[int],
    filters: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[int], list[int], list[int]]:
    if not ids:
        return [], [], [], []
    placeholders = ",".join("?" for _ in ids)
    rows = store.conn.execute(
        f"""
        SELECT memory_items.*
        FROM memory_items
        WHERE memory_items.active = 1
          AND memory_items.id IN ({placeholders})
        """,
        ids,
    ).fetchall()
    all_rows = db.rows_to_dicts(rows)
    all_found_ids = {int(item["id"]) for item in all_rows}

    project_scoped = all_rows
    project_scoped_ids = all_found_ids
    project_clause = ""
    project_params: list[Any] = []
    if filters.get("project"):
        project_clause, project_params = store._project_clause(str(filters["project"]))
        if project_clause:
            project_scoped_rows = store.conn.execute(
                f"""
                SELECT memory_items.*
                FROM memory_items
                JOIN sessions ON sessions.id = memory_items.session_id
                WHERE memory_items.active = 1
                  AND memory_items.id IN ({placeholders})
                  AND {project_clause}
                """,
                [*ids, *project_params],
            ).fetchall()
            project_scoped = db.rows_to_dicts(project_scoped_rows)
            project_scoped_ids = {int(item["id"]) for item in project_scoped}

    scoped_where_clauses = ["memory_items.active = 1", f"memory_items.id IN ({placeholders})"]
    scoped_params: list[Any] = list(ids)
    join_sessions = False
    if filters.get("kind"):
        scoped_where_clauses.append("memory_items.kind = ?")
        scoped_params.append(filters["kind"])
    if filters.get("session_id"):
        scoped_where_clauses.append("memory_items.session_id = ?")
        scoped_params.append(filters["session_id"])
    if filters.get("since"):
        scoped_where_clauses.append("memory_items.created_at >= ?")
        scoped_params.append(filters["since"])
    if filters.get("project") and project_clause:
        scoped_where_clauses.append(project_clause)
        scoped_params.extend(project_params)
        join_sessions = True
    scoped_join = "JOIN sessions ON sessions.id = memory_items.session_id" if join_sessions else ""
    scoped_rows = store.conn.execute(
        f"""
        SELECT memory_items.*
        FROM memory_items
        {scoped_join}
        WHERE {" AND ".join(scoped_where_clauses)}
        """,
        scoped_params,
    ).fetchall()
    scoped = db.rows_to_dicts(scoped_rows)
    scoped_ids = {int(item["id"]) for item in scoped}

    missing_not_found = [memory_id for memory_id in ids if memory_id not in all_found_ids]
    missing_project_mismatch = [
        memory_id
        for memory_id in ids
        if memory_id in all_found_ids and memory_id not in project_scoped_ids
    ]
    missing_filter_mismatch = [
        memory_id
        for memory_id in ids
        if memory_id in project_scoped_ids and memory_id not in scoped_ids
    ]
    return scoped, missing_not_found, missing_project_mismatch, missing_filter_mismatch


def _load_session_projects(store: MemoryStore, session_ids: set[int]) -> dict[int, str | None]:
    if not session_ids:
        return {}
    ordered_ids = sorted(session_ids)
    placeholders = ",".join("?" for _ in ordered_ids)
    rows = store.conn.execute(
        f"SELECT id, project FROM sessions WHERE id IN ({placeholders})",
        ordered_ids,
    ).fetchall()
    return {int(row["id"]): row["project"] for row in rows}


def _project_matches_filter(
    store: MemoryStore,
    project_filter: str | None,
    item_project: str | None,
) -> bool:
    if not project_filter:
        return True
    if not item_project:
        return False
    normalized_filter = project_filter.strip().replace("\\", "/")
    if not normalized_filter:
        return True
    if "/" in normalized_filter:
        filter_value = store._project_basename(normalized_filter)
    else:
        filter_value = normalized_filter
    normalized_project = item_project.replace("\\", "/")
    return normalized_project == filter_value or normalized_project.endswith(f"/{filter_value}")


def _explain_item(
    store: MemoryStore,
    *,
    item: MemoryResult,
    source: str,
    rank: int | None,
    query_tokens: list[str],
    project_filter: str | None,
    project_value: str | None,
    include_pack_context: bool,
    reference_now: dt.datetime,
) -> dict[str, Any]:
    text = f"{item.title} {item.body_text} {item.tags_text}".lower()
    matched_terms = [token for token in query_tokens if token in text]
    base_score: float | None = item.score if source in {"query", "query+id_lookup"} else None
    recency_component = _recency_score(item.created_at, now=reference_now)
    kind_component = _kind_bonus(item.kind)
    total_score: float | None = None
    if base_score is not None:
        total_score = (base_score * 1.5) + recency_component + kind_component

    return {
        "id": item.id,
        "kind": item.kind,
        "title": item.title,
        "created_at": item.created_at,
        "project": project_value,
        "retrieval": {
            "source": source,
            "rank": rank,
        },
        "score": {
            "total": total_score,
            "components": {
                "base": base_score,
                "recency": recency_component,
                "kind_bonus": kind_component,
                "semantic_boost": None,
            },
        },
        "matches": {
            "query_terms": matched_terms,
            "project_match": _project_matches_filter(store, project_filter, project_value),
        },
        "pack_context": (
            {
                "included": None,
                "section": None,
            }
            if include_pack_context
            else None
        ),
    }


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


def _recency_score(created_at: str, *, now: dt.datetime | None = None) -> float:
    parsed = _parse_created_at(created_at)
    if not parsed:
        return 0.0
    reference_now = now or dt.datetime.now(dt.UTC)
    days_ago = (reference_now - parsed).days
    return 1.0 / (1.0 + (days_ago / 7.0))


def _kind_bonus(kind: str | None) -> float:
    if not kind:
        return 0.0
    return MEMORY_KIND_BONUS.get(normalize_memory_kind(kind), 0.0)


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
    reference_now = dt.datetime.now(dt.UTC)

    def score(item: MemoryResult) -> float:
        return (
            (item.score * 1.5)
            + _recency_score(item.created_at, now=reference_now)
            + _kind_bonus(item.kind)
        )

    ordered = sorted(results, key=score, reverse=True)
    return ordered[:limit]


def _rerank_results_hybrid(
    results: list[MemoryResult],
    *,
    limit: int,
    semantic_ids: set[int],
    recency_days: int | None = None,
) -> list[MemoryResult]:
    if recency_days:
        recent_results = _filter_recent_results(results, recency_days)
        if recent_results:
            results = cast(list[MemoryResult], list(recent_results))
    reference_now = dt.datetime.now(dt.UTC)

    def score(item: MemoryResult) -> float:
        semantic_boost = 0.35 if item.id in semantic_ids else 0.0
        return (
            (item.score * 1.2)
            + (_recency_score(item.created_at, now=reference_now) * 0.8)
            + _kind_bonus(item.kind)
            + semantic_boost
        )

    ordered = sorted(results, key=score, reverse=True)
    return ordered[:limit]


def _should_log_shadow(*, sample_rate: float) -> bool:
    if sample_rate <= 0.0:
        return False
    if sample_rate >= 1.0:
        return True
    return random.random() < sample_rate


def _log_shadow_comparison(
    store: MemoryStore,
    *,
    query: str,
    filters: dict[str, Any] | None,
    limit: int,
    active_mode: str,
    baseline: list[MemoryResult],
    hybrid: list[MemoryResult],
) -> None:
    top_k = min(limit, 20)
    baseline_ids = [item.id for item in baseline[:top_k]]
    hybrid_ids = [item.id for item in hybrid[:top_k]]
    overlap = len(set(baseline_ids) & set(hybrid_ids))
    compared_count = min(len(baseline_ids), len(hybrid_ids))
    overlap_ratio = float(overlap) / float(compared_count or 1)
    hybrid_positions = {memory_id: idx for idx, memory_id in enumerate(hybrid_ids)}
    position_shift_sum = 0
    comparable = 0
    for idx, memory_id in enumerate(baseline_ids):
        if memory_id not in hybrid_positions:
            continue
        position_shift_sum += abs(idx - hybrid_positions[memory_id])
        comparable += 1
    store.record_usage(
        "search_hybrid_shadow",
        metadata={
            "query_chars": len(query),
            "limit": int(limit),
            "project": (filters or {}).get("project"),
            "kind": (filters or {}).get("kind"),
            "active_mode": active_mode,
            "sample_rate": store._hybrid_retrieval_shadow_sample_rate,
            "overlap_at_k": overlap,
            "overlap_ratio": overlap_ratio,
            "compared_count": compared_count,
            "top1_changed": bool(baseline_ids and hybrid_ids and baseline_ids[0] != hybrid_ids[0]),
            "position_shift_sum": position_shift_sum,
            "comparable_ids": comparable,
            "k": top_k,
        },
    )


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
    semantic_ids: set[int] = set()
    for item in vector_results:
        memory_id = item.get("id")
        if memory_id is None or isinstance(memory_id, bool):
            continue
        if not isinstance(memory_id, (int, float, str)):
            continue
        try:
            semantic_ids.add(int(memory_id))
        except (TypeError, ValueError):
            continue
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
    baseline = _rerank_results(reranked, limit=limit, recency_days=store.RECALL_RECENCY_DAYS)
    should_shadow = store._hybrid_retrieval_shadow_log and _should_log_shadow(
        sample_rate=store._hybrid_retrieval_shadow_sample_rate
    )
    if not store._hybrid_retrieval_enabled and not should_shadow:
        return baseline
    hybrid = _rerank_results_hybrid(
        reranked,
        limit=limit,
        semantic_ids=semantic_ids,
        recency_days=store.RECALL_RECENCY_DAYS,
    )
    if should_shadow:
        _log_shadow_comparison(
            store,
            query=query,
            filters=filters,
            limit=limit,
            active_mode="hybrid" if store._hybrid_retrieval_enabled else "baseline",
            baseline=baseline,
            hybrid=hybrid,
        )
    if store._hybrid_retrieval_enabled:
        return hybrid
    return baseline


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
    _attach_prompt_links(store, results)
    return results


def _attach_prompt_links(store: MemoryStore, items: list[dict[str, Any]]) -> None:
    for item in items:
        item["linked_prompt"] = None
    prompt_ids = sorted(
        {
            int(prompt_id)
            for item in items
            for prompt_id in [item.get("user_prompt_id")]
            if isinstance(prompt_id, int) and prompt_id > 0
        }
    )
    if not prompt_ids:
        return
    placeholders = ",".join(["?"] * len(prompt_ids))
    rows = store.conn.execute(
        f"""
        SELECT id, prompt_text, prompt_number, created_at
        FROM user_prompts
        WHERE id IN ({placeholders})
        """,
        prompt_ids,
    ).fetchall()
    prompts_by_id = {
        int(row["id"]): {
            "id": int(row["id"]),
            "prompt_text": row["prompt_text"],
            "prompt_number": row["prompt_number"],
            "created_at": row["created_at"],
        }
        for row in rows
    }
    for item in items:
        prompt_id = item.get("user_prompt_id")
        if isinstance(prompt_id, int) and prompt_id in prompts_by_id:
            item["linked_prompt"] = prompts_by_id[prompt_id]


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
        ORDER BY (score * 1.5 + recency) DESC, memory_items.created_at DESC, memory_items.id DESC
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
