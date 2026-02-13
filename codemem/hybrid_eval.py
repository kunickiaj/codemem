from __future__ import annotations

import json
import statistics
from collections.abc import Sequence
from typing import Any, TypedDict

from .store import MemoryStore


class JudgedQuery(TypedDict):
    query: str
    relevant_ids: list[int]
    filters: dict[str, Any] | None


def read_judged_queries(text: str) -> list[JudgedQuery]:
    rows: list[JudgedQuery] = []
    seen: set[tuple[str, tuple[int, ...], str]] = set()
    for line in (text or "").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        payload = json.loads(stripped)
        query = str(payload.get("query") or "").strip()
        if not query:
            raise ValueError("each judged query must include non-empty 'query'")
        relevant_ids_raw = payload.get("relevant_ids")
        if relevant_ids_raw is None:
            relevant_ids_raw = []
        if not isinstance(relevant_ids_raw, list):
            raise ValueError("'relevant_ids' must be an array when provided")
        relevant_ids = [int(item) for item in relevant_ids_raw]
        filters = payload.get("filters")
        if filters is not None and not isinstance(filters, dict):
            raise ValueError("'filters' must be an object when provided")
        normalized_relevant_ids = tuple(sorted(set(relevant_ids)))
        key = (
            query,
            normalized_relevant_ids,
            json.dumps(filters or {}, sort_keys=True, separators=(",", ":")),
        )
        if key in seen:
            raise ValueError("duplicate judged query row detected")
        seen.add(key)
        rows.append(
            {
                "query": query,
                "relevant_ids": relevant_ids,
                "filters": filters,
            }
        )
    if not rows:
        raise ValueError("no judged queries found; provide at least one JSONL row")
    return rows


def _precision_recall(
    result_ids: Sequence[int], relevant_ids: set[int], *, k: int
) -> tuple[float, float, int]:
    if k <= 0:
        return 0.0, 0.0, 0
    top_ids = list(result_ids)[:k]
    unique_top_ids = set(top_ids)
    hits = len(unique_top_ids & relevant_ids)
    precision = float(hits) / float(k)
    recall = float(hits) / float(len(relevant_ids)) if relevant_ids else 0.0
    return precision, recall, hits


def run_hybrid_eval(
    store: MemoryStore,
    *,
    judged_queries: list[JudgedQuery],
    limit: int,
) -> dict[str, Any]:
    if limit <= 0:
        raise ValueError("limit must be greater than 0")
    previous_hybrid_enabled = bool(store._hybrid_retrieval_enabled)
    previous_shadow_log = bool(store._hybrid_retrieval_shadow_log)
    per_query: list[dict[str, Any]] = []
    baseline_precision: list[float] = []
    baseline_recall: list[float] = []
    hybrid_precision: list[float] = []
    hybrid_recall: list[float] = []

    try:
        store._hybrid_retrieval_shadow_log = False
        for row in judged_queries:
            query = row["query"]
            filters = row.get("filters")
            relevant = set(int(item) for item in row["relevant_ids"])

            store._hybrid_retrieval_enabled = False
            baseline_pack = store.build_memory_pack(
                context=query,
                limit=limit,
                token_budget=None,
                filters=filters,
                log_usage=False,
            )
            baseline_ids = [
                int(item["id"])
                for item in baseline_pack.get("items") or []
                if isinstance(item, dict) and item.get("id") is not None
            ]
            b_precision, b_recall, b_hits = _precision_recall(baseline_ids, relevant, k=limit)

            store._hybrid_retrieval_enabled = True
            hybrid_pack = store.build_memory_pack(
                context=query,
                limit=limit,
                token_budget=None,
                filters=filters,
                log_usage=False,
            )
            hybrid_ids = [
                int(item["id"])
                for item in hybrid_pack.get("items") or []
                if isinstance(item, dict) and item.get("id") is not None
            ]
            h_precision, h_recall, h_hits = _precision_recall(hybrid_ids, relevant, k=limit)

            baseline_precision.append(b_precision)
            baseline_recall.append(b_recall)
            hybrid_precision.append(h_precision)
            hybrid_recall.append(h_recall)
            per_query.append(
                {
                    "query": query,
                    "relevant_count": len(relevant),
                    "baseline": {
                        "precision": b_precision,
                        "recall": b_recall,
                        "hits": b_hits,
                        "ids": baseline_ids,
                    },
                    "hybrid": {
                        "precision": h_precision,
                        "recall": h_recall,
                        "hits": h_hits,
                        "ids": hybrid_ids,
                    },
                    "delta": {
                        "precision": h_precision - b_precision,
                        "recall": h_recall - b_recall,
                    },
                }
            )
    finally:
        store._hybrid_retrieval_enabled = previous_hybrid_enabled
        store._hybrid_retrieval_shadow_log = previous_shadow_log

    def _avg(values: list[float]) -> float:
        return float(statistics.mean(values)) if values else 0.0

    summary = {
        "queries": len(per_query),
        "limit": int(limit),
        "baseline": {
            "precision": _avg(baseline_precision),
            "recall": _avg(baseline_recall),
        },
        "hybrid": {
            "precision": _avg(hybrid_precision),
            "recall": _avg(hybrid_recall),
        },
    }
    summary["delta"] = {
        "precision": summary["hybrid"]["precision"] - summary["baseline"]["precision"],
        "recall": summary["hybrid"]["recall"] - summary["baseline"]["recall"],
    }
    return {
        "summary": summary,
        "results": per_query,
    }


def format_hybrid_eval_report(payload: dict[str, Any]) -> str:
    summary = payload.get("summary") or {}
    baseline = summary.get("baseline") or {}
    hybrid = summary.get("hybrid") or {}
    delta = summary.get("delta") or {}
    lines = [
        f"queries: {summary.get('queries', 0)} limit={summary.get('limit', 0)}",
        f"baseline: precision@k={baseline.get('precision', 0.0):.3f} recall@k={baseline.get('recall', 0.0):.3f}",
        f"hybrid: precision@k={hybrid.get('precision', 0.0):.3f} recall@k={hybrid.get('recall', 0.0):.3f}",
        f"delta: precision={delta.get('precision', 0.0):+.3f} recall={delta.get('recall', 0.0):+.3f}",
    ]
    return "\n".join(lines)


def to_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False)
