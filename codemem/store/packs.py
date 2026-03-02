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


def _normalize_dedupe_text(value: str) -> str:
    return " ".join(value.lower().split())


def _exact_dedupe_key(item: MemoryResult | dict[str, Any]) -> tuple[str, str, str] | None:
    kind = _item_kind(item)
    if kind == "session_summary":
        return None
    title = _normalize_dedupe_text(_item_title(item))
    body = _normalize_dedupe_text(_item_body(item))
    if not title and not body:
        return None
    return (kind, title, body)


def _collapse_exact_duplicates(
    items: Sequence[MemoryResult | dict[str, Any]],
    *,
    canonical_by_key: dict[tuple[str, str, str], int],
    duplicate_ids: dict[int, set[int]],
) -> list[MemoryResult | dict[str, Any]]:
    collapsed: list[MemoryResult | dict[str, Any]] = []
    for item in items:
        candidate_id = _item_id(item)
        if candidate_id is None:
            continue
        key = _exact_dedupe_key(item)
        if key is None:
            collapsed.append(item)
            continue
        canonical_id = canonical_by_key.get(key)
        if canonical_id is None:
            canonical_by_key[key] = candidate_id
            collapsed.append(item)
            continue
        if canonical_id == candidate_id:
            collapsed.append(item)
            continue
        duplicate_ids.setdefault(canonical_id, set()).add(candidate_id)
    return collapsed


def _unique_item_ids(
    items: Sequence[MemoryResult | dict[str, Any]],
) -> set[int]:
    unique: set[int] = set()
    for item in items:
        item_id = _item_id(item)
        if item_id is None:
            continue
        unique.add(item_id)
    return unique


def _count_collapsed_for_canonical_ids(
    duplicate_ids: dict[int, set[int]],
    canonical_ids: set[int],
) -> int:
    total = 0
    for canonical_id in canonical_ids:
        total += len(duplicate_ids.get(canonical_id, set()))
    return total


def _dedupe_int_ids(values: Sequence[int | None]) -> list[int]:
    deduped: list[int] = []
    seen: set[int] = set()
    for raw in values:
        if raw is None:
            continue
        item_id = int(raw)
        if item_id <= 0 or item_id in seen:
            continue
        seen.add(item_id)
        deduped.append(item_id)
    return deduped


def _coerce_pack_item_ids(value: Any) -> tuple[list[int], bool]:
    if not isinstance(value, list):
        return [], False
    parsed: list[int | None] = []
    for raw in value:
        if raw is None:
            return [], False
        if isinstance(raw, bool):
            return [], False
        try:
            parsed.append(int(raw))
        except (TypeError, ValueError):
            return [], False
    return _dedupe_int_ids(parsed), True


def _coerce_non_negative_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    if parsed < 0:
        return None
    return parsed


