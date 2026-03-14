from __future__ import annotations

import datetime as dt
import os
import re
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs

from ..commands.sync_coordinator_cmds import (
    coordinator_create_invite_action,
    coordinator_import_invite_action,
    coordinator_list_join_requests_action,
    coordinator_review_join_request_action,
)
from ..net import pick_advertise_host, pick_advertise_hosts
from ..store import MemoryStore
from ..sync import coordinator
from ..sync.discovery import (
    load_peer_addresses,
    normalize_address,
    set_peer_project_filter,
)
from ..sync.sync_pass import sync_once
from ..sync_identity import ensure_device_identity, load_public_key
from ..sync_runtime import SyncRuntimeStatus, effective_status

PAIRING_FILTER_HINT = (
    "Run this on another device with codemem sync pair --accept '<payload>'. "
    "On that accepting device, --include/--exclude only control what it sends to peers. "
    "This device does not yet enforce incoming project filters."
)

SYNC_STALE_AFTER_SECONDS = 10 * 60


def _coordinator_remote_target(config: Any) -> tuple[str | None, str | None]:
    remote_url = str(getattr(config, "sync_coordinator_url", "") or "").strip() or None
    admin_secret = str(getattr(config, "sync_coordinator_admin_secret", "") or "").strip() or None
    if not remote_url:
        return None, None
    return remote_url, admin_secret


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


