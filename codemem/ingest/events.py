from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from ..ingest_sanitize import _sanitize_payload, _sanitize_tool_output
from ..ingest_tool_events import (
    _budget_tool_events,
    _compact_bash_output,
    _compact_list_output,
    _compact_read_output,
)
from ..observer_prompts import ToolEvent

LOW_SIGNAL_TOOLS = {
    "tui",
    "shell",
    "cmd",
    "task",
    "slashcommand",
    "skill",
    "todowrite",
    "askuserquestion",
}


def is_internal_memory_tool(tool: str) -> bool:
    """Return True for codemem memory retrieval tools.

    These tools surface previously stored memory. Treating their outputs as
    new evidence can create feedback loops and noisy, self-referential memories.
    """

    return tool.startswith("codemem_memory_")


def normalize_tool_name(event: dict[str, Any]) -> str:
    tool = str(event.get("tool") or event.get("type") or "tool").lower()
    if "." in tool:
        tool = tool.split(".")[-1]
    if ":" in tool:
        tool = tool.split(":")[-1]
    return tool


def event_to_tool_event(
    event: dict[str, Any],
    *,
    max_chars: int,
    low_signal_tools: set[str] = LOW_SIGNAL_TOOLS,
) -> ToolEvent | None:
    if event.get("type") != "tool.execute.after":
        return None
    tool = normalize_tool_name(event)
    if is_internal_memory_tool(tool):
        return None
    if tool in low_signal_tools:
        return None
    raw_args = event.get("args")
    args = raw_args if isinstance(raw_args, dict) else {}
    result = _sanitize_tool_output(tool, event.get("result"), max_chars)
    if tool == "read" and isinstance(result, str):
        result = _compact_read_output(result)
    if tool == "bash" and isinstance(result, str):
        result = _compact_bash_output(result)
    if tool in {"glob", "grep"} and isinstance(result, str):
        result = _compact_list_output(result)
    error = _sanitize_payload(event.get("error"), max_chars)
    return ToolEvent(
        tool_name=tool,
        tool_input=_sanitize_payload(args, max_chars),
        tool_output=result,
        tool_error=error,
        timestamp=event.get("timestamp"),
        cwd=event.get("cwd") or args.get("cwd"),
    )


def extract_tool_events(events: Iterable[dict[str, Any]], max_chars: int) -> list[ToolEvent]:
    tool_events: list[ToolEvent] = []
    for event in events:
        tool_event = event_to_tool_event(event, max_chars=max_chars)
        if tool_event:
            tool_events.append(tool_event)
    return tool_events


def budget_tool_events(
    tool_events: list[ToolEvent],
    *,
    max_total_chars: int,
    max_events: int,
) -> list[ToolEvent]:
    return _budget_tool_events(tool_events, max_total_chars=max_total_chars, max_events=max_events)
