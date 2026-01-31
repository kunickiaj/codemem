from __future__ import annotations

import json
from http.client import HTTPConnection, HTTPSConnection
from typing import Any
from urllib.parse import urlparse


def build_base_url(address: str) -> str:
    trimmed = address.strip().rstrip("/")
    if not trimmed:
        return ""
    parsed = urlparse(trimmed)
    if parsed.scheme:
        return trimmed
    return f"http://{trimmed}"


def request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    body_bytes: bytes | None = None,
    timeout_s: float = 3.0,
) -> tuple[int, dict[str, Any] | None]:
    parsed = urlparse(url)
    if not parsed.hostname:
        raise ValueError("missing hostname")
    if parsed.scheme == "https":
        conn = HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=timeout_s)
    else:
        conn = HTTPConnection(parsed.hostname, parsed.port or 80, timeout=timeout_s)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    payload = None
    if body_bytes is None and body is not None:
        body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request_headers = {"Accept": "application/json"}
    if body_bytes is not None:
        request_headers["Content-Type"] = "application/json"
        request_headers["Content-Length"] = str(len(body_bytes))
    if headers:
        request_headers.update(headers)
    conn.request(method, path, body=body_bytes, headers=request_headers)
    resp = conn.getresponse()
    raw = resp.read()
    if raw:
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            snippet = raw[:240].decode("utf-8", errors="replace").strip()
            payload = {"error": f"non_json_response: {snippet}" if snippet else "non_json_response"}
    conn.close()
    if payload is None:
        return resp.status, None
    if isinstance(payload, dict):
        return resp.status, payload
    return resp.status, {"error": f"unexpected_json_type: {type(payload).__name__}"}
