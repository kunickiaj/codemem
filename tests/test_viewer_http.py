from __future__ import annotations

import io
import json

from opencode_mem.viewer_http import (
    read_json_body,
    reject_cross_origin,
    send_html_response,
    send_json_response,
)


class DummyHandler:
    def __init__(self, body: bytes = b"", headers: dict[str, str] | None = None) -> None:
        self.headers = headers or {}
        self.rfile = io.BytesIO(body)
        self.wfile = io.BytesIO()
        self.status: int | None = None
        self.response_headers: list[tuple[str, str]] = []
        self.headers_ended = False

    def send_response(self, status: int) -> None:
        self.status = status

    def send_header(self, key: str, value: str) -> None:
        self.response_headers.append((key, value))

    def end_headers(self) -> None:
        self.headers_ended = True


def _header_value(handler: DummyHandler, name: str) -> str | None:
    for key, value in handler.response_headers:
        if key == name:
            return value
    return None


def test_send_json_response() -> None:
    handler = DummyHandler()
    payload = {"ok": True, "count": 2}
    expected_body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    send_json_response(handler, payload)

    assert handler.status == 200
    assert _header_value(handler, "Content-Type") == "application/json; charset=utf-8"
    assert _header_value(handler, "Content-Length") == str(len(expected_body))
    assert handler.headers_ended is True
    assert handler.wfile.getvalue() == expected_body


def test_send_html_response() -> None:
    handler = DummyHandler()
    html = "<h1>ok</h1>"
    expected_body = html.encode("utf-8")

    send_html_response(handler, html)

    assert handler.status == 200
    assert _header_value(handler, "Content-Type") == "text/html; charset=utf-8"
    assert _header_value(handler, "Content-Length") == str(len(expected_body))
    assert handler.headers_ended is True
    assert handler.wfile.getvalue() == expected_body


def test_read_json_body() -> None:
    payload = {"name": "opencode"}
    body = json.dumps(payload).encode("utf-8")
    handler = DummyHandler(body=body, headers={"Content-Length": str(len(body))})

    assert read_json_body(handler) == payload


def test_read_json_body_invalid_or_empty() -> None:
    handler_empty = DummyHandler(body=b"", headers={"Content-Length": "0"})
    assert read_json_body(handler_empty) is None

    handler_invalid = DummyHandler(body=b"not-json", headers={"Content-Length": "8"})
    assert read_json_body(handler_invalid) is None

    body_list = json.dumps([1, 2]).encode("utf-8")
    handler_list = DummyHandler(body=body_list, headers={"Content-Length": str(len(body_list))})
    assert read_json_body(handler_list) is None


def test_reject_cross_origin() -> None:
    handler_allowed = DummyHandler(headers={"Origin": "http://127.0.0.1:8080"})
    assert reject_cross_origin(handler_allowed) is False
    assert handler_allowed.status is None

    handler_missing = DummyHandler(headers={})
    assert reject_cross_origin(handler_missing) is False
    assert handler_missing.status is None

    handler_blocked = DummyHandler(headers={"Origin": "https://evil.test"})
    assert reject_cross_origin(handler_blocked) is True
    assert handler_blocked.status == 403
    response = json.loads(handler_blocked.wfile.getvalue().decode("utf-8"))
    assert response == {"error": "forbidden"}
