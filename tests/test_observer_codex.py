from __future__ import annotations

from opencode_mem import observer_codex


class StubResponse:
    def __init__(self, lines: list[object]) -> None:
        self._lines = lines

    def iter_lines(self) -> list[object]:
        return self._lines


def test_parse_codex_stream_collects_deltas() -> None:
    lines = [
        b"",
        b"event: ping",
        b'data: {"type": "response.output_text.delta", "delta": "Hello "}',
        'data: {"type": "response.output_text.delta", "delta": "world"}',
        b"data: [DONE]",
        b"data: {not-json}",
    ]
    response = StubResponse(lines)

    assert observer_codex._parse_codex_stream(response) == "Hello world"


def test_parse_codex_stream_returns_none_without_text() -> None:
    lines = [
        b'data: {"type": "response.output_text.delta", "delta": ""}',
        b'data: {"type": "response.output_text.delta", "delta": null}',
        b'data: {"type": "response.completed"}',
    ]
    response = StubResponse(lines)

    assert observer_codex._parse_codex_stream(response) is None


def test_redact_text_replaces_tokens() -> None:
    text = "token sk-ABCDEFGH123456 Bearer ABCDEFGHIJ"
    result = observer_codex._redact_text(text)

    assert "[redacted]" in result
    assert "sk-ABCDEFGH123456" not in result
    assert "Bearer ABCDEFGHIJ" not in result


def test_redact_text_truncates_with_ellipsis() -> None:
    text = "sk-ABCDEFGH123456" * 5
    result = observer_codex._redact_text(text, limit=8)

    assert result.endswith("…")
