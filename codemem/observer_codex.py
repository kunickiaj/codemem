from __future__ import annotations

import json
import os
from typing import Any

from . import observer_auth as _observer_auth

CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
DEFAULT_CODEX_ENDPOINT = CODEX_API_ENDPOINT

_REDACT_PATTERNS = _observer_auth._REDACT_PATTERNS
_redact_text = _observer_auth._redact_text


def _build_codex_payload(model: str, prompt: str, max_tokens: int) -> dict[str, Any]:
    payload = {
        "model": model,
        "instructions": "You are a memory observer.",
        "input": [
            {
                "role": "user",
                "content": [{"type": "input_text", "text": prompt}],
            }
        ],
        "store": False,
        "stream": True,
    }
    return payload


def _resolve_codex_endpoint() -> str:
    return os.getenv("CODEMEM_CODEX_ENDPOINT", DEFAULT_CODEX_ENDPOINT)


def _parse_codex_stream(response: Any) -> str | None:
    text_parts: list[str] = []
    for line in response.iter_lines():
        if not line:
            continue
        decoded = line.decode("utf-8") if isinstance(line, (bytes, bytearray)) else str(line)
        if not decoded.startswith("data:"):
            continue
        payload = decoded[len("data:") :].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            event = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "response.output_text.delta":
            delta = event.get("delta")
            if isinstance(delta, str) and delta:
                text_parts.append(delta)
    if text_parts:
        return "".join(text_parts).strip()
    return None