def _all_peers_in_state(peers_items: list[dict[str, Any]], expected_state: str) -> bool:
    if not peers_items:
        return False
    peer_states = [str((peer.get("status") or {}).get("peer_state") or "") for peer in peers_items]
    return bool(peer_states) and all(state == expected_state for state in peer_states)


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
        project = str(params.get("project", [""])[0] or "").strip() or None
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
            SELECT p.peer_device_id, p.name, p.pinned_fingerprint, p.addresses_json,
                   p.last_seen_at, p.last_sync_at, p.last_error,
                   p.projects_include_json, p.projects_exclude_json, p.claimed_local_actor,
                   p.actor_id, a.display_name AS actor_display_name
            FROM sync_peers AS p
            LEFT JOIN actors AS a ON a.actor_id = p.actor_id
            ORDER BY name, peer_device_id
            """
        ).fetchall()
        peers_items: list[dict[str, Any]] = []
        for row in peers_rows:
            override_include_raw = row["projects_include_json"]
            override_exclude_raw = row["projects_exclude_json"]
            override_include = store._safe_json_list(override_include_raw)
            override_exclude = store._safe_json_list(override_exclude_raw)
            inherits_global = override_include_raw is None and override_exclude_raw is None
            effective_include, effective_exclude = store._effective_sync_project_filters(
                peer_device_id=str(row["peer_device_id"])
            )
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
                "claimed_local_actor": bool(row["claimed_local_actor"]),
                "actor_id": row["actor_id"],
                "actor_display_name": row["actor_display_name"],
                "project_scope": {
                    "include": override_include,
                    "exclude": override_exclude,
                    "effective_include": effective_include,
                    "effective_exclude": effective_exclude,
                    "inherits_global": inherits_global,
                },
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
        legacy_devices = store.claimable_legacy_device_ids()
        sharing_review = store.sharing_review_summary(project=project)
        coordinator_status = coordinator.status_snapshot(store, config=config)
        join_requests: list[dict[str, Any]] = []
        coordinator_group = str(getattr(config, "sync_coordinator_group", "") or "").strip()
        coordinator_url, coordinator_admin_secret = _coordinator_remote_target(config)
        if coordinator_group:
            try:
                join_requests = coordinator_list_join_requests_action(
                    group_id=coordinator_group,
                    db_path=None,
                    remote_url=coordinator_url,
                    admin_secret=coordinator_admin_secret,
                )
            except SystemExit:
                join_requests = []
            except Exception:
                join_requests = []

        if daemon_state_value == "ok":
            peer_states = {
                str((peer.get("status") or {}).get("peer_state") or "") for peer in peers_items
            }
            latest_failed_recently = bool(
                attempts_items
                and attempts_items[0].get("status") == "error"
                and _is_recent_iso(attempts_items[0].get("finished_at"))
            )
            all_offline = _all_peers_in_state(peers_items, "offline")
            if latest_failed_recently:
                has_live_peer = bool(peer_states & {"online", "degraded"})
                if has_live_peer:
                    daemon_state_value = "degraded"
                elif all_offline:
                    daemon_state_value = "offline-peers"
                elif peers_items:
                    daemon_state_value = "stale"
            elif "degraded" in peer_states:
                daemon_state_value = "degraded"
            elif all_offline:
                daemon_state_value = "offline-peers"
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
                "attempts": attempts_items[:5],
                "legacy_devices": legacy_devices,
                "sharing_review": sharing_review,
                "coordinator": coordinator_status,
                "join_requests": join_requests,
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
            SELECT p.peer_device_id, p.name, p.pinned_fingerprint, p.addresses_json,
                   p.last_seen_at, p.last_sync_at, p.last_error,
                   p.projects_include_json, p.projects_exclude_json, p.claimed_local_actor,
                   p.actor_id, a.display_name AS actor_display_name
            FROM sync_peers AS p
            LEFT JOIN actors AS a ON a.actor_id = p.actor_id
            ORDER BY name, peer_device_id
            """
        ).fetchall()
        peers = []
        for row in rows:
            override_include_raw = row["projects_include_json"]
            override_exclude_raw = row["projects_exclude_json"]
            override_include = store._safe_json_list(override_include_raw)
            override_exclude = store._safe_json_list(override_exclude_raw)
            effective_include, effective_exclude = store._effective_sync_project_filters(
                peer_device_id=str(row["peer_device_id"])
            )
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
                    "claimed_local_actor": bool(row["claimed_local_actor"]),
                    "actor_id": row["actor_id"],
                    "actor_display_name": row["actor_display_name"],
                    "project_scope": {
                        "include": override_include,
                        "exclude": override_exclude,
                        "effective_include": effective_include,
                        "effective_exclude": effective_exclude,
                        "inherits_global": override_include_raw is None
                        and override_exclude_raw is None,
                    },
                }
            )
        handler._send_json({"items": peers, "redacted": not include_diagnostics})
        return True

    if path == "/api/sync/actors":
        params = parse_qs(query)
        include_merged = params.get("includeMerged", ["0"])[0] in {"1", "true", "yes"}
        handler._send_json({"items": store.list_actors(include_merged=include_merged)})
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

    if path == "/api/sync/actors":
        if payload is None:
            handler._send_json({"error": "invalid json"}, status=400)
            return True
        display_name = payload.get("display_name")
        actor_id = payload.get("actor_id")
        if not isinstance(display_name, str) or not display_name.strip():
            handler._send_json({"error": "display_name required"}, status=400)
            return True
        if actor_id is not None and not isinstance(actor_id, str):
            handler._send_json({"error": "actor_id must be string or null"}, status=400)
            return True
        try:
            actor = store.create_actor(display_name=display_name, actor_id=actor_id)
        except ValueError as exc:
            handler._send_json({"error": str(exc)}, status=400)
            return True
        handler._send_json(actor, status=201)
        return True

    if path == "/api/sync/actors/rename":
        if payload is None:
            handler._send_json({"error": "invalid json"}, status=400)
            return True
        actor_id = payload.get("actor_id")
        display_name = payload.get("display_name")
        if not isinstance(actor_id, str) or not actor_id.strip():
            handler._send_json({"error": "actor_id required"}, status=400)
            return True
        if not isinstance(display_name, str) or not display_name.strip():
            handler._send_json({"error": "display_name required"}, status=400)
            return True
        try:
            actor = store.rename_actor(actor_id.strip(), display_name=display_name)
        except ValueError as exc:
            handler._send_json({"error": str(exc)}, status=400)
            return True
        except LookupError:
            handler._send_json({"error": "actor not found"}, status=404)
            return True
        handler._send_json(actor)
        return True

    if path == "/api/sync/actors/merge":
        if payload is None:
            handler._send_json({"error": "invalid json"}, status=400)
            return True
        primary_actor_id = payload.get("primary_actor_id")
        secondary_actor_id = payload.get("secondary_actor_id")
        if not isinstance(primary_actor_id, str) or not primary_actor_id.strip():
            handler._send_json({"error": "primary_actor_id required"}, status=400)
            return True
        if not isinstance(secondary_actor_id, str) or not secondary_actor_id.strip():
            handler._send_json({"error": "secondary_actor_id required"}, status=400)
            return True
        try:
            result = store.merge_actor(
                primary_actor_id=primary_actor_id,
                secondary_actor_id=secondary_actor_id,
            )
        except ValueError as exc:
            handler._send_json({"error": str(exc)}, status=400)
            return True
        except LookupError as exc:
            handler._send_json({"error": str(exc)}, status=404)
            return True
        handler._send_json(result)
        return True

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

    if path == "/api/sync/peers/scope":
        if payload is None:
            handler._send_json({"error": "invalid json"}, status=400)
            return True
        peer_device_id = payload.get("peer_device_id")
        if not isinstance(peer_device_id, str) or not peer_device_id.strip():
            handler._send_json({"error": "peer_device_id required"}, status=400)
            return True
        row = store.conn.execute(
            "SELECT 1 FROM sync_peers WHERE peer_device_id = ?",
            (peer_device_id.strip(),),
        ).fetchone()
        if row is None:
            handler._send_json({"error": "peer not found"}, status=404)
            return True
        inherit_global = bool(payload.get("inherit_global"))

        def _parse_scope_list(value: Any, *, field: str) -> list[str] | None:
            if value is None:
                return []
            if not isinstance(value, list):
                raise ValueError(field)
            items: list[str] = []
            for item in value:
                if not isinstance(item, str):
                    raise ValueError(field)
                cleaned = item.strip()
                if cleaned:
                    items.append(cleaned)
            return items

        try:
            include = (
                None
                if inherit_global
                else _parse_scope_list(payload.get("include"), field="include")
            )
            exclude = (
                None
                if inherit_global
                else _parse_scope_list(payload.get("exclude"), field="exclude")
            )
        except ValueError as exc:
            handler._send_json({"error": f"invalid {exc.args[0]}"}, status=400)
            return True

        set_peer_project_filter(
            store.conn,
            peer_device_id.strip(),
            include=include,
            exclude=exclude,
        )
        effective_include, effective_exclude = store._effective_sync_project_filters(
            peer_device_id=peer_device_id.strip()
        )
        handler._send_json(
            {
                "ok": True,
                "project_scope": {
                    "include": [] if include is None else include,
                    "exclude": [] if exclude is None else exclude,
                    "effective_include": effective_include,
                    "effective_exclude": effective_exclude,
                    "inherits_global": inherit_global,
                },
            }
        )
        return True

    if path == "/api/sync/peers/identity":
        if payload is None:
            handler._send_json({"error": "invalid json"}, status=400)
            return True
        peer_device_id = payload.get("peer_device_id")
        if not isinstance(peer_device_id, str) or not peer_device_id.strip():
            handler._send_json({"error": "peer_device_id required"}, status=400)
            return True
        row = store.conn.execute(
            "SELECT 1 FROM sync_peers WHERE peer_device_id = ?",
            (peer_device_id.strip(),),
        ).fetchone()
        if row is None:
            handler._send_json({"error": "peer not found"}, status=404)
            return True
        raw_actor_id = payload.get("actor_id") if "actor_id" in payload else None
        if "actor_id" in payload and raw_actor_id is not None and not isinstance(raw_actor_id, str):
            handler._send_json({"error": "actor_id must be string or null"}, status=400)
            return True
        if "actor_id" in payload and "claimed_local_actor" in payload:
            handler._send_json(
                {"error": "provide actor_id or claimed_local_actor, not both"},
                status=400,
            )
            return True
        if (
            "actor_id" not in payload
            and "claimed_local_actor" in payload
            and not isinstance(payload.get("claimed_local_actor"), bool)
        ):
            handler._send_json({"error": "claimed_local_actor must be boolean"}, status=400)
            return True
        actor_id = raw_actor_id if "actor_id" in payload else None
        if "actor_id" not in payload:
            actor_id = store.actor_id if bool(payload.get("claimed_local_actor")) else None
        try:
            assignment = store.assign_peer_actor(peer_device_id.strip(), actor_id=actor_id)
        except LookupError as exc:
            status = 404 if str(exc) in {"peer not found", "actor not found"} else 400
            handler._send_json({"error": str(exc)}, status=status)
            return True
        except ValueError as exc:
            handler._send_json({"error": str(exc)}, status=400)
            return True
        handler._send_json({"ok": True, **assignment})
        return True

    if path == "/api/sync/legacy-devices/claim":
        if payload is None:
            handler._send_json({"error": "invalid json"}, status=400)
            return True
        origin_device_id = payload.get("origin_device_id")
        if not isinstance(origin_device_id, str) or not origin_device_id.strip():
            handler._send_json({"error": "origin_device_id required"}, status=400)
            return True
        updated = store.claim_legacy_device_id_as_self(origin_device_id.strip())
        if updated <= 0:
            handler._send_json({"error": "legacy device not found"}, status=404)
            return True
        handler._send_json(
            {
                "ok": True,
                "origin_device_id": origin_device_id.strip(),
                "updated": updated,
            }
        )
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

    if path == "/api/sync/invites/create":
        if payload is None:
            handler._send_json({"error": "invalid json"}, status=400)
            return True
        from .. import viewer as _viewer

        group_id = payload.get("group_id")
        coordinator_url = payload.get("coordinator_url")
        policy = payload.get("policy") or "auto_admit"
        ttl_hours = payload.get("ttl_hours") or 24
        if not isinstance(group_id, str) or not group_id.strip():
            handler._send_json({"error": "group_id required"}, status=400)
            return True
        if coordinator_url is not None and not isinstance(coordinator_url, str):
            handler._send_json({"error": "coordinator_url must be string"}, status=400)
            return True
        if not isinstance(policy, str) or policy not in {"auto_admit", "approval_required"}:
            handler._send_json(
                {"error": "policy must be auto_admit or approval_required"}, status=400
            )
            return True
        try:
            ttl = int(ttl_hours)
        except (TypeError, ValueError):
            handler._send_json({"error": "ttl_hours must be int"}, status=400)
            return True
        config = _viewer.load_config()
        remote_url, admin_secret = _coordinator_remote_target(config)
        try:
            result = coordinator_create_invite_action(
                group_id=group_id.strip(),
                coordinator_url=coordinator_url,
                policy=policy,
                ttl_hours=ttl,
                created_by=None,
                db_path=None,
                remote_url=remote_url,
                admin_secret=admin_secret,
            )
        except SystemExit as exc:
            handler._send_json({"error": str(exc)}, status=400)
            return True
        handler._send_json(result)
        return True

    if path == "/api/sync/invites/import":
        if payload is None:
            handler._send_json({"error": "invalid json"}, status=400)
            return True
        invite_value = payload.get("invite")
        if not isinstance(invite_value, str) or not invite_value.strip():
            handler._send_json({"error": "invite required"}, status=400)
            return True
        try:
            result = coordinator_import_invite_action(
                invite_value=invite_value,
                db_path=None,
                keys_dir=None,
                config_path=None,
            )
        except SystemExit as exc:
            handler._send_json({"error": str(exc)}, status=400)
            return True
        handler._send_json(result)
        return True

    if path == "/api/sync/join-requests/review":
        if payload is None:
            handler._send_json({"error": "invalid json"}, status=400)
            return True
        from .. import viewer as _viewer

        request_id = payload.get("request_id")
        action = payload.get("action")
        if not isinstance(request_id, str) or not request_id.strip():
            handler._send_json({"error": "request_id required"}, status=400)
            return True
        if action not in {"approve", "deny"}:
            handler._send_json({"error": "action must be approve or deny"}, status=400)
            return True
        config = _viewer.load_config()
        remote_url, admin_secret = _coordinator_remote_target(config)
        try:
            result = coordinator_review_join_request_action(
                request_id=request_id.strip(),
                approve=action == "approve",
                reviewed_by=None,
                db_path=None,
                remote_url=remote_url,
                admin_secret=admin_secret,
            )
        except SystemExit as exc:
            status = 404 if "request_not_found" in str(exc) else 400
            handler._send_json({"error": str(exc)}, status=status)
            return True
        if result is None:
            handler._send_json({"error": "join request not found"}, status=404)
            return True
        handler._send_json({"ok": True, "request": result})
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
