from __future__ import annotations

import json
from dataclasses import asdict

from .observer_prompts import ToolEvent


def _compact_read_output(text: str, *, max_lines: int = 80, max_chars: int = 2000) -> str:
    if not text:
        return ""
    lines = text.splitlines()
    if len(lines) > max_lines:
        lines = lines[:max_lines] + [f"... (+{len(text.splitlines()) - max_lines} more lines)"]
    compacted = "\n".join(lines)
    if max_chars > 0 and len(compacted) > max_chars:
        compacted = f"{compacted[:max_chars]}\n... (truncated)"
    return compacted


def _compact_bash_output(text: str, *, max_lines: int = 80, max_chars: int = 2000) -> str:
    return _compact_read_output(text, max_lines=max_lines, max_chars=max_chars)


def _compact_list_output(text: str, *, max_lines: int = 120, max_chars: int = 2400) -> str:
    return _compact_read_output(text, max_lines=max_lines, max_chars=max_chars)


def _tool_event_signature(event: ToolEvent) -> str:
    if event.tool_name == "bash" and isinstance(event.tool_input, dict):
        cmd = str(event.tool_input.get("command") or "").strip().lower()
        if cmd in {"git status", "git diff"} and not event.tool_error:
            return f"bash:{cmd}"
    parts = [event.tool_name]
    try:
        parts.append(json.dumps(event.tool_input, sort_keys=True, ensure_ascii=False))
    except Exception:
        parts.append(str(event.tool_input))
    if event.tool_error:
        parts.append(str(event.tool_error)[:200])
    if isinstance(event.tool_output, str) and event.tool_output:
        parts.append(event.tool_output[:200])
    return "|".join(parts)


def _tool_event_importance(event: ToolEvent) -> int:
    score = 0
    if event.tool_error:
        score += 100
    tool = (event.tool_name or "").lower()
    if tool in {"edit", "write"}:
        score += 50
    elif tool == "bash":
        score += 30
    elif tool == "read":
        score += 20
    else:
        score += 10
    return score


def _budget_tool_events(
    tool_events: list[ToolEvent],
    *,
    max_total_chars: int,
    max_events: int,
) -> list[ToolEvent]:
    if not tool_events:
        return []
    if max_total_chars <= 0:
        return []
    if max_events <= 0:
        return []

    deduped: list[ToolEvent] = []
    seen: set[str] = set()
    for event in reversed(tool_events):
        signature = _tool_event_signature(event)
        if signature in seen:
            continue
        seen.add(signature)
        deduped.append(event)
    deduped.reverse()

    if len(deduped) > max_events:
        ranked = sorted(
            enumerate(deduped),
            key=lambda pair: (_tool_event_importance(pair[1]), -pair[0]),
            reverse=True,
        )
        keep = {idx for idx, _ in ranked[:max_events]}
        deduped = [event for idx, event in enumerate(deduped) if idx in keep]

    def estimate_size(event: ToolEvent) -> int:
        try:
            return len(json.dumps(asdict(event), ensure_ascii=False))
        except Exception:
            return len(str(event))

    if sum(estimate_size(e) for e in deduped) <= max_total_chars:
        return deduped

    ranked = sorted(
        enumerate(deduped),
        key=lambda pair: (_tool_event_importance(pair[1]), -pair[0]),
        reverse=True,
    )
    kept: list[tuple[int, ToolEvent]] = []
    total = 0
    for idx, event in ranked:
        size = estimate_size(event)
        if total + size > max_total_chars and kept:
            continue
        kept.append((idx, event))
        total += size
        if total >= max_total_chars:
            break

    kept.sort(key=lambda pair: pair[0])
    return [event for _, event in kept]
