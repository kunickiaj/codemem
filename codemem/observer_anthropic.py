from __future__ import annotations

import json
import os
from typing import Any

from . import observer_auth as _observer_auth

ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages"
ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20"
ANTHROPIC_OAUTH_USER_AGENT = "claude-cli/2.1.2 (external, cli)"

_redact_text = _observer_auth._redact_text


def _resolve_anthropic_endpoint() -> str:
    return os.getenv("CODEMEM_ANTHROPIC_ENDPOINT", ANTHROPIC_MESSAGES_ENDPOINT)


def _build_anthropic_headers(access_token: str) -> dict[str, str]:
    return {
        "authorization": f"Bearer {access_token}",
        "anthropic-beta": ANTHROPIC_OAUTH_BETA,
        "anthropic-version": "2023-06-01",
        "user-agent": ANTHROPIC_OAUTH_USER_AGENT,
        "content-type": "application/json",
    }


def _build_anthropic_payload(model: str, prompt: str, max_tokens: int) -> dict[str, Any]:
    return {
        "model": model,
        "max_tokens": max_tokens,
        "stream": True,
        "messages": [
            {
                "role": "user",
                "content": prompt,
            }
        ],
        "system": "You are a memory observer.",
    }


def _parse_anthropic_stream(response: Any) -> str | None:
    """Parse Anthropic Messages API SSE stream, extracting text deltas."""
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
        # Anthropic streaming events:
        # - content_block_delta with delta.type == "text_delta" and delta.text
        event_type = event.get("type")
        if event_type == "content_block_delta":
            delta = event.get("delta", {})
            if isinstance(delta, dict) and delta.get("type") == "text_delta":
                text = delta.get("text")
                if isinstance(text, str) and text:
                    text_parts.append(text)
    if text_parts:
        return "".join(text_parts).strip()
    return None
