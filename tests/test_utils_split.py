from __future__ import annotations

import codemem.redaction as redaction
import codemem.utils as utils


def test_redact_is_stable_through_utils_facade() -> None:
    text = "api_key=abcdefghijabcdefghij"  # 20+ chars triggers redaction
    assert utils.redact(text) == "[REDACTED]"
    assert redaction.redact(text) == "[REDACTED]"


def test_strip_ansi_is_stable_through_utils_facade() -> None:
    raw = "hello\x1b[31mred\x1b[0m"
    assert utils.strip_ansi(raw) == "hellored"
    assert redaction.strip_ansi(raw) == "hellored"


def test_resolve_project_accepts_override() -> None:
    assert utils.resolve_project("/tmp", override=" demo ") == "demo"
