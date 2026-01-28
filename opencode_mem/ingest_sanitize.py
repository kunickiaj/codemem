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
    return re.sub(r"<private>.*?</private>", "", text, flags=re.DOTALL | re.IGNORECASE)


def _sanitize_payload(value: Any, max_chars: int) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        return _truncate_text(_strip_private(value), max_chars)
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
