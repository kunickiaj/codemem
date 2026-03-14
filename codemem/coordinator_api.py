from __future__ import annotations

import datetime as dt
import json
import os
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .coordinator_invites import InvitePayload, encode_invite_payload, invite_link
from .coordinator_store import DEFAULT_COORDINATOR_DB_PATH, CoordinatorStore
from .sync_auth import DEFAULT_TIME_WINDOW_S, verify_signature

MAX_COORDINATOR_BODY_BYTES = 64 * 1024
ADMIN_HEADER = "X-Codemem-Coordinator-Admin"


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


def _admin_secret() -> str | None:
    value = os.environ.get("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET")
    cleaned = str(value or "").strip()
    return cleaned or None


def _authorize_admin_request(handler: BaseHTTPRequestHandler) -> tuple[bool, str]:
    expected = _admin_secret()
    if not expected:
        return False, "admin_not_configured"
    provided = str(handler.headers.get(ADMIN_HEADER) or "").strip()
    if not provided:
        return False, "missing_admin_header"
    if provided != expected:
        return False, "invalid_admin_secret"
    return True, "ok"


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
            if parsed.path.startswith("/v1/admin/devices"):
                return self._handle_admin_post(parsed.path)
            if parsed.path == "/v1/admin/invites":
                return self._handle_admin_post(parsed.path)
            if parsed.path.startswith("/v1/admin/join-requests"):
                return self._handle_admin_post(parsed.path)
            if parsed.path == "/v1/join":
                return self._handle_join()
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
            if parsed.path == "/v1/admin/devices":
                return self._handle_admin_list(parsed.query)
            if parsed.path == "/v1/admin/invites":
                return self._handle_admin_list_invites(parsed.query)
            if parsed.path == "/v1/admin/join-requests":
                return self._handle_admin_list_join_requests(parsed.query)
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

        def _handle_admin_list(self, query: str) -> None:
            ok, reason = _authorize_admin_request(self)
            if not ok:
                _send_json(self, {"error": reason}, status=401)
                return
            params = parse_qs(query)
            group_id = str(params.get("group_id", [""])[0] or "").strip()
            include_disabled = str(
                params.get("include_disabled", ["0"])[0] or ""
            ).strip().lower() in {
                "1",
                "true",
                "yes",
            }
            if not group_id:
                _send_json(self, {"error": "group_id_required"}, status=400)
                return
            store = self._store()
            try:
                _send_json(
                    self,
                    {
                        "items": store.list_enrolled_devices(
                            group_id=group_id,
                            include_disabled=include_disabled,
                        )
                    },
                )
            finally:
                store.close()

        def _handle_admin_list_invites(self, query: str) -> None:
            ok, reason = _authorize_admin_request(self)
            if not ok:
                _send_json(self, {"error": reason}, status=401)
                return
            params = parse_qs(query)
            group_id = str(params.get("group_id", [""])[0] or "").strip()
            if not group_id:
                _send_json(self, {"error": "group_id_required"}, status=400)
                return
            store = self._store()
            try:
                rows = store.conn.execute(
                    """
                    SELECT invite_id, group_id, policy, expires_at, created_at, created_by, team_name_snapshot, revoked_at
                    FROM coordinator_invites
                    WHERE group_id = ?
                    ORDER BY created_at DESC
                    """,
                    (group_id,),
                ).fetchall()
                _send_json(self, {"items": [dict(row) for row in rows]})
            finally:
                store.close()

        def _handle_admin_list_join_requests(self, query: str) -> None:
            ok, reason = _authorize_admin_request(self)
            if not ok:
                _send_json(self, {"error": reason}, status=401)
                return
            params = parse_qs(query)
            group_id = str(params.get("group_id", [""])[0] or "").strip()
            if not group_id:
                _send_json(self, {"error": "group_id_required"}, status=400)
                return
            store = self._store()
            try:
                _send_json(self, {"items": store.list_join_requests(group_id=group_id)})
            finally:
                store.close()

        def _handle_admin_post(self, path: str) -> None:
            ok, reason = _authorize_admin_request(self)
            if not ok:
                _send_json(self, {"error": reason}, status=401)
                return
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
            device_id = str(data.get("device_id") or "").strip()
            if path == "/v1/admin/devices":
                fingerprint = str(data.get("fingerprint") or "").strip()
                public_key = str(data.get("public_key") or "").strip()
                display_name = str(data.get("display_name") or "").strip() or None
                if not group_id or not device_id or not fingerprint or not public_key:
                    _send_json(
                        self,
                        {"error": "group_id_device_id_fingerprint_public_key_required"},
                        status=400,
                    )
                    return
                store = self._store()
                try:
                    store.create_group(group_id)
                    store.enroll_device(
                        group_id,
                        device_id=device_id,
                        fingerprint=fingerprint,
                        public_key=public_key,
                        display_name=display_name,
                    )
                finally:
                    store.close()
                _send_json(self, {"ok": True})
                return
            if path == "/v1/admin/invites":
                policy = str(data.get("policy") or "auto_admit").strip()
                expires_at = str(data.get("expires_at") or "").strip()
                created_by = str(data.get("created_by") or "").strip() or None
                if (
                    not group_id
                    or policy not in {"auto_admit", "approval_required"}
                    or not expires_at
                ):
                    _send_json(
                        self,
                        {"error": "group_id_policy_and_expires_at_required"},
                        status=400,
                    )
                    return
                store = self._store()
                try:
                    group = store.get_group(group_id)
                    if group is None:
                        _send_json(self, {"error": "group_not_found"}, status=404)
                        return
                    invite = store.create_invite(
                        group_id=group_id,
                        policy=policy,
                        expires_at=expires_at,
                        created_by=created_by,
                    )
                finally:
                    store.close()
                payload: InvitePayload = {
                    "v": 1,
                    "kind": "coordinator_team_invite",
                    "coordinator_url": str(data.get("coordinator_url") or "").strip(),
                    "group_id": group_id,
                    "policy": policy,
                    "token": str(invite.get("token") or ""),
                    "expires_at": expires_at,
                    "team_name": invite.get("team_name_snapshot"),
                }
                encoded = encode_invite_payload(payload)
                _send_json(
                    self,
                    {
                        "ok": True,
                        "invite": {k: v for k, v in invite.items() if k != "token"},
                        "payload": payload,
                        "encoded": encoded,
                        "link": invite_link(encoded),
                    },
                )
                return
            if path in {"/v1/admin/join-requests/approve", "/v1/admin/join-requests/deny"}:
                request_id = str(data.get("request_id") or "").strip()
                reviewed_by = str(data.get("reviewed_by") or "").strip() or None
                if not request_id:
                    _send_json(self, {"error": "request_id_required"}, status=400)
                    return
                store = self._store()
                try:
                    request = store.review_join_request(
                        request_id=request_id,
                        approved=path.endswith("/approve"),
                        reviewed_by=reviewed_by,
                    )
                finally:
                    store.close()
                if request is None:
                    _send_json(self, {"error": "request_not_found"}, status=404)
                    return
                if request.get("_no_transition"):
                    _send_json(
                        self,
                        {
                            "error": "request_not_pending",
                            "status": request.get("status"),
                        },
                        status=409,
                    )
                    return
                _send_json(self, {"ok": True, "request": request})
                return
            if not group_id or not device_id:
                _send_json(self, {"error": "group_id_and_device_id_required"}, status=400)
                return
            store = self._store()
            try:
                if path == "/v1/admin/devices/rename":
                    display_name = str(data.get("display_name") or "").strip()
                    if not display_name:
                        _send_json(self, {"error": "display_name_required"}, status=400)
                        return
                    ok = store.rename_device(
                        group_id=group_id, device_id=device_id, display_name=display_name
                    )
                elif path == "/v1/admin/devices/disable":
                    ok = store.set_device_enabled(
                        group_id=group_id, device_id=device_id, enabled=False
                    )
                elif path == "/v1/admin/devices/remove":
                    ok = store.remove_device(group_id=group_id, device_id=device_id)
                else:
                    _send_json(self, {"error": "not_found"}, status=404)
                    return
            finally:
                store.close()
            if not ok:
                _send_json(self, {"error": "device_not_found"}, status=404)
                return
            _send_json(self, {"ok": True})

        def _handle_join(self) -> None:
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
            token = str(data.get("token") or "").strip()
            device_id = str(data.get("device_id") or "").strip()
            fingerprint = str(data.get("fingerprint") or "").strip()
            public_key = str(data.get("public_key") or "").strip()
            display_name = str(data.get("display_name") or "").strip() or None
            if not token or not device_id or not fingerprint or not public_key:
                _send_json(
                    self, {"error": "token_device_id_fingerprint_public_key_required"}, status=400
                )
                return
            store = self._store()
            try:
                invite = store.get_invite_by_token(token=token)
                if invite is None:
                    _send_json(self, {"error": "invalid_token"}, status=404)
                    return
                if invite.get("revoked_at"):
                    _send_json(self, {"error": "revoked_token"}, status=400)
                    return
                expires_at = str(invite.get("expires_at") or "")
                if expires_at and dt.datetime.fromisoformat(
                    expires_at.replace("Z", "+00:00")
                ) <= dt.datetime.now(dt.UTC):
                    _send_json(self, {"error": "expired_token"}, status=400)
                    return
                existing = store.get_enrollment(
                    group_id=str(invite["group_id"]), device_id=device_id
                )
                if existing is not None:
                    _send_json(
                        self,
                        {
                            "ok": True,
                            "status": "already_enrolled",
                            "group_id": invite["group_id"],
                            "policy": invite["policy"],
                        },
                    )
                    return
                if invite["policy"] not in {"auto_admit", "approval_required"}:
                    _send_json(
                        self,
                        {"error": f"unknown invite policy: {invite['policy']}"},
                        status=400,
                    )
                    return
                if invite["policy"] == "approval_required":
                    request = store.create_join_request(
                        group_id=str(invite["group_id"]),
                        device_id=device_id,
                        public_key=public_key,
                        fingerprint=fingerprint,
                        display_name=display_name,
                        token=token,
                    )
                    _send_json(
                        self,
                        {
                            "ok": True,
                            "status": "pending",
                            "group_id": invite["group_id"],
                            "policy": invite["policy"],
                            "request_id": request.get("request_id"),
                        },
                    )
                    return
                store.enroll_device(
                    str(invite["group_id"]),
                    device_id=device_id,
                    fingerprint=fingerprint,
                    public_key=public_key,
                    display_name=display_name,
                )
                _send_json(
                    self,
                    {
                        "ok": True,
                        "status": "enrolled",
                        "group_id": invite["group_id"],
                        "policy": invite["policy"],
                    },
                )
            finally:
                store.close()

    return CoordinatorHandler
