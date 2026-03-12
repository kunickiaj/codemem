from __future__ import annotations

import datetime as dt
import json
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .coordinator_store import DEFAULT_COORDINATOR_DB_PATH, CoordinatorStore
from .sync_auth import DEFAULT_TIME_WINDOW_S, verify_signature

MAX_COORDINATOR_BODY_BYTES = 64 * 1024


def _send_json(handler: BaseHTTPRequestHandler, payload: dict[str, Any], status: int = 200) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _path_with_query(path: str) -> str:
    parsed = urlparse(path)
    return f"{parsed.path}?{parsed.query}" if parsed.query else parsed.path


def _read_body(handler: BaseHTTPRequestHandler) -> bytes:
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if length > MAX_COORDINATOR_BODY_BYTES:
        raise ValueError("body_too_large")
    return handler.rfile.read(length) if length > 0 else b""


def _parse_json_body(raw: bytes) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        data = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _record_nonce(store: CoordinatorStore, *, device_id: str, nonce: str, created_at: str) -> bool:
    try:
        store.conn.execute(
            "INSERT INTO request_nonces(device_id, nonce, created_at) VALUES (?, ?, ?)",
            (device_id, nonce, created_at),
        )
        store.conn.commit()
        return True
    except Exception:
        return False


def _cleanup_nonces(store: CoordinatorStore, *, cutoff: str) -> None:
    store.conn.execute("DELETE FROM request_nonces WHERE created_at < ?", (cutoff,))
    store.conn.commit()


def _authorize_request(
    store: CoordinatorStore,
    handler: BaseHTTPRequestHandler,
    *,
    group_id: str,
    body: bytes,
) -> tuple[bool, str, dict[str, Any] | None]:
    device_id = handler.headers.get("X-Opencode-Device")
    signature = handler.headers.get("X-Opencode-Signature")
    timestamp = handler.headers.get("X-Opencode-Timestamp")
    nonce = handler.headers.get("X-Opencode-Nonce")
    if not device_id or not signature or not timestamp or not nonce:
        return False, "missing_headers", None
    enrollment = store.get_enrollment(group_id=group_id, device_id=device_id)
    if enrollment is None:
        return False, "unknown_device", None
    try:
        ok = verify_signature(
            method=handler.command,
            path_with_query=_path_with_query(handler.path),
            body_bytes=body,
            timestamp=timestamp,
            nonce=nonce,
            signature=signature,
            public_key=str(enrollment["public_key"]),
            device_id=device_id,
        )
    except Exception:
        return False, "signature_verification_error", None
    if not ok:
        return False, "invalid_signature", None
    created_at = dt.datetime.now(dt.UTC).isoformat()
    if not _record_nonce(store, device_id=device_id, nonce=nonce, created_at=created_at):
        return False, "nonce_replay", None
    cutoff = (dt.datetime.now(dt.UTC) - dt.timedelta(seconds=DEFAULT_TIME_WINDOW_S * 2)).isoformat()
    _cleanup_nonces(store, cutoff=cutoff)
    return True, "ok", enrollment


def build_coordinator_handler(db_path: Path | None = None):
    resolved_db = Path(db_path or DEFAULT_COORDINATOR_DB_PATH).expanduser()

    class CoordinatorHandler(BaseHTTPRequestHandler):
        def _store(self) -> CoordinatorStore:
            return CoordinatorStore(resolved_db)

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path != "/v1/presence":
                _send_json(self, {"error": "not_found"}, status=404)
                return
            store = self._store()
            try:
                try:
                    raw = _read_body(self)
                except ValueError as exc:
                    if str(exc) == "body_too_large":
                        _send_json(self, {"error": "body_too_large"}, status=413)
                        return
                    raise
                data = _parse_json_body(raw)
                if data is None:
                    _send_json(self, {"error": "invalid_json"}, status=400)
                    return
                group_id = str(data.get("group_id") or "").strip()
                if not group_id:
                    _send_json(self, {"error": "group_id_required"}, status=400)
                    return
                ok, reason, enrollment = _authorize_request(
                    store, self, group_id=group_id, body=raw
                )
                if not ok or enrollment is None:
                    _send_json(self, {"error": reason}, status=401)
                    return
                if data.get("fingerprint") and str(data.get("fingerprint")) != str(
                    enrollment["fingerprint"]
                ):
                    _send_json(self, {"error": "fingerprint_mismatch"}, status=401)
                    return
                raw_addresses = data.get("addresses") or []
                if not isinstance(raw_addresses, list) or not all(
                    isinstance(item, str) for item in raw_addresses
                ):
                    _send_json(self, {"error": "addresses_must_be_list_of_strings"}, status=400)
                    return
                try:
                    ttl_s = max(1, int(data.get("ttl_s") or 180))
                except (TypeError, ValueError):
                    _send_json(self, {"error": "ttl_s_must_be_int"}, status=400)
                    return
                response = store.upsert_presence(
                    group_id=group_id,
                    device_id=str(enrollment["device_id"]),
                    addresses=raw_addresses,
                    ttl_s=ttl_s,
                    capabilities=data.get("capabilities")
                    if isinstance(data.get("capabilities"), dict)
                    else None,
                )
                _send_json(self, {"ok": True, **response})
            finally:
                store.close()

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path != "/v1/peers":
                _send_json(self, {"error": "not_found"}, status=404)
                return
            params = parse_qs(parsed.query)
            group_id = str(params.get("group_id", [""])[0] or "").strip()
            if not group_id:
                _send_json(self, {"error": "group_id_required"}, status=400)
                return
            store = self._store()
            try:
                ok, reason, enrollment = _authorize_request(
                    store, self, group_id=group_id, body=b""
                )
                if not ok or enrollment is None:
                    _send_json(self, {"error": reason}, status=401)
                    return
                items = store.list_group_peers(
                    group_id=group_id,
                    requesting_device_id=str(enrollment["device_id"]),
                )
                _send_json(self, {"items": items})
            finally:
                store.close()

    return CoordinatorHandler
