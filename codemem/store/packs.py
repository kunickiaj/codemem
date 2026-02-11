from __future__ import annotations

import re
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from .. import db

if TYPE_CHECKING:
    from ._store import MemoryStore
    from .types import MemoryResult


def _get_metadata(item: MemoryResult | dict[str, Any]) -> dict[str, Any]:
    if not isinstance(item, dict):
        return item.metadata or {}
    metadata = item.get("metadata_json")
    if isinstance(metadata, str):
        return db.from_json(metadata)
    if isinstance(metadata, dict):
        return metadata
    return {}


def _estimate_work_tokens(store: MemoryStore, item: MemoryResult | dict[str, Any]) -> int:
    metadata = _get_metadata(item)
    discovery_tokens = metadata.get("discovery_tokens")
    if discovery_tokens is not None:
        try:
            tokens = int(discovery_tokens)
            if tokens >= 0:
                return tokens
        except (TypeError, ValueError):
            pass
    title = item.title if not isinstance(item, dict) else item.get("title", "")
    body = item.body_text if not isinstance(item, dict) else item.get("body_text", "")
    return max(2000, store.estimate_tokens(f"{title} {body}".strip()))


def _discovery_group(item: MemoryResult | dict[str, Any]) -> str:
    metadata = _get_metadata(item)
    value = metadata.get("discovery_group")
    if isinstance(value, str) and value.strip():
        return value.strip()
    fallback_id = _item_id(item)
    if fallback_id is not None:
        return f"memory:{fallback_id}"
    return "unknown"


def _avoided_work_tokens(item: MemoryResult | dict[str, Any]) -> tuple[int, str]:
    metadata = _get_metadata(item)
    discovery_tokens = metadata.get("discovery_tokens")
    discovery_source = metadata.get("discovery_source")
    if discovery_tokens is not None:
        try:
            tokens = int(discovery_tokens)
            if tokens > 0:
                return tokens, str(discovery_source or "known")
        except (TypeError, ValueError):
            pass
    return 0, "unknown"


def _work_source(item: MemoryResult | dict[str, Any]) -> str:
    metadata = _get_metadata(item)
    if metadata.get("discovery_source") == "usage":
        return "usage"
    return "estimate"


def _item_value(item: MemoryResult | dict[str, Any], key: str, default: Any = "") -> Any:
    if isinstance(item, dict):
        return item.get(key, default)
    return getattr(item, key, default)


def _item_id(item: MemoryResult | dict[str, Any]) -> int | None:
    value = _item_value(item, "id")
    return int(value) if value is not None else None


def _item_kind(item: MemoryResult | dict[str, Any]) -> str:
    return str(_item_value(item, "kind", "") or "")


def _item_created_at(item: MemoryResult | dict[str, Any]) -> str:
    return str(_item_value(item, "created_at", "") or "")


def _item_body(item: MemoryResult | dict[str, Any]) -> str:
    return str(_item_value(item, "body_text", "") or "")


def _item_title(item: MemoryResult | dict[str, Any]) -> str:
    return str(_item_value(item, "title", "") or "")


def _item_confidence(item: MemoryResult | dict[str, Any]) -> float | None:
    value = _item_value(item, "confidence")
    return float(value) if value is not None else None


def _item_tags(item: MemoryResult | dict[str, Any]) -> str:
    return str(_item_value(item, "tags_text", "") or "")


def _sort_recent(
    items: Sequence[MemoryResult | dict[str, Any]],
) -> list[MemoryResult | dict[str, Any]]:
    return sorted(list(items), key=_item_created_at, reverse=True)


def _sort_by_tag_overlap(
    items: Sequence[MemoryResult | dict[str, Any]],
    query: str,
) -> list[MemoryResult | dict[str, Any]]:
    tokens = {t for t in re.findall(r"[a-z0-9_]+", query.lower()) if t}
    if not tokens:
        return list(items)

    def overlap(item: MemoryResult | dict[str, Any]) -> int:
        tags = _item_tags(item)
        tag_tokens = {t for t in tags.split() if t}
        return len(tokens.intersection(tag_tokens))

    return sorted(
        list(items), key=lambda item: (overlap(item), _item_created_at(item)), reverse=True
    )


def _sort_oldest(
    items: Sequence[MemoryResult | dict[str, Any]],
) -> list[MemoryResult | dict[str, Any]]:
    return sorted(list(items), key=_item_created_at)


