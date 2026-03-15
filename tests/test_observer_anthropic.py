from __future__ import annotations

import json
import sys
from collections.abc import Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from codemem.config import OpencodeMemConfig
from codemem.observer import ObserverAuthError, ObserverClient
from codemem.observer_anthropic import (
    ANTHROPIC_MESSAGES_ENDPOINT,
    ANTHROPIC_OAUTH_BETA,
    ANTHROPIC_OAUTH_USER_AGENT,
    _build_anthropic_headers,
    _build_anthropic_payload,
    _parse_anthropic_stream,
    _resolve_anthropic_endpoint,
)


def test_build_anthropic_headers_sets_bearer_auth() -> None:
    headers = _build_anthropic_headers("test-token")
    assert headers["authorization"] == "Bearer test-token"
    assert ANTHROPIC_OAUTH_BETA in headers["anthropic-beta"]
    assert headers["user-agent"] == ANTHROPIC_OAUTH_USER_AGENT
    assert headers["content-type"] == "application/json"
    assert headers["anthropic-version"] == "2023-06-01"
    assert "x-api-key" not in headers


def test_build_anthropic_payload_structure() -> None:
    payload = _build_anthropic_payload("claude-4.5-haiku", "hello world", 1024)
    assert payload["model"] == "claude-4.5-haiku"
    assert payload["max_tokens"] == 1024
    assert payload["stream"] is True
    assert payload["system"] == "You are a memory observer."
    assert len(payload["messages"]) == 1
    assert payload["messages"][0]["role"] == "user"
    assert payload["messages"][0]["content"] == "hello world"


def test_resolve_anthropic_endpoint_default() -> None:
    with patch.dict("os.environ", {}, clear=False):
        endpoint = _resolve_anthropic_endpoint()
    assert endpoint == ANTHROPIC_MESSAGES_ENDPOINT


def test_resolve_anthropic_endpoint_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CODEMEM_ANTHROPIC_ENDPOINT", "https://custom.example/v1/messages")
    assert _resolve_anthropic_endpoint() == "https://custom.example/v1/messages"


class _FakeStreamResponse:
    """Simulate httpx streaming response with iter_lines()."""

    def __init__(
        self,
        lines: Sequence[Any],
        *,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        text: str = "",
    ) -> None:
        self._lines = lines
        self.status_code = status_code
        self.headers = headers or {}
        self.text = text

    def iter_lines(self):
        yield from self._lines

    def raise_for_status(self) -> None:
        pass

    def read(self) -> None:
        pass


def test_parse_anthropic_stream_extracts_text_deltas() -> None:
    lines = [
        "event: message_start",
        'data: {"type": "message_start", "message": {"id": "msg_1"}}',
        "",
        "event: content_block_start",
        'data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}',
        "",
        "event: content_block_delta",
        'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}',
        "",
        "event: content_block_delta",
        'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": " world"}}',
        "",
        "event: content_block_stop",
        'data: {"type": "content_block_stop", "index": 0}',
        "",
        "event: message_stop",
        'data: {"type": "message_stop"}',
    ]
    response = _FakeStreamResponse(lines)
    result = _parse_anthropic_stream(response)
    assert result == "Hello world"


def test_parse_anthropic_stream_handles_empty_response() -> None:
    response = _FakeStreamResponse([])
    assert _parse_anthropic_stream(response) is None


def test_parse_anthropic_stream_handles_no_text_deltas() -> None:
    lines = [
        'data: {"type": "message_start", "message": {"id": "msg_1"}}',
        'data: {"type": "message_stop"}',
    ]
    response = _FakeStreamResponse(lines)
    assert _parse_anthropic_stream(response) is None


def test_parse_anthropic_stream_handles_bytes() -> None:
    lines = [
        b'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hi"}}',
    ]
    response = _FakeStreamResponse(lines)
    result = _parse_anthropic_stream(response)
    assert result == "Hi"


