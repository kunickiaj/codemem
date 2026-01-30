from __future__ import annotations

import re

REDACTION_PATTERNS = [
    re.compile(r"api[_-]?key\s*[:=]\s*['\"]?[A-Za-z0-9_-]{20,}", re.IGNORECASE),
    re.compile(r"sk-[A-Za-z0-9]{10,}", re.IGNORECASE),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}", re.IGNORECASE),
]

ANSI_ESCAPE_RE = re.compile(
    r"""
    \x1B
    (?:
        [@-Z\\-_]
      | \[ [0-?]* [ -/]* [@-~]
      | \] [^\x1B]* (?:\x1B\\\\|\x07)
      | P  [0-?]* [ -/]* [\x20-\x7E]* (?:\x1B\\\\|\x07)
    )
    """,
    re.VERBOSE,
)


def redact(text: str) -> str:
    redacted = text
    for pattern in REDACTION_PATTERNS:
        redacted = pattern.sub("[REDACTED]", redacted)
    return redacted


def strip_ansi(text: str) -> str:
    return ANSI_ESCAPE_RE.sub("", text)
