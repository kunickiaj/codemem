from __future__ import annotations

import json
import os
from typing import Any

from . import observer_auth as _observer_auth

ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages"
ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20"
ANTHROPIC_OAUTH_USER_AGENT = "claude-cli/2.1.2 (external, cli)"

_ANTHROPIC_MODEL_ALIASES = {
    "claude-4.5-haiku": "claude-haiku-4-5",
    "claude-4.5-sonnet": "claude-sonnet-4-5",
    "claude-4.5-opus": "claude-opus-4-5",
    "claude-4.6-sonnet": "claude-sonnet-4-6",
    "claude-4.6-opus": "claude-opus-4-6",
    "claude-4.1-opus": "claude-opus-4-1",
    "claude-4.0-sonnet": "claude-sonnet-4-0",
    "claude-4.0-opus": "claude-opus-4-0",
}

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


def _normalize_anthropic_model(model: str) -> str:
    normalized = model.strip()
    if not normalized:
        return normalized
    return _ANTHROPIC_MODEL_ALIASES.get(normalized.lower(), normalized)


def _extract_anthropic_error_details(error_text: str | None) -> dict[str, str] | None:
    if not error_text:
        return None
    try:
        payload = json.loads(error_text)
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if not isinstance(error, dict):
        return None
    error_type = str(error.get("type") or "").strip().lower()
    message = str(error.get("message") or "").strip()
    if error_type == "not_found_error" and message.lower().startswith("model:"):
        missing_model = message.split(":", 1)[1].strip()
        return {
            "code": "invalid_model_id",
            "message": f"Anthropic model ID not found: {missing_model}.",
        }
    if error_type in {"authentication_error", "permission_error"}:
        return {
            "code": "auth_failed",
            "message": "Anthropic authentication failed. Refresh credentials and retry.",
        }
    return None


def _build_anthropic_payload(model: str, prompt: str, max_tokens: int) -> dict[str, Any]:
    return {
        "model": _normalize_anthropic_model(model),
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
