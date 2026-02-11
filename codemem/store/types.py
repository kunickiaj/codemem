from __future__ import annotations

from dataclasses import dataclass
from typing import Any, TypedDict


@dataclass
class MemoryResult:
    id: int
    kind: str
    title: str
    body_text: str
    confidence: float
    created_at: str
    updated_at: str
    tags_text: str
    score: float
    session_id: int
    metadata: dict[str, Any]


class ReplicationClock(TypedDict):
    rev: int
    updated_at: str
    device_id: str


class ReplicationOp(TypedDict):
    op_id: str
    entity_type: str
    entity_id: str
    op_type: str
    payload: dict[str, Any] | None
    clock: ReplicationClock
    device_id: str
    created_at: str
