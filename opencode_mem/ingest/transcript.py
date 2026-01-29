from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from typing import Any


def build_transcript(
    events: Iterable[dict[str, Any]],
    *,
    strip_private: Callable[[str], str],
) -> str:
    """Build a transcript from user prompts and assistant messages.

    Kept intentionally small and deterministic for use during ingest.
    """

    transcript_parts: list[str] = []
    for event in events:
        event_type = event.get("type")
        if event_type == "user_prompt":
            prompt_text = strip_private(str(event.get("prompt_text") or "")).strip()
            if prompt_text:
                transcript_parts.append(f"User: {prompt_text}")
        elif event_type == "assistant_message":
            assistant_text = strip_private(str(event.get("assistant_text") or "")).strip()
            if assistant_text:
                transcript_parts.append(f"Assistant: {assistant_text}")
    return "\n\n".join(transcript_parts)


def normalize_request_text(text: str | None) -> str:
    if not text:
        return ""
    cleaned = text.strip().strip("\"'").strip()
    cleaned = " ".join(cleaned.split())
    return cleaned.lower()


def is_trivial_request(text: str | None, *, trivial_requests: set[str]) -> bool:
    normalized = normalize_request_text(text)
    if not normalized:
        return True
    return normalized in trivial_requests


def first_sentence(text: str) -> str:
    cleaned = " ".join(line.strip() for line in text.splitlines() if line.strip())
    cleaned = re.sub(r"^[#*\-\d\.\s]+", "", cleaned)
    match = re.split(r"(?<=[.!?])\s+", cleaned, maxsplit=1)
    return (match[0] if match else cleaned).strip()


def derive_request(summary: Any) -> str:
    candidates = [
        getattr(summary, "completed", None),
        getattr(summary, "learned", None),
        getattr(summary, "investigated", None),
        getattr(summary, "next_steps", None),
        getattr(summary, "notes", None),
    ]
    for candidate in candidates:
        if candidate:
            return first_sentence(candidate)
    return ""