def _pack_delta_baseline(
    store: MemoryStore,
    *,
    project: str | None,
) -> tuple[list[int] | None, int | None]:
    rows = store.recent_pack_events(limit=1, project=project)
    if not rows:
        return None, None
    metadata = rows[0].get("metadata_json")
    if not isinstance(metadata, dict):
        return None, None
    if "pack_item_ids" not in metadata:
        return None, None
    previous_ids, ids_valid = _coerce_pack_item_ids(metadata.get("pack_item_ids"))
    if not ids_valid:
        return None, None
    previous_pack_tokens_raw = metadata.get("pack_tokens", rows[0].get("tokens_read"))
    previous_pack_tokens = _coerce_non_negative_int(previous_pack_tokens_raw)
    if previous_pack_tokens is None:
        return None, None
    return previous_ids, previous_pack_tokens


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

    matches: list[Any] = []
    semantic_matches: list[dict[str, Any]] = []
    try:
        semantic_matches = store._semantic_search(context, limit=limit, filters=filters)
        telemetry_candidates["semantic"] = len(semantic_matches)
    except Exception:
        pass

    if store._query_looks_like_tasks(context):
        task_matches = list(
            store.search(store._task_query_hint(), limit=limit, filters=filters, log_usage=False)
        )
        telemetry_candidates["fts"] = len(task_matches)
        match_dicts = [m.__dict__ for m in task_matches]

        if semantic_matches:
            match_dicts.extend(semantic_matches)

        if not match_dicts:
            fuzzy_matches = store._fuzzy_search(context, limit=limit, filters=filters)
            telemetry_candidates["fuzzy"] = len(fuzzy_matches)
            if fuzzy_matches:
                match_dicts = fuzzy_matches
                fallback_used = True
            else:
                match_dicts = store._task_fallback_recent(limit, filters)
                fallback_used = True
        if match_dicts:
            recent_matches = [
                item
                for item in store._filter_recent_results(match_dicts, store.TASK_RECENCY_DAYS)
                if isinstance(item, dict)
            ]

            if recent_matches:
                matches = store._prioritize_task_results(recent_matches, limit)
            else:
                matches = store._prioritize_task_results(match_dicts, limit)

    elif store._query_looks_like_recall(context):
        recall_mode = True
        recall_filters = dict(filters or {})
        recall_filters["kind"] = "session_summary"
        recall_raw = store.search(
            context or store._recall_query_hint(),
            limit=limit,
            filters=recall_filters,
            log_usage=False,
        )
        telemetry_candidates["fts"] = len(recall_raw)
        recall_dicts = [m.__dict__ for m in recall_raw]

        if semantic_matches:
            recall_dicts.extend(semantic_matches)

        if not recall_dicts:
            fuzzy_matches = store._fuzzy_search(context, limit=limit, filters=filters)
            telemetry_candidates["fuzzy"] = len(fuzzy_matches)
            if fuzzy_matches:
                recall_dicts = fuzzy_matches
                fallback_used = True
            else:
                recall_dicts = store._recall_fallback_recent(limit, filters)
                fallback_used = True

        if recall_dicts:
            recall_items: list[MemoryResult | dict[str, Any]] = [item for item in recall_dicts]
            matches = store._prioritize_recall_results(recall_items, limit)

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

    exact_dedupe_enabled = bool(getattr(store, "_pack_exact_dedupe_enabled", True))
    duplicate_ids: dict[int, set[int]] = {}
    if exact_dedupe_enabled:
        canonical_by_key: dict[tuple[str, str, str], int] = {}
        summary_items = _collapse_exact_duplicates(
            summary_items,
            canonical_by_key=canonical_by_key,
            duplicate_ids=duplicate_ids,
        )
        timeline_items = _collapse_exact_duplicates(
            timeline_items,
            canonical_by_key=canonical_by_key,
            duplicate_ids=duplicate_ids,
        )
        observation_items = _collapse_exact_duplicates(
            observation_items,
            canonical_by_key=canonical_by_key,
            duplicate_ids=duplicate_ids,
        )

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
            "support_count": 1 + len(duplicate_ids.get(_item_id(m) or -1, set())),
            "duplicate_ids": sorted(duplicate_ids.get(_item_id(m) or -1, set())),
        }
        for m in final_items
    ]

    section_blocks = []
    section_unique_ids: set[int] = set()
    for title, items in sections:
        section_unique_ids.update(_unique_item_ids(items))
        lines = [
            f"[{_item_id(m)}] ({_item_kind(m)}) {_item_title(m)} - {_item_body(m)}" for m in items
        ]
        if lines:
            section_blocks.append(f"## {title}\n" + "\n".join(lines))
        else:
            section_blocks.append(f"## {title}\n")
    pack_text = "\n\n".join(section_blocks)
    pack_tokens = store.estimate_tokens(pack_text)
    current_pack_ids = _dedupe_int_ids([_item_id(item) for item in final_items])
    previous_pack_ids, previous_pack_tokens = _pack_delta_baseline(
        store,
        project=(filters or {}).get("project"),
    )
    added_ids: list[int] = []
    removed_ids: list[int] = []
    retained_ids: list[int] = []
    pack_token_delta = 0
    pack_delta_available = bool(previous_pack_ids is not None and previous_pack_tokens is not None)
    if pack_delta_available:
        previous_set = set(previous_pack_ids or [])
        current_set = set(current_pack_ids)
        added_ids = [item_id for item_id in current_pack_ids if item_id not in previous_set]
        removed_ids = [
            item_id for item_id in (previous_pack_ids or []) if item_id not in current_set
        ]
        retained_ids = [item_id for item_id in current_pack_ids if item_id in previous_set]
        pack_token_delta = int(pack_tokens) - int(previous_pack_tokens or 0)

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

    returned_unique_ids = _unique_item_ids(final_items)
    returned_duplicates_collapsed = _count_collapsed_for_canonical_ids(
        duplicate_ids, returned_unique_ids
    )
    returned_candidates_total = len(returned_unique_ids) + returned_duplicates_collapsed
    returned_reduction_percent = 0.0
    if returned_candidates_total > 0:
        returned_reduction_percent = (
            float(returned_duplicates_collapsed) / float(returned_candidates_total)
        ) * 100.0

    pack_duplicates_collapsed = _count_collapsed_for_canonical_ids(
        duplicate_ids, section_unique_ids
    )
    pack_candidates_total = len(section_unique_ids) + pack_duplicates_collapsed
    pack_reduction_percent = 0.0
    if pack_candidates_total > 0:
        pack_reduction_percent = (
            float(pack_duplicates_collapsed) / float(pack_candidates_total)
        ) * 100.0

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
        "pack_item_ids": current_pack_ids,
        "added_ids": added_ids,
        "removed_ids": removed_ids,
        "retained_ids": retained_ids,
        "pack_token_delta": pack_token_delta,
        "pack_delta_available": pack_delta_available,
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
        "exact_dedupe_enabled": exact_dedupe_enabled,
        "exact_duplicates_collapsed": returned_duplicates_collapsed,
        "exact_candidates_total": returned_candidates_total,
        "exact_dedupe_reduction_percent": returned_reduction_percent,
        "exact_unique_items": len(returned_unique_ids),
        "exact_pack_duplicates_collapsed": pack_duplicates_collapsed,
        "exact_pack_candidates_total": pack_candidates_total,
        "exact_pack_dedupe_reduction_percent": pack_reduction_percent,
        "exact_returned_duplicates_collapsed": returned_duplicates_collapsed,
        "exact_returned_unique_items": len(returned_unique_ids),
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
