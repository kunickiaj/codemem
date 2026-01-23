from __future__ import annotations

import json
import statistics
from dataclasses import dataclass

from .store import MemoryStore


@dataclass(frozen=True)
class PackBenchmarkResult:
    query: str
    metrics: dict


def read_queries(text: str) -> list[str]:
    queries: list[str] = []
    for line in (text or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            continue
        queries.append(stripped)
    return queries


def run_pack_benchmark(
    store: MemoryStore,
    *,
    queries: list[str],
    limit: int,
    token_budget: int | None,
    filters: dict | None,
) -> dict:
    results: list[PackBenchmarkResult] = []
    for query in queries:
        pack = store.build_memory_pack(
            context=query,
            limit=limit,
            token_budget=token_budget,
            filters=filters,
            log_usage=False,
        )
        metrics = dict(pack.get("metrics") or {})
        metrics["query"] = query
        results.append(PackBenchmarkResult(query=query, metrics=metrics))

    pack_tokens = [int(r.metrics.get("pack_tokens") or 0) for r in results]
    tokens_saved = [int(r.metrics.get("tokens_saved") or 0) for r in results]
    avoided_saved = [int(r.metrics.get("avoided_work_saved") or 0) for r in results]
    ratios: list[float] = []
    for r in results:
        ratio = r.metrics.get("compression_ratio")
        if isinstance(ratio, (int, float)):
            ratios.append(float(ratio))

    def pct(values: list[int], p: float) -> int:
        if not values:
            return 0
        values_sorted = sorted(values)
        idx = int(round((p / 100.0) * (len(values_sorted) - 1)))
        return int(values_sorted[idx])

    summary = {
        "queries": len(results),
        "pack_tokens": {
            "median": int(statistics.median(pack_tokens)) if pack_tokens else 0,
            "p90": pct(pack_tokens, 90),
            "max": max(pack_tokens) if pack_tokens else 0,
        },
        "tokens_saved": {
            "median": int(statistics.median(tokens_saved)) if tokens_saved else 0,
            "p90": pct(tokens_saved, 90),
            "max": max(tokens_saved) if tokens_saved else 0,
        },
        "avoided_work_saved": {
            "median": int(statistics.median(avoided_saved)) if avoided_saved else 0,
            "p90": pct(avoided_saved, 90),
            "max": max(avoided_saved) if avoided_saved else 0,
        },
        "compression_ratio": {
            "median": float(statistics.median(ratios)) if ratios else None,
            "p90": float(sorted(ratios)[int(round(0.9 * (len(ratios) - 1)))]) if ratios else None,
            "max": max(ratios) if ratios else None,
        },
    }
    return {
        "summary": summary,
        "results": [r.metrics for r in results],
    }


def format_benchmark_report(payload: dict) -> str:
    summary = payload.get("summary") or {}
    pt = summary.get("pack_tokens") or {}
    ts = summary.get("tokens_saved") or {}
    aws = summary.get("avoided_work_saved") or {}
    cr = summary.get("compression_ratio") or {}
    lines = [
        f"queries: {summary.get('queries', 0)}",
        f"pack_tokens: median={pt.get('median', 0)} p90={pt.get('p90', 0)} max={pt.get('max', 0)}",
        f"tokens_saved: median={ts.get('median', 0)} p90={ts.get('p90', 0)} max={ts.get('max', 0)}",
        f"avoided_work_saved: median={aws.get('median', 0)} p90={aws.get('p90', 0)} max={aws.get('max', 0)}",
        f"compression_ratio: median={cr.get('median')} p90={cr.get('p90')} max={cr.get('max')}",
    ]
    return "\n".join(lines)


def to_json(payload: dict) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False)
