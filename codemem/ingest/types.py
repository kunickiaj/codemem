from __future__ import annotations

from dataclasses import dataclass
from typing import Any, TypedDict


class IngestEvent(TypedDict, total=False):
    type: str
    timestamp: str
    tool: str
    args: dict[str, Any]
    result: Any
    error: Any
    cwd: str


class IngestPayload(TypedDict, total=False):
    session_id: str
    project: str
    events: list[IngestEvent]
    user_prompt: str
    assistant_message: str


@dataclass(frozen=True, slots=True)
class ToolEventData:
    tool_name: str
    tool_input: Any
    tool_output: Any
    tool_error: Any
    timestamp: str | None = None
    cwd: str | None = None
