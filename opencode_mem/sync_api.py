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


def _safe_int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


MAX_SYNC_BODY_BYTES = _safe_int_env("OPENCODE_MEM_SYNC_MAX_BODY_BYTES", 1048576)
MAX_SYNC_OPS = _safe_int_env("OPENCODE_MEM_SYNC_MAX_OPS", 2000)


def _read_body(handler: BaseHTTPRequestHandler) -> bytes:
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if length <= 0:
        return b""
    if length > MAX_SYNC_BODY_BYTES:
        raise ValueError("payload_too_large")
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


def _authorize_request(
    store: MemoryStore, handler: BaseHTTPRequestHandler, body: bytes
) -> tuple[bool, str]:
    device_id = handler.headers.get("X-Opencode-Device")
    signature = handler.headers.get("X-Opencode-Signature")
    timestamp = handler.headers.get("X-Opencode-Timestamp")
    nonce = handler.headers.get("X-Opencode-Nonce")
    if not device_id or not signature or not timestamp or not nonce:
        return False, "missing_headers"
    row = store.conn.execute(
        """
        SELECT pinned_fingerprint, public_key
        FROM sync_peers
        WHERE peer_device_id = ?
        """,
        (device_id,),
    ).fetchone()
    if row is None:
        return False, "unknown_peer"
    pinned_fingerprint = row["pinned_fingerprint"]
    public_key = row["public_key"]
    if not pinned_fingerprint or not public_key:
        return False, "peer_record_incomplete"
    if fingerprint_public_key(public_key) != pinned_fingerprint:
        return False, "fingerprint_mismatch"
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
        return False, "signature_verification_error"
    if not ok:
        return False, "invalid_signature"
    now = dt.datetime.now(dt.UTC)
    created_at = now.isoformat()
    if not record_nonce(store.conn, device_id=device_id, nonce=nonce, created_at=created_at):
        return False, "nonce_replay"
    cutoff = (now - dt.timedelta(seconds=DEFAULT_TIME_WINDOW_S * 2)).isoformat()
    cleanup_nonces(store.conn, cutoff=cutoff)
    return True, "ok"


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
                    authorized, _reason = _authorize_request(store, self, b"")
                    if not authorized:
                        self._unauthorized()
                        return
                    device_row = store.conn.execute(
                        "SELECT device_id, public_key, fingerprint FROM sync_device LIMIT 1"
                    ).fetchone()
                    if device_row:
                        device_id = device_row["device_id"]
                        fingerprint = device_row["fingerprint"]
                    else:
                        keys_dir_value = os.environ.get("OPENCODE_MEM_KEYS_DIR")
                        keys_dir = Path(keys_dir_value).expanduser() if keys_dir_value else None
                        device_id, fingerprint = ensure_device_identity(
                            store.conn, keys_dir=keys_dir
                        )
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
                    authorized, _reason = _authorize_request(store, self, b"")
                    if not authorized:
                        self._unauthorized()
                        return
                    peer_device_id = str(self.headers.get("X-Opencode-Device") or "")
                    params = parse_qs(parsed.query)
                    cursor = params.get("since", [None])[0]
                    limit_value = params.get("limit", ["200"])[0]
                    try:
                        limit = max(1, min(int(limit_value), 1000))
                    except (TypeError, ValueError):
                        limit = 200
                    ops, next_cursor = store.load_replication_ops_since(
                        cursor,
                        limit=limit,
                        device_id=store.device_id,
                    )
                    ops, next_cursor, skipped = store.filter_replication_ops_for_sync_with_status(
                        ops,
                        peer_device_id=peer_device_id or None,
                    )
                    payload: dict[str, Any] = {"ops": ops, "next_cursor": next_cursor}
                    if skipped is not None:
                        payload["skipped"] = skipped.get("skipped_count", 0)
                    _send_json(self, payload)
                except Exception:
                    _send_json(self, {"error": "internal_error"}, status=500)
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
                try:
                    raw = _read_body(self)
                except ValueError:
                    _send_json(self, {"error": "payload_too_large"}, status=413)
                    return
                authorized, _reason = _authorize_request(store, self, raw)
                if not authorized:
                    self._unauthorized()
                    return
                source_device_id = str(self.headers.get("X-Opencode-Device") or "")
                data = _parse_json_body(raw)
                if data is None:
                    _send_json(self, {"error": "invalid_json"}, status=400)
                    return
                ops = data.get("ops")
                if not isinstance(ops, list):
                    _send_json(self, {"error": "invalid_ops"}, status=400)
                    return
                if len(ops) > MAX_SYNC_OPS:
                    _send_json(self, {"error": "too_many_ops"}, status=413)
                    return
                normalized_ops: list[dict[str, Any]] = []
                for op in ops:
                    if not isinstance(op, dict):
                        continue
                    normalized_ops.append(op)
                received_at = dt.datetime.now(dt.UTC).isoformat()
                try:
                    result = store.apply_replication_ops(
                        cast(list[ReplicationOp], normalized_ops),
                        source_device_id=source_device_id,
                        received_at=received_at,
                    )
                except ValueError as exc:
                    _send_json(self, {"error": str(exc) or "invalid_ops"}, status=400)
                else:
                    _send_json(self, result)
            finally:
                store.close()

    return SyncHandler