def _normalize_items(
    items: Sequence[MemoryResult | dict[str, Any]] | None,
) -> list[MemoryResult | dict[str, Any]]:
    if not items:
        return []
    return list(items)


def _add_section(
    sections: list[tuple[str, list[MemoryResult | dict[str, Any]]]],
    selected_ids: set[int],
    title: str,
    items: list[MemoryResult | dict[str, Any]],
    *,
    allow_duplicates: bool = False,
) -> None:
    section_items: list[MemoryResult | dict[str, Any]] = []
    for item in items:
        candidate_id = _item_id(item)
        if candidate_id is None:
            continue
        if not allow_duplicates and candidate_id in selected_ids:
            continue
        selected_ids.add(candidate_id)
        section_items.append(item)
    if section_items:
        sections.append((title, section_items))


def build_memory_pack(
    store: MemoryStore,
    context: str,
    limit: int = 8,
    token_budget: int | None = None,
    filters: dict[str, Any] | None = None,
    log_usage: bool = True,
) -> dict[str, Any]:
    fallback_used = False
    merge_results = True  # Always merge semantic results for better recall
    recall_mode = False

    telemetry_sources = {"semantic": 0, "fts": 0, "fuzzy": 0, "timeline": 0}
    telemetry_candidates = {"semantic": 0, "fts": 0, "fuzzy": 0}

    semantic_matches = []
    try:
        semantic_matches = store._semantic_search(context, limit=limit, filters=filters)
        telemetry_candidates["semantic"] = len(semantic_matches)
    except Exception:
        pass

    if store._query_looks_like_tasks(context):
        matches = store.search(
            store._task_query_hint(), limit=limit, filters=filters, log_usage=False
        )
        telemetry_candidates["fts"] = len(matches)

        matches = list(matches)

        if semantic_matches:
            matches.extend(semantic_matches)

        if not matches:
            fuzzy_matches = store._fuzzy_search(context, limit=limit, filters=filters)
            telemetry_candidates["fuzzy"] = len(fuzzy_matches)
            if fuzzy_matches:
                matches = fuzzy_matches
                fallback_used = True
            else:
                matches = store._task_fallback_recent(limit, filters)
                fallback_used = True
        else:
            pass

        if matches:
            match_dicts = [m.__dict__ if not isinstance(m, dict) else m for m in matches]
            recent_matches = store._filter_recent_results(match_dicts, store.TASK_RECENCY_DAYS)

            if recent_matches:
                matches = store._prioritize_task_results(recent_matches, limit)
            else:
                matches = store._prioritize_task_results(match_dicts, limit)

    elif store._query_looks_like_recall(context):
        recall_mode = True
        recall_filters = dict(filters or {})
        recall_filters["kind"] = "session_summary"
        matches = store.search(
            context or store._recall_query_hint(),
            limit=limit,
            filters=recall_filters,
            log_usage=False,
        )
        telemetry_candidates["fts"] = len(matches)
        matches = list(matches)

        if semantic_matches:
            matches.extend(semantic_matches)

        if not matches:
            fuzzy_matches = store._fuzzy_search(context, limit=limit, filters=filters)
            telemetry_candidates["fuzzy"] = len(fuzzy_matches)
            if fuzzy_matches:
                matches = fuzzy_matches
                fallback_used = True
            else:
                matches = store._recall_fallback_recent(limit, filters)
                fallback_used = True

        if matches:
            match_dicts = [m.__dict__ if not isinstance(m, dict) else m for m in matches]
            matches = store._prioritize_recall_results(match_dicts, limit)

        if matches:
            depth_before = max(0, limit // 2)
            depth_after = max(0, limit - depth_before - 1)
            timeline = store._timeline_around(matches[0], depth_before, depth_after, filters)
            if timeline:
                matches = timeline
                telemetry_sources["timeline"] = len(timeline)

    else:
        matches = store.search(context, limit=limit, filters=filters, log_usage=False)
        telemetry_candidates["fts"] = len(matches)
        matches = list(matches)

        if not matches and not semantic_matches:
            fuzzy_matches = store._fuzzy_search(context, limit=limit, filters=filters)
            telemetry_candidates["fuzzy"] = len(fuzzy_matches)
            if fuzzy_matches:
                matches = fuzzy_matches
                fallback_used = True
        elif matches:
            matches = store._rerank_results(
                list(matches), limit=limit, recency_days=store.RECALL_RECENCY_DAYS
            )

    semantic_candidates = len(semantic_matches)

    if merge_results:
        matches = store._merge_ranked_results(matches, context, limit, filters)

    summary_candidates = [m for m in matches if _item_kind(m) == "session_summary"]
    summary_item: MemoryResult | dict[str, Any] | None = None
    if summary_candidates:
        summary_item = _sort_recent(summary_candidates)[0]
    else:
        summary_filters = dict(filters or {})
        summary_filters["kind"] = "session_summary"
        recent_summary = _normalize_items(store.recent(limit=1, filters=summary_filters))
        if recent_summary:
            summary_item = recent_summary[0]

    timeline_candidates = [m for m in matches if _item_kind(m) != "session_summary"]
    if not timeline_candidates:
        timeline_candidates = [
            m
            for m in _normalize_items(store.recent(limit=limit, filters=filters))
            if _item_kind(m) != "session_summary"
        ]
    if not merge_results:
        timeline_candidates = _sort_recent(timeline_candidates)

    observation_kinds = [
        "decision",
        "feature",
        "bugfix",
        "refactor",
        "change",
        "discovery",
        "exploration",
        "note",
    ]
    observation_rank = {kind: index for index, kind in enumerate(observation_kinds)}
    observation_candidates = [m for m in matches if _item_kind(m) in observation_kinds]
    if not observation_candidates:
        observation_candidates = _normalize_items(
            store.recent_by_kinds(
                observation_kinds,
                limit=max(limit * 3, 10),
                filters=filters,
            )
        )
    if not observation_candidates:
        observation_candidates = list(timeline_candidates)
    observation_candidates = _sort_recent(observation_candidates)
    observation_candidates = sorted(
        observation_candidates,
        key=lambda item: observation_rank.get(_item_kind(item), len(observation_kinds)),
    )

    observation_candidates = _sort_by_tag_overlap(observation_candidates, context)

    remaining = max(0, limit)
    summary_items: list[MemoryResult | dict[str, Any]] = []
    if summary_item is not None:
        summary_items = [summary_item]
        remaining = max(0, remaining - 1)
    timeline_limit = min(3, remaining)
    remaining = max(0, remaining - timeline_limit)
    observation_limit = remaining

    if merge_results:
        timeline_items = list(timeline_candidates)
    else:
        timeline_items = timeline_candidates[:timeline_limit]
    observation_items = observation_candidates[:observation_limit]

    if not merge_results and observation_items:
        seen = set()
        deduped: list[MemoryResult | dict[str, Any]] = []
        for item in observation_items:
            title = _item_title(item)
            key = title.strip().lower()[:48]
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            deduped.append(item)
        observation_items = deduped[:observation_limit]

    selected_ids: set[int] = set()
    sections: list[tuple[str, list[MemoryResult | dict[str, Any]]]] = []

    _add_section(sections, selected_ids, "Summary", summary_items)
    _add_section(sections, selected_ids, "Timeline", timeline_items)
    if not summary_items:
        sections.append(("Summary", []))
    if not timeline_items:
        sections.append(("Timeline", []))
    if observation_items:
        _add_section(
            sections, selected_ids, "Observations", observation_items, allow_duplicates=True
        )
    elif timeline_items:
        _add_section(sections, selected_ids, "Observations", timeline_items, allow_duplicates=True)
    else:
        sections.append(("Observations", []))

    required_titles = {"Summary", "Timeline", "Observations"}
    if token_budget:
        running = 0
        trimmed_sections: list[tuple[str, list[MemoryResult | dict[str, Any]]]] = []
        budget_exhausted = False
        for title, items in sections:
            if not items and title in required_titles:
                trimmed_sections.append((title, []))
                continue
            section_items: list[MemoryResult | dict[str, Any]] = []
            for item in items:
                est = store.estimate_tokens(_item_body(item))
                if running + est > token_budget and trimmed_sections:
                    budget_exhausted = True
                    break
                running += est
                section_items.append(item)
            if section_items:
                trimmed_sections.append((title, section_items))
            if budget_exhausted:
                break
        sections = trimmed_sections

    final_items: list[MemoryResult | dict[str, Any]] = []
    if merge_results:
        final_items = list(timeline_items)
    else:
        for title, items in sections:
            if title == "Observations":
                continue
            final_items.extend(items)

    if recall_mode:
        recall_items: list[MemoryResult | dict[str, Any]] = []
        seen_ids: set[int] = set()
        for item in timeline_items:
            candidate_id = _item_id(item)
            if candidate_id is None or candidate_id in seen_ids:
                continue
            seen_ids.add(candidate_id)
            recall_items.append(item)
        if summary_item is not None:
            summary_id = _item_id(summary_item)
            if summary_id is not None and summary_id not in seen_ids:
                recall_items.append(summary_item)
        final_items = _sort_oldest(recall_items)

    formatted = [
        {
            "id": _item_id(m),
            "kind": _item_kind(m),
            "title": _item_title(m),
            "body": _item_body(m),
            "confidence": _item_confidence(m),
            "tags": _item_tags(m),
        }
        for m in final_items
    ]

    section_blocks = []
    for title, items in sections:
        lines = [
            f"[{_item_id(m)}] ({_item_kind(m)}) {_item_title(m)} - {_item_body(m)}" for m in items
        ]
        if lines:
            section_blocks.append(f"## {title}\n" + "\n".join(lines))
        else:
            section_blocks.append(f"## {title}\n")
    pack_text = "\n\n".join(section_blocks)
    pack_tokens = store.estimate_tokens(pack_text)
    work_tokens_sum = sum(_estimate_work_tokens(store, m) for m in final_items)
    group_work: dict[str, int] = {}
    for item in final_items:
        key = _discovery_group(item)
        group_work[key] = max(group_work.get(key, 0), _estimate_work_tokens(store, item))
    work_tokens_unique = sum(group_work.values())
    avoided_tokens_total = 0
    avoided_known = 0
    avoided_unknown = 0
    avoided_sources: dict[str, int] = {}
    for item in final_items:
        tokens, source = _avoided_work_tokens(item)
        if tokens > 0:
            avoided_tokens_total += tokens
            avoided_known += 1
            avoided_sources[source] = avoided_sources.get(source, 0) + 1
        else:
            avoided_unknown += 1
    tokens_saved = max(0, work_tokens_unique - pack_tokens)
    avoided_work_saved = max(0, avoided_tokens_total - pack_tokens)
    work_sources = [_work_source(m) for m in final_items]
    usage_items = sum(1 for source in work_sources if source == "usage")
    estimate_items = sum(1 for source in work_sources if source != "usage")
    if usage_items and estimate_items:
        work_source_label = "mixed"
    elif usage_items:
        work_source_label = "usage"
    else:
        work_source_label = "estimate"
    semantic_hits = 0
    if merge_results:
        semantic_ids = {item.get("id") for item in store._semantic_search(context, limit, filters)}
        for item in formatted:
            if item.get("id") in semantic_ids:
                semantic_hits += 1

    compression_ratio = None
    overhead_tokens = None
    if work_tokens_unique > 0:
        compression_ratio = float(pack_tokens) / float(work_tokens_unique)
        overhead_tokens = int(pack_tokens) - int(work_tokens_unique)

    avoided_work_ratio = None
    if avoided_tokens_total > 0:
        avoided_work_ratio = float(avoided_tokens_total) / float(pack_tokens or 1)

    metrics = {
        "limit": limit,
        "items": len(formatted),
        "token_budget": token_budget,
        "project": (filters or {}).get("project"),
        "fallback": "recent" if fallback_used else None,
        "work_tokens_unique": work_tokens_unique,
        "work_tokens": work_tokens_sum,
        "pack_tokens": pack_tokens,
        "tokens_saved": tokens_saved,
        "compression_ratio": compression_ratio,
        "overhead_tokens": overhead_tokens,
        "avoided_work_tokens": avoided_tokens_total,
        "avoided_work_saved": avoided_work_saved,
        "avoided_work_ratio": avoided_work_ratio,
        "avoided_work_known_items": avoided_known,
        "avoided_work_unknown_items": avoided_unknown,
        "avoided_work_sources": avoided_sources,
        "work_source": work_source_label,
        "work_usage_items": usage_items,
        "work_estimate_items": estimate_items,
        "savings_reliable": avoided_known >= avoided_unknown
        if (avoided_known + avoided_unknown) > 0
        else True,
        "semantic_candidates": semantic_candidates,
        "semantic_hits": semantic_hits,
    }
    if log_usage:
        store.record_usage(
            "pack",
            tokens_read=pack_tokens,
            tokens_saved=tokens_saved,
            metadata=metrics,
        )
    return {
        "context": context,
        "items": formatted,
        "pack_text": pack_text,
        "metrics": metrics,
    }