def test_parse_anthropic_stream_skips_malformed_json() -> None:
    lines = [
        "data: not valid json",
        'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Ok"}}',
    ]
    response = _FakeStreamResponse(lines)
    result = _parse_anthropic_stream(response)
    assert result == "Ok"


def test_parse_anthropic_stream_skips_done_marker() -> None:
    lines = [
        'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Result"}}',
        "data: [DONE]",
    ]
    response = _FakeStreamResponse(lines)
    result = _parse_anthropic_stream(response)
    assert result == "Result"


def test_parse_anthropic_stream_ignores_non_text_deltas() -> None:
    """Ensure we only extract text_delta, not other delta types like input_json_delta."""
    lines = [
        'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{"}}',
        'data: {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Actual text"}}',
    ]
    response = _FakeStreamResponse(lines)
    result = _parse_anthropic_stream(response)
    assert result == "Actual text"


# ---------------------------------------------------------------------------
# Integration tests: ObserverClient with Anthropic OAuth consumer path
# ---------------------------------------------------------------------------


def _anthropic_sse_lines(text: str) -> list[str]:
    """Build minimal Anthropic SSE lines for a text response."""
    return [
        'data: {"type": "message_start", "message": {"id": "msg_1"}}',
        f'data: {{"type": "content_block_delta", "index": 0, "delta": {{"type": "text_delta", "text": "{text}"}}}}',
        'data: {"type": "message_stop"}',
    ]


def _make_anthropic_oauth_client(
    tmp_path: Path,
    *,
    access_token: str = "anthropic-access",
    expires: int = 9999999999999,
) -> ObserverClient:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(
        json.dumps(
            {
                "anthropic": {
                    "type": "oauth",
                    "access": access_token,
                    "refresh": "anthropic-refresh",
                    "expires": expires,
                }
            }
        )
    )
    cfg = OpencodeMemConfig(observer_api_key=None, observer_provider="anthropic")
    with (
        patch("codemem.observer.load_config", return_value=cfg),
        patch("codemem.observer._get_opencode_auth_path", return_value=auth_path),
        patch.dict("os.environ", {}, clear=True),
    ):
        return ObserverClient()


def test_anthropic_consumer_call_success(tmp_path: Path) -> None:
    """Full round-trip: OAuth token → consumer endpoint → parsed response."""
    client = _make_anthropic_oauth_client(tmp_path)
    assert client.anthropic_oauth_access == "anthropic-access"

    stream_lines = _anthropic_sse_lines("observer result")
    fake_response = _FakeStreamResponse(stream_lines, status_code=200)

    class FakeHTTPXClient:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args: object):
            pass

        def stream(self, method: str, url: str, **kwargs: object):
            self._captured_url = url
            self._captured_headers = kwargs.get("headers", {})
            return _StreamContextManager(fake_response)

    class _StreamContextManager:
        def __init__(self, resp: object) -> None:
            self._resp = resp

        def __enter__(self):
            return self._resp

        def __exit__(self, *_args: object):
            pass

    httpx_module = SimpleNamespace(Client=FakeHTTPXClient)
    with patch.dict(sys.modules, {"httpx": httpx_module}):
        result = client._call("hello")

    assert result == "observer result"


def test_anthropic_consumer_call_auth_error(tmp_path: Path) -> None:
    """401 from the API raises ObserverAuthError."""
    client = _make_anthropic_oauth_client(tmp_path)

    fake_response = _FakeStreamResponse([], status_code=401, text="Unauthorized")

    class FakeHTTPXClient:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args: object):
            pass

        def stream(self, method: str, url: str, **kwargs: object):
            return _StreamContextManager(fake_response)

    class _StreamContextManager:
        def __init__(self, resp: object) -> None:
            self._resp = resp

        def __enter__(self):
            return self._resp

        def __exit__(self, *_args: object):
            pass

    httpx_module = SimpleNamespace(Client=FakeHTTPXClient)
    with (
        patch.dict(sys.modules, {"httpx": httpx_module}),
        pytest.raises(ObserverAuthError),
    ):
        client._call("hello")


