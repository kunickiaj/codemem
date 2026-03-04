from __future__ import annotations

import json
import re
from typing import Any

from .capture import TRUNCATION_NOTICE
from .summarizer import is_low_signal_observation

LOW_SIGNAL_OUTPUTS = {
    "wrote file successfully.",
    "wrote file successfully",
    "file written successfully.",
    "read file successfully.",
    "read file successfully",
    "<file>",
    "<image>",
}

SENSITIVE_FIELD_RE = re.compile(
    r"(?:^|_|-)(?:token|secret|password|passwd|api[_-]?key|authorization|private[_-]?key|cookie)(?:$|_|-)",
    re.IGNORECASE,
)
REDACTED_VALUE = "[REDACTED]"


def _is_low_signal_output(output: str) -> bool:
    if not output:
        return True
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return True
    for line in lines:
        if line.lower() in LOW_SIGNAL_OUTPUTS:
            continue
        if is_low_signal_observation(line):
            continue
        return False
    return True


def _truncate_text(text: str, max_bytes: int) -> str:
    if max_bytes <= 0:
        return ""
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    truncated = encoded[:max_bytes].decode("utf-8", errors="replace")
    return f"{truncated}{TRUNCATION_NOTICE}"


def _strip_private(text: str) -> str:
    if not text:
        return ""
    redacted = re.sub(r"<private>.*?</private>", "", text, flags=re.DOTALL | re.IGNORECASE)
    start_match = re.search(r"<private>", redacted, flags=re.IGNORECASE)
    if start_match is not None:
        redacted = redacted[: start_match.start()]
    redacted = re.sub(r"</private>", "", redacted, flags=re.IGNORECASE)
    return redacted


def _is_sensitive_field_name(field_name: str) -> bool:
    normalized = field_name.strip().lower()
    if not normalized:
        return False
    return bool(SENSITIVE_FIELD_RE.search(normalized))


def _strip_private_obj(value: Any) -> Any:
    if isinstance(value, str):
        return _strip_private(value)
    if isinstance(value, list):
        return [_strip_private_obj(item) for item in value]
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if _is_sensitive_field_name(key_text):
                sanitized[key_text] = REDACTED_VALUE
                continue
            sanitized[key_text] = _strip_private_obj(item)
        return sanitized
    return value


def _sanitize_payload(value: Any, max_chars: int) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        return _truncate_text(_strip_private(value), max_chars)
    value = _strip_private_obj(value)
    try:
        serialized = json.dumps(value, ensure_ascii=False)
    except Exception:
        serialized = str(value)
    if max_chars > 0 and len(serialized) > max_chars:
        return _truncate_text(serialized, max_chars)
    return value


def _sanitize_tool_output(tool: str, output: Any, max_chars: int) -> Any:
    if output is None:
        return None
    # Keep outputs for read/write/edit - observer needs to see file contents
    # Only sanitize/truncate, don't blank
    sanitized = _sanitize_payload(output, max_chars)
    text = str(sanitized or "")
    if _is_low_signal_output(text):
        return ""
    return sanitized
