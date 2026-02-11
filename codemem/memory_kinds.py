from __future__ import annotations

from typing import Final

ALLOWED_MEMORY_KINDS: Final[tuple[str, ...]] = (
    "session_summary",
    "observation",
    "entities",
    "note",
    "decision",
    "discovery",
    "change",
    "feature",
    "bugfix",
    "refactor",
    "exploration",
)


def normalize_memory_kind(kind: str) -> str:
    return (kind or "").strip().lower()


def validate_memory_kind(kind: str) -> str:
    normalized = normalize_memory_kind(kind)
    if normalized in ALLOWED_MEMORY_KINDS:
        return normalized

    if normalized == "project":
        suggestion = "decision"
        raise ValueError(
            f"Invalid memory kind '{normalized}'. 'project' is not supported; use '{suggestion}' instead. "
            f"Allowed kinds: {', '.join(ALLOWED_MEMORY_KINDS)}"
        )

    raise ValueError(
        f"Invalid memory kind '{normalized}'. Allowed kinds: {', '.join(ALLOWED_MEMORY_KINDS)}"
    )
