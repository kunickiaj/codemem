from __future__ import annotations

import pytest

from opencode_mem.sync import http_client


class _ConnRequestFails:
    def __init__(self, *args, **kwargs) -> None:
        self.closed = False

    def request(self, method, path, body=None, headers=None) -> None:
        raise RuntimeError("boom")

    def close(self) -> None:
        self.closed = True


class _ConnReadFails:
    def __init__(self, *args, **kwargs) -> None:
        self.closed = False

    def request(self, method, path, body=None, headers=None) -> None:
        return

    def getresponse(self):
        return _RespReadFails()

    def close(self) -> None:
        self.closed = True


class _RespReadFails:
    status = 200

    def read(self) -> bytes:
        raise RuntimeError("read failed")


def test_request_json_closes_connection_when_request_raises(monkeypatch) -> None:
    conn = _ConnRequestFails()
    monkeypatch.setattr(http_client, "HTTPConnection", lambda *a, **k: conn)

    with pytest.raises(RuntimeError, match="boom"):
        http_client.request_json("GET", "http://127.0.0.1:7337/v1/status")

    assert conn.closed is True


def test_request_json_closes_connection_when_response_read_raises(monkeypatch) -> None:
    conn = _ConnReadFails()
    monkeypatch.setattr(http_client, "HTTPConnection", lambda *a, **k: conn)

    with pytest.raises(RuntimeError, match="read failed"):
        http_client.request_json("GET", "http://127.0.0.1:7337/v1/status")

    assert conn.closed is True