def test_anthropic_consumer_sends_correct_headers(tmp_path: Path) -> None:
    """Verify the consumer path sends Bearer auth and the oauth beta header."""
    client = _make_anthropic_oauth_client(tmp_path)

    captured_headers: dict[str, str] = {}

    stream_lines = _anthropic_sse_lines("ok")
    fake_response = _FakeStreamResponse(stream_lines, status_code=200)

    class FakeHTTPXClient:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args: object):
            pass

        def stream(self, method: str, url: str, **kwargs: object):
            hdrs = kwargs.get("headers")
            if isinstance(hdrs, dict):
                captured_headers.update(hdrs)
            self._captured_url = url
            return _StreamContextManager(fake_response)

    class _StreamContextManager:
        def __init__(self, resp: object) -> None:
            self._resp = resp

        def __enter__(self):
            return self._resp

        def __exit__(self, *_args: object):
            pass

    httpx_module = SimpleNamespace(Client=FakeHTTPXClient)
    with patch.dict(sys.modules, {"httpx": httpx_module}):
        client._call("hello")

    assert captured_headers["authorization"] == "Bearer anthropic-access"
    assert ANTHROPIC_OAUTH_BETA in captured_headers["anthropic-beta"]
    assert captured_headers["user-agent"] == ANTHROPIC_OAUTH_USER_AGENT
    assert "x-api-key" not in captured_headers


def test_anthropic_consumer_url_has_beta_param(tmp_path: Path) -> None:
    """Verify the request URL includes ?beta=true."""
    client = _make_anthropic_oauth_client(tmp_path)

    captured_urls: list[str] = []

    stream_lines = _anthropic_sse_lines("ok")
    fake_response = _FakeStreamResponse(stream_lines, status_code=200)

    class FakeHTTPXClient:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args: object):
            pass

        def stream(self, method: str, url: str, **kwargs: object):
            captured_urls.append(url)
            return _StreamContextManager(fake_response)

    class _StreamContextManager:
        def __init__(self, resp: object) -> None:
            self._resp = resp

        def __enter__(self):
            return self._resp

        def __exit__(self, *_args: object):
            pass

    httpx_module = SimpleNamespace(Client=FakeHTTPXClient)
    with patch.dict(sys.modules, {"httpx": httpx_module}):
        client._call("hello")

    assert len(captured_urls) == 1
    assert "beta=true" in captured_urls[0]
    assert captured_urls[0].startswith(ANTHROPIC_MESSAGES_ENDPOINT)


def test_anthropic_consumer_url_preserves_existing_query_params(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When CODEMEM_ANTHROPIC_ENDPOINT has query params, beta=true is appended correctly."""
    monkeypatch.setenv(
        "CODEMEM_ANTHROPIC_ENDPOINT",
        "https://proxy.example/v1/messages?api-version=2023-06-01",
    )
    client = _make_anthropic_oauth_client(tmp_path)

    captured_urls: list[str] = []

    stream_lines = _anthropic_sse_lines("ok")
    fake_response = _FakeStreamResponse(stream_lines, status_code=200)

    class FakeHTTPXClient:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args: object):
            pass

        def stream(self, method: str, url: str, **kwargs: object):
            captured_urls.append(url)
            return _StreamContextManager(fake_response)

    class _StreamContextManager:
        def __init__(self, resp: object) -> None:
            self._resp = resp

        def __enter__(self):
            return self._resp

        def __exit__(self, *_args: object):
            pass

    httpx_module = SimpleNamespace(Client=FakeHTTPXClient)
    with patch.dict(sys.modules, {"httpx": httpx_module}):
        client._call("hello")

    assert len(captured_urls) == 1
    assert "api-version=2023-06-01" in captured_urls[0]
    assert "beta=true" in captured_urls[0]
    assert "?" in captured_urls[0]
    # Should not have double question marks
    assert "??" not in captured_urls[0]
