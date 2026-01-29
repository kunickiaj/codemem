from __future__ import annotations

import os
import re
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import viewer_raw_events
from .config import load_config  # noqa: F401
from .db import DEFAULT_DB_PATH
from .observer import _load_opencode_config
from .raw_event_flush import flush_raw_events  # noqa: F401
from .store import MemoryStore
from .viewer_html import VIEWER_HTML
from .viewer_http import (
    read_json_body,
    reject_cross_origin,
    send_html_response,
    send_json_response,
)
from .viewer_routes import config as viewer_routes_config
from .viewer_routes import memory as viewer_routes_memory
from .viewer_routes import raw_events as viewer_routes_raw_events
from .viewer_routes import stats as viewer_routes_stats
from .viewer_routes import sync as viewer_routes_sync

DEFAULT_VIEWER_HOST = "127.0.0.1"
DEFAULT_VIEWER_PORT = 38888
DEFAULT_PROVIDER_OPTIONS = ("openai", "anthropic")


def _strip_private(text: str) -> str:
    if not text:
        return ""
    return re.sub(r"<private>.*?</private>", "", text, flags=re.DOTALL | re.IGNORECASE)


def _strip_private_obj(value: Any) -> Any:
    if isinstance(value, str):
        return _strip_private(value)
    if isinstance(value, list):
        return [_strip_private_obj(item) for item in value]
    if isinstance(value, dict):
        return {k: _strip_private_obj(v) for k, v in value.items()}
    return value


RawEventAutoFlusher = viewer_raw_events.RawEventAutoFlusher
RawEventSweeper = viewer_raw_events.RawEventSweeper
RAW_EVENT_FLUSHER = viewer_raw_events.RAW_EVENT_FLUSHER
RAW_EVENT_SWEEPER = viewer_raw_events.RAW_EVENT_SWEEPER


def _load_provider_options() -> list[str]:
    config = _load_opencode_config()
    provider_config = config.get("provider", {})
    providers: list[str] = []
    if isinstance(provider_config, dict):
        providers = [key for key in provider_config if isinstance(key, str) and key]
    if not providers:
        return list(DEFAULT_PROVIDER_OPTIONS)
    combined = sorted(set(providers) | set(DEFAULT_PROVIDER_OPTIONS))
    return combined


class ViewerHandler(BaseHTTPRequestHandler):
    def _send_json(self, payload: dict, status: int = 200) -> None:
        send_json_response(self, payload, status=status)

    def _send_html(self) -> None:
        send_html_response(self, VIEWER_HTML)

    def _read_json(self) -> dict[str, Any] | None:
        return read_json_body(self)

    def _reject_cross_origin(self) -> bool:
        return reject_cross_origin(self)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        if os.environ.get("OPENCODE_MEM_VIEWER_LOGS") == "1":
            super().log_message(format, *args)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send_html()
            return

        is_api = parsed.path.startswith("/api/")
        store: MemoryStore | None = None
        try:
            store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
            if viewer_routes_stats.handle_get(self, store, parsed.path, parsed.query):
                return
            if parsed.path == "/api/raw-events/status":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["25"])[0])
                self._send_json(
                    {
                        "items": store.raw_event_backlog(limit=limit),
                        "totals": store.raw_event_backlog_totals(),
                    }
                )
                return
            if viewer_routes_memory.handle_get(self, store, parsed.path, parsed.query):
                return
            if viewer_routes_config.handle_get(
                self,
                path=parsed.path,
                load_provider_options=_load_provider_options,
            ):
                return
            if viewer_routes_sync.handle_get(self, store, parsed.path, parsed.query):
                return
            self.send_response(404)
            self.end_headers()
        except Exception as exc:  # pragma: no cover
            if is_api:
                payload: dict[str, Any] = {"error": "internal server error"}
                if os.environ.get("OPENCODE_MEM_VIEWER_DEBUG") == "1":
                    payload["detail"] = str(exc)
                self._send_json(payload, status=500)
                return
            self.send_response(500)
            self.end_headers()
        finally:
            if store is not None:
                store.close()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if self._reject_cross_origin():
            return
        if parsed.path in {"/api/sync/peers/rename", "/api/sync/actions/sync-now"}:
            payload = self._read_json()
            if parsed.path == "/api/sync/actions/sync-now" and payload is None:
                payload = {}
            store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
            try:
                if viewer_routes_sync.handle_post(self, store, parsed.path, payload):
                    return
            finally:
                store.close()
        if viewer_routes_raw_events.handle_post(
            self,
            path=parsed.path,
            store_factory=MemoryStore,
            default_db_path=DEFAULT_DB_PATH,
            flusher=RAW_EVENT_FLUSHER,
            strip_private_obj=_strip_private_obj,
        ):
            return

        if viewer_routes_config.handle_post(
            self,
            path=parsed.path,
            load_provider_options=_load_provider_options,
        ):
            return

        self.send_response(404)
        self.end_headers()

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if self._reject_cross_origin():
            return
        store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
        try:
            if viewer_routes_sync.handle_delete(self, store, parsed.path):
                return
            self.send_response(404)
            self.end_headers()
        finally:
            store.close()


def _serve(host: str, port: int) -> None:
    RAW_EVENT_SWEEPER.start()
    server = HTTPServer((host, port), ViewerHandler)
    server.serve_forever()


def start_viewer(
    host: str = DEFAULT_VIEWER_HOST,
    port: int = DEFAULT_VIEWER_PORT,
    background: bool = False,
) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        try:
            if sock.connect_ex((host, port)) == 0:
                return
        except OSError:
            pass
    if background:
        thread = threading.Thread(target=_serve, args=(host, port), daemon=True)
        thread.start()
    else:
        _serve(host, port)
