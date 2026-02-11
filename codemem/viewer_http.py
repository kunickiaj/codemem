from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler
from typing import Any, Literal
from urllib.parse import urlparse

_ALLOWED_ORIGIN_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _is_allowed_loopback_origin_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "http":
        return False
    if parsed.username is not None or parsed.password is not None:
        return False
    try:
        hostname = parsed.hostname
        _ = parsed.port
    except ValueError:
        return False
    if hostname not in _ALLOWED_ORIGIN_HOSTS:
        return False
    return (
        parsed.path in ("", "/") and not parsed.params and not parsed.query and not parsed.fragment
    )


def _is_unsafe_missing_origin(handler: BaseHTTPRequestHandler) -> bool:
    sec_fetch_site = (handler.headers.get("Sec-Fetch-Site") or "").strip().lower()
    if sec_fetch_site and sec_fetch_site not in {"same-origin", "same-site", "none"}:
        return True
    referer = handler.headers.get("Referer")
    if not referer:
        return False
    return not _is_allowed_loopback_origin_url(referer)


def send_json_response(
    handler: BaseHTTPRequestHandler,
    payload: dict,
    status: int = 200,
) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def send_html_response(handler: BaseHTTPRequestHandler, html: str) -> None:
    body = html.encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def send_bytes_response(
    handler: BaseHTTPRequestHandler,
    body: bytes,
    *,
    content_type: str,
    status: int = 200,
) -> None:
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    if os.environ.get("CODEMEM_VIEWER_NO_CACHE") == "1":
        handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json_body(handler: BaseHTTPRequestHandler) -> dict[str, Any] | None:
    length = int(handler.headers.get("Content-Length", "0") or 0)
    raw = handler.rfile.read(length).decode("utf-8") if length else ""
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


MissingOriginPolicy = Literal["allow", "reject", "reject_if_unsafe"]


def reject_cross_origin(
    handler: BaseHTTPRequestHandler,
    *,
    missing_origin_policy: MissingOriginPolicy = "allow",
) -> bool:
    origin = handler.headers.get("Origin")
    if not origin:
        if missing_origin_policy == "allow":
            return False
        if missing_origin_policy == "reject":
            send_json_response(handler, {"error": "forbidden"}, status=403)
            return True
        if missing_origin_policy == "reject_if_unsafe":
            if _is_unsafe_missing_origin(handler):
                send_json_response(handler, {"error": "forbidden"}, status=403)
                return True
            return False
        send_json_response(handler, {"error": "forbidden"}, status=403)
        return True
    allowed = _is_allowed_loopback_origin_url(origin)
    if allowed:
        return False
    send_json_response(handler, {"error": "forbidden"}, status=403)
    return True
