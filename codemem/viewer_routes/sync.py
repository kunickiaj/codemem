from __future__ import annotations

import datetime as dt
import os
import re
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs

from ..net import pick_advertise_host, pick_advertise_hosts
from ..store import MemoryStore
from ..sync.discovery import load_peer_addresses, normalize_address
from ..sync.sync_pass import sync_once
from ..sync_identity import ensure_device_identity, load_public_key
from ..sync_runtime import SyncRuntimeStatus, effective_status

PAIRING_FILTER_HINT = (
    "Run this on another device with codemem sync pair --accept '<payload>'. "
    "On that accepting device, --include/--exclude only control what it sends to peers. "
    "This device does not yet enforce incoming project filters."
)

SYNC_STALE_AFTER_SECONDS = 10 * 60


def _is_recent_iso(value: Any, *, window_s: int = SYNC_STALE_AFTER_SECONDS) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    normalized = raw.replace("Z", "+00:00")
    try:
        ts = dt.datetime.fromisoformat(normalized)
    except ValueError:
        return False
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=dt.UTC)
    age_s = (dt.datetime.now(dt.UTC) - ts).total_seconds()
    return 0 <= age_s <= window_s


def _attempt_status(attempt: dict[str, Any]) -> str:
    if attempt.get("ok"):
        return "ok"
    if attempt.get("error"):
        return "error"
    return "unknown"


def _attempt_address(attempt: dict[str, Any]) -> str | None:
    raw = str(attempt.get("address") or "")
    if raw:
        return raw
    error = str(attempt.get("error") or "")
    if not error:
        return None
    match = re.search(r"(https?://\S+?)(?::\s|$)", error)
    return match.group(1) if match else None


def _peer_status(peer: dict[str, Any]) -> dict[str, Any]:
    last_sync_at = peer.get("last_sync_at")
    last_ping_at = peer.get("last_seen_at")
    has_error = bool(peer.get("has_error"))

    sync_fresh = _is_recent_iso(last_sync_at)
    ping_fresh = _is_recent_iso(last_ping_at)

    if has_error and not (sync_fresh or ping_fresh):
        peer_state = "offline"
    elif has_error:
        peer_state = "degraded"
    elif sync_fresh or ping_fresh:
        peer_state = "online"
    elif last_sync_at or last_ping_at:
        peer_state = "stale"
    else:
        peer_state = "unknown"

    sync_status = (
        "error" if has_error else ("ok" if sync_fresh else ("stale" if last_sync_at else "unknown"))
    )
    ping_status = "ok" if ping_fresh else ("stale" if last_ping_at else "unknown")
    return {
        "sync_status": sync_status,
        "ping_status": ping_status,
        "peer_state": peer_state,
        "fresh": bool(sync_fresh or ping_fresh),
        "last_sync_at": last_sync_at,
        "last_ping_at": last_ping_at,
    }


def _find_peer_device_id_for_address(store: MemoryStore, address: str) -> str | None:
    needle = normalize_address(address)
    if not needle:
        return None
    rows = store.conn.execute("SELECT peer_device_id FROM sync_peers").fetchall()
    for row in rows:
        peer_id = str(row["peer_device_id"])
        for candidate in load_peer_addresses(store.conn, peer_id):
            if normalize_address(candidate) == needle:
                return peer_id
    return None


class _ViewerHandler(Protocol):
    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None: ...


