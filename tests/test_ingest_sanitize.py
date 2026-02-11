from codemem.capture import TRUNCATION_NOTICE
from codemem.ingest_sanitize import (
    _is_low_signal_output,
    _sanitize_payload,
    _sanitize_tool_output,
    _strip_private,
    _truncate_text,
)


def test_strip_private_removes_blocks() -> None:
    text = "Hello <private>secret</private> world"
    stripped = _strip_private(text)
    assert "secret" not in stripped
    assert "Hello" in stripped


def test_truncate_text_appends_notice() -> None:
    text = "hello world"
    truncated = _truncate_text(text, max_bytes=5)
    assert truncated == f"hello{TRUNCATION_NOTICE}"


def test_truncate_text_handles_zero_limit() -> None:
    assert _truncate_text("hello", max_bytes=0) == ""


def test_sanitize_payload_strips_private() -> None:
    text = "Hello <private>secret</private> world"
    sanitized = _sanitize_payload(text, max_chars=200)
    assert "secret" not in sanitized


def test_sanitize_payload_truncates_large_objects() -> None:
    payload = {"a": "b" * 10}
    sanitized = _sanitize_payload(payload, max_chars=5)
    assert isinstance(sanitized, str)
    assert sanitized.endswith(TRUNCATION_NOTICE)


def test_is_low_signal_output_recognizes_trivial_text() -> None:
    assert _is_low_signal_output("") is True
    assert _is_low_signal_output("<file>") is True
    assert _is_low_signal_output("Traceback: boom") is False


def test_sanitize_tool_output_blanks_low_signal() -> None:
    assert _sanitize_tool_output("read", "<file>", max_chars=200) == ""
    assert _sanitize_tool_output("bash", "data", max_chars=200) == "data"
    assert _sanitize_tool_output("bash", None, max_chars=200) is None
