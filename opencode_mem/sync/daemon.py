from __future__ import annotations

import contextlib
import datetime as dt
import socket
import threading
import traceback
from http.server import HTTPServer
from pathlib import Path

from .. import db
from ..store import MemoryStore
from ..sync_api import build_sync_handler
from ..sync_identity import ensure_device_identity
from . import sync_pass
from .discovery import advertise_mdns, mdns_enabled


def run_sync_daemon(
    host: str,
    port: int,
    interval_s: int,
    *,
    db_path: Path | None = None,
    stop_event: threading.Event | None = None,
) -> None:
    handler = build_sync_handler(db_path)

    class Server(HTTPServer):
        address_family = socket.AF_INET6 if ":" in host else socket.AF_INET

        def server_bind(self) -> None:
            if self.address_family == socket.AF_INET6:
                with contextlib.suppress(OSError):
                    self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            super().server_bind()

    server = Server((host, port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    zeroconf = None
    if mdns_enabled():
        store = MemoryStore(db_path or db.DEFAULT_DB_PATH)
        try:
            device_id, _ = ensure_device_identity(store.conn)
        finally:
            store.close()
        zeroconf = advertise_mdns(device_id=device_id, port=port)
    stop = stop_event or threading.Event()
    try:
        while not stop.wait(interval_s):
            store = MemoryStore(db_path or db.DEFAULT_DB_PATH)
            try:
                try:
                    sync_pass.sync_daemon_tick(store)
                    store.set_sync_daemon_ok()
                except Exception as exc:
                    tb = traceback.format_exc()
                    store.set_sync_daemon_error(str(exc), tb)
                    _append_sync_daemon_log(tb)
            finally:
                store.close()
    finally:
        server.shutdown()
        if zeroconf is not None:
            with contextlib.suppress(Exception):
                zeroconf.close()


def _append_sync_daemon_log(message: str) -> None:
    try:
        log_dir = Path.home() / ".opencode-mem"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "sync-daemon.log"
        ts = dt.datetime.now(dt.UTC).isoformat()
        with log_path.open("a", encoding="utf-8", errors="ignore") as handle:
            handle.write(f"\n[{ts}]\n{message}\n")
    except Exception:
        return