def handle_get(handler: _ViewerHandler, store: MemoryStore, path: str, query: str) -> bool:
    if path == "/api/sync/status":
        from .. import viewer as _viewer

        params = parse_qs(query)
        include_diagnostics = params.get("includeDiagnostics", ["0"])[0] in {
            "1",
            "true",
            "yes",
        }
        config = _viewer.load_config()
        device_row = store.conn.execute(
            "SELECT device_id, fingerprint FROM sync_device LIMIT 1"
        ).fetchone()
        daemon_state = store.get_sync_daemon_state() or {}
        peer_count = store.conn.execute("SELECT COUNT(1) AS total FROM sync_peers").fetchone()
        last_sync = store.conn.execute(
            "SELECT MAX(last_sync_at) AS last_sync_at FROM sync_peers"
        ).fetchone()
        last_error = daemon_state.get("last_error")
        last_error_at = daemon_state.get("last_error_at")
        last_ok_at = daemon_state.get("last_ok_at")
        try:
            runtime_status = effective_status(str(config.sync_host), int(config.sync_port))
        except OSError as exc:
            runtime_status = SyncRuntimeStatus(
                running=False,
                mechanism="probe_error",
                detail=f"status probe unavailable: {exc.__class__.__name__}",
            )
        daemon_state_value = "ok"
        if not config.sync_enabled:
            daemon_state_value = "disabled"
        elif last_error and (not last_ok_at or str(last_ok_at) < str(last_error_at or "")):
            daemon_state_value = "error"
        elif not runtime_status.running:
            daemon_state_value = "stopped"

        include = getattr(config, "sync_projects_include", []) or []
        exclude = getattr(config, "sync_projects_exclude", []) or []
        project_filter_active = bool([p for p in include if p] or [p for p in exclude if p])
        status_payload: dict[str, Any] = {
            "enabled": config.sync_enabled,
            "interval_s": config.sync_interval_s,
            "peer_count": int(peer_count["total"]) if peer_count else 0,
            "last_sync_at": last_sync["last_sync_at"] if last_sync else None,
            "daemon_state": daemon_state_value,
            "daemon_running": bool(runtime_status.running),
            "daemon_detail": runtime_status.detail,
            "project_filter_active": project_filter_active,
            "project_filter": {"include": include, "exclude": exclude},
            "redacted": not include_diagnostics,
        }

        if include_diagnostics:
            status_payload.update(
                {
                    "device_id": device_row["device_id"] if device_row else None,
                    "fingerprint": device_row["fingerprint"] if device_row else None,
                    "bind": f"{config.sync_host}:{config.sync_port}",
                    "daemon_last_error": last_error,
                    "daemon_last_error_at": last_error_at,
                    "daemon_last_ok_at": last_ok_at,
                }
            )

        # Compatibility: older UI expects status/peers/attempts keys.
        peers_rows = store.conn.execute(
            """
            SELECT peer_device_id, name, pinned_fingerprint, addresses_json,
                   last_seen_at, last_sync_at, last_error
            FROM sync_peers
            ORDER BY name, peer_device_id
            """
        ).fetchall()
        peers_items: list[dict[str, Any]] = []
        for row in peers_rows:
            addresses = (
                load_peer_addresses(store.conn, row["peer_device_id"])
                if include_diagnostics
                else []
            )
            peer_item: dict[str, Any] = {
                "peer_device_id": row["peer_device_id"],
                "name": row["name"],
                "fingerprint": row["pinned_fingerprint"] if include_diagnostics else None,
                "pinned": bool(row["pinned_fingerprint"]),
                "addresses": addresses,
                "last_seen_at": row["last_seen_at"],
                "last_sync_at": row["last_sync_at"],
                "last_error": row["last_error"] if include_diagnostics else None,
                "has_error": bool(row["last_error"]),
            }
            peer_item["status"] = _peer_status(peer_item)
            peers_items.append(peer_item)

        peers_map = {peer["peer_device_id"]: peer["status"] for peer in peers_items}
        attempts_rows = store.conn.execute(
            """
            SELECT peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out
            FROM sync_attempts
            ORDER BY finished_at DESC
            LIMIT ?
            """,
            (25,),
        ).fetchall()
        attempts_items: list[dict[str, Any]] = []
        for row in attempts_rows:
            item = dict(row)
            item["status"] = _attempt_status(item)
            item["address"] = _attempt_address(item)
            attempts_items.append(item)

        if daemon_state_value == "ok":
            peer_states = {
                str((peer.get("status") or {}).get("peer_state") or "") for peer in peers_items
            }
            latest_failed_recently = bool(
                attempts_items
                and attempts_items[0].get("status") == "error"
                and _is_recent_iso(attempts_items[0].get("finished_at"))
            )
            if latest_failed_recently:
                has_live_peer = bool(peer_states & {"online", "degraded"})
                daemon_state_value = "degraded" if has_live_peer else "error"
            elif "degraded" in peer_states:
                daemon_state_value = "degraded"
            elif peers_items and "online" not in peer_states:
                daemon_state_value = "stale"
        status_payload["daemon_state"] = daemon_state_value

        status_block: dict[str, Any] = {
            **status_payload,
            "peers": peers_map,
            "pending": 0,
            "sync": {},
            "ping": {},
        }

        handler._send_json(
            {
                **status_payload,
                "status": status_block,
                "peers": peers_items,
                "attempts": attempts_items,
            }
        )
        return True

    if path == "/api/sync/peers":
        params = parse_qs(query)
        include_diagnostics = params.get("includeDiagnostics", ["0"])[0] in {
            "1",
            "true",
            "yes",
        }
        rows = store.conn.execute(
            """
            SELECT peer_device_id, name, pinned_fingerprint, addresses_json,
                   last_seen_at, last_sync_at, last_error
            FROM sync_peers
            ORDER BY name, peer_device_id
            """
        ).fetchall()
        peers = []
        for row in rows:
            addresses = (
                load_peer_addresses(store.conn, row["peer_device_id"])
                if include_diagnostics
                else []
            )
            peers.append(
                {
                    "peer_device_id": row["peer_device_id"],
                    "name": row["name"],
                    "fingerprint": row["pinned_fingerprint"] if include_diagnostics else None,
                    "pinned": bool(row["pinned_fingerprint"]),
                    "addresses": addresses,
                    "last_seen_at": row["last_seen_at"],
                    "last_sync_at": row["last_sync_at"],
                    "last_error": row["last_error"] if include_diagnostics else None,
                    "has_error": bool(row["last_error"]),
                }
            )
        handler._send_json({"items": peers, "redacted": not include_diagnostics})
        return True

    if path == "/api/sync/attempts":
        params = parse_qs(query)
        limit_value = params.get("limit", ["25"])[0]
        try:
            limit = int(limit_value)
        except (TypeError, ValueError):
            handler._send_json({"error": "invalid_limit"}, status=400)
            return True
        if limit <= 0:
            handler._send_json({"error": "invalid_limit"}, status=400)
            return True
        limit = min(limit, 500)
        rows = store.conn.execute(
            """
            SELECT peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out
            FROM sync_attempts
            ORDER BY finished_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        handler._send_json({"items": [dict(row) for row in rows]})
        return True

    if path == "/api/sync/pairing":
        from .. import viewer as _viewer

        params = parse_qs(query)
        include_diagnostics = params.get("includeDiagnostics", ["0"])[0] in {
            "1",
            "true",
            "yes",
        }
        config = _viewer.load_config()
        if not include_diagnostics:
            handler._send_json({"redacted": True, "pairing_filter_hint": PAIRING_FILTER_HINT})
            return True
        keys_dir_value = os.environ.get("CODEMEM_KEYS_DIR")
        keys_dir = Path(keys_dir_value).expanduser() if keys_dir_value else None
        device_row = store.conn.execute(
            "SELECT device_id, public_key, fingerprint FROM sync_device LIMIT 1"
        ).fetchone()
        if device_row:
            device_id = device_row["device_id"]
            public_key = device_row["public_key"]
            fingerprint = device_row["fingerprint"]
        else:
            device_id, fingerprint = ensure_device_identity(store.conn, keys_dir=keys_dir)
            public_key = load_public_key(keys_dir)
        if not public_key or not device_id or not fingerprint:
            handler._send_json({"error": "public key missing"}, status=500)
            return True
        payload = {
            "device_id": device_id,
            "fingerprint": fingerprint,
            "public_key": public_key,
            "pairing_filter_hint": PAIRING_FILTER_HINT,
            "addresses": [
                f"{host}:{config.sync_port}"
                for host in pick_advertise_hosts(config.sync_advertise)
                if host and host != "0.0.0.0"
            ]
            or [
                f"{pick_advertise_host(config.sync_advertise) or config.sync_host}:{config.sync_port}"
            ],
        }
        handler._send_json(payload)
        return True

    return False


def handle_post(
    handler: _ViewerHandler,
    store: MemoryStore,
    path: str,
    payload: dict[str, Any] | None,
) -> bool:
    if path == "/api/sync/run":
        # Compatibility endpoint for the bundled web UI.
        path = "/api/sync/actions/sync-now"

    if path == "/api/sync/peers/rename":
        if payload is None:
            handler._send_json({"error": "invalid json"}, status=400)
            return True
        peer_device_id = payload.get("peer_device_id")
        name = payload.get("name")
        if not isinstance(peer_device_id, str) or not peer_device_id:
            handler._send_json({"error": "peer_device_id required"}, status=400)
            return True
        if not isinstance(name, str) or not name.strip():
            handler._send_json({"error": "name required"}, status=400)
            return True
        row = store.conn.execute(
            "SELECT 1 FROM sync_peers WHERE peer_device_id = ?",
            (peer_device_id,),
        ).fetchone()
        if row is None:
            handler._send_json({"error": "peer not found"}, status=404)
            return True
        store.conn.execute(
            "UPDATE sync_peers SET name = ? WHERE peer_device_id = ?",
            (name.strip(), peer_device_id),
        )
        store.conn.commit()
        handler._send_json({"ok": True})
        return True

    if path == "/api/sync/actions/sync-now":
        from .. import viewer as _viewer

        payload = payload or {}
        peer_device_id = payload.get("peer_device_id")
        address = payload.get("address")
        config = _viewer.load_config()
        if not config.sync_enabled:
            handler._send_json({"error": "sync_disabled"}, status=403)
            return True

        if isinstance(address, str) and address.strip():
            resolved_peer_id = _find_peer_device_id_for_address(store, address.strip())
            if not resolved_peer_id:
                handler._send_json({"error": "unknown peer address"}, status=404)
                return True
            result = sync_once(store, resolved_peer_id, [address.strip()])
            handler._send_json({"items": [result]})
            return True
        if isinstance(peer_device_id, str) and peer_device_id:
            rows = store.conn.execute(
                "SELECT peer_device_id FROM sync_peers WHERE peer_device_id = ?",
                (peer_device_id,),
            ).fetchall()
        else:
            rows = store.conn.execute("SELECT peer_device_id FROM sync_peers").fetchall()
        results = []
        for row in rows:
            peer_id = row["peer_device_id"]
            addresses = load_peer_addresses(store.conn, peer_id)
            results.append(sync_once(store, peer_id, addresses))
        handler._send_json({"items": results})
        return True

    return False


def handle_delete(handler: _ViewerHandler, store: MemoryStore, path: str) -> bool:
    if not path.startswith("/api/sync/peers/"):
        return False
    peer_device_id = path.split("/api/sync/peers/", 1)[1].strip()
    if not peer_device_id:
        handler._send_json({"error": "peer_device_id required"}, status=400)
        return True
    row = store.conn.execute(
        "SELECT 1 FROM sync_peers WHERE peer_device_id = ?",
        (peer_device_id,),
    ).fetchone()
    if row is None:
        handler._send_json({"error": "peer not found"}, status=404)
        return True
    store.conn.execute(
        "DELETE FROM sync_peers WHERE peer_device_id = ?",
        (peer_device_id,),
    )
    store.conn.commit()
    handler._send_json({"ok": True})
    return True
