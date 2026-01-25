from __future__ import annotations

import datetime as dt
import json
import os
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, cast
from urllib.parse import parse_qs, urlparse

from .db import DEFAULT_DB_PATH
from .store import MemoryStore, ReplicationOp
from .sync_auth import DEFAULT_TIME_WINDOW_S, cleanup_nonces, record_nonce, verify_signature
from .sync_identity import ensure_device_identity, fingerprint_public_key

PROTOCOL_VERSION = "1"


def _read_body(handler: BaseHTTPRequestHandler) -> bytes:
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if length <= 0:
        return b""
    return handler.rfile.read(length)


def _parse_json_body(raw: bytes) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        data = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _send_json(handler: BaseHTTPRequestHandler, payload: dict[str, Any], status: int = 200) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _path_with_query(path: str) -> str:
    parsed = urlparse(path)
    if parsed.query:
        return f"{parsed.path}?{parsed.query}"
    return parsed.path


def _authorize_request(store: MemoryStore, handler: BaseHTTPRequestHandler, body: bytes) -> bool:
    device_id = handler.headers.get("X-Opencode-Device")
    signature = handler.headers.get("X-Opencode-Signature")
    timestamp = handler.headers.get("X-Opencode-Timestamp")
    nonce = handler.headers.get("X-Opencode-Nonce")
    if not device_id or not signature or not timestamp or not nonce:
        return False
    row = store.conn.execute(
        """
        SELECT pinned_fingerprint, public_key
        FROM sync_peers
        WHERE peer_device_id = ?
        """,
        (device_id,),
    ).fetchone()
    if row is None:
        return False
    pinned_fingerprint = row["pinned_fingerprint"]
    public_key = row["public_key"]
    if not pinned_fingerprint or not public_key:
        return False
    if fingerprint_public_key(public_key) != pinned_fingerprint:
        return False
    try:
        ok = verify_signature(
            method=handler.command,
            path_with_query=_path_with_query(handler.path),
            body_bytes=body,
            timestamp=timestamp,
            nonce=nonce,
            signature=signature,
            public_key=public_key,
            device_id=device_id,
        )
    except Exception:
        return False
    if not ok:
        return False
    now = dt.datetime.now(dt.UTC)
    created_at = now.isoformat()
    if not record_nonce(store.conn, device_id=device_id, nonce=nonce, created_at=created_at):
        return False
    cutoff = (now - dt.timedelta(seconds=DEFAULT_TIME_WINDOW_S * 2)).isoformat()
    cleanup_nonces(store.conn, cutoff=cutoff)
    return True


def build_sync_handler(db_path: Path | None = None):
    resolved_db = Path(db_path or os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)

    class SyncHandler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:  # noqa: A003
            if os.environ.get("OPENCODE_MEM_SYNC_LOGS") == "1":
                super().log_message(format, *args)

        def _store(self) -> MemoryStore:
            return MemoryStore(resolved_db)

        def _unauthorized(self) -> None:
            _send_json(self, {"error": "unauthorized"}, status=401)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path == "/v1/status":
                store = self._store()
                try:
                    if not _authorize_request(store, self, b""):
                        self._unauthorized()
                        return
                    device_id, fingerprint = ensure_device_identity(store.conn)
                except Exception:
                    _send_json(self, {"error": "internal_error"}, status=500)
                else:
                    _send_json(
                        self,
                        {
                            "device_id": device_id,
                            "protocol_version": PROTOCOL_VERSION,
                            "fingerprint": fingerprint,
                        },
                    )
                finally:
                    store.close()
                return

            if parsed.path == "/v1/ops":
                store = self._store()
                try:
                    if not _authorize_request(store, self, b""):
                        self._unauthorized()
                        return
                    params = parse_qs(parsed.query)
                    cursor = params.get("since", [None])[0]
                    limit_value = params.get("limit", ["200"])[0]
                    try:
                        limit = max(1, min(int(limit_value), 1000))
                    except (TypeError, ValueError):
                        limit = 200
                    ops, next_cursor = store.load_replication_ops_since(cursor, limit=limit)
                    _send_json(self, {"ops": ops, "next_cursor": next_cursor})
                finally:
                    store.close()
                return

            _send_json(self, {"error": "not_found"}, status=404)

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path != "/v1/ops":
                _send_json(self, {"error": "not_found"}, status=404)
                return
            store = self._store()
            try:
                raw = _read_body(self)
                if not _authorize_request(store, self, raw):
                    self._unauthorized()
                    return
                data = _parse_json_body(raw)
                if data is None:
                    _send_json(self, {"error": "invalid_json"}, status=400)
                    return
                ops = data.get("ops")
                if not isinstance(ops, list):
                    _send_json(self, {"error": "invalid_ops"}, status=400)
                    return
                normalized_ops: list[dict[str, Any]] = []
                for op in ops:
                    if not isinstance(op, dict):
                        continue
                    normalized_ops.append(op)
                result = store.apply_replication_ops(cast(list[ReplicationOp], normalized_ops))
                _send_json(self, result)
            finally:
                store.close()

    return SyncHandler
