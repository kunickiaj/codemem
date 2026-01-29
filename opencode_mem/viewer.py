from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import threading
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import viewer_raw_events
from .config import (
    OpencodeMemConfig,
    get_config_path,
    get_env_overrides,
    load_config,
    read_config_file,
    write_config_file,
)
from .db import DEFAULT_DB_PATH, from_json
from .net import pick_advertise_host, pick_advertise_hosts
from .observer import _load_opencode_config
from .raw_event_flush import flush_raw_events  # noqa: F401
from .store import MemoryStore
from .sync_daemon import sync_once
from .sync_discovery import load_peer_addresses
from .sync_identity import ensure_device_identity, load_public_key
from .viewer_html import VIEWER_HTML
from .viewer_http import (
    read_json_body,
    reject_cross_origin,
    send_html_response,
    send_json_response,
)

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
            if parsed.path == "/api/stats":
                self._send_json(store.stats())
                return
            if parsed.path == "/api/usage":
                params = parse_qs(parsed.query)
                project_filter = params.get("project", [None])[0]
                events_global = store.usage_summary()
                totals_global = store.usage_totals()
                events_filtered = None
                totals_filtered = None
                if project_filter:
                    events_filtered = store.usage_summary(project_filter)
                    totals_filtered = store.usage_totals(project_filter)
                recent_packs = store.recent_pack_events(limit=10, project=project_filter)
                self._send_json(
                    {
                        "project": project_filter,
                        "events": events_filtered if project_filter else events_global,
                        "totals": totals_filtered if project_filter else totals_global,
                        "events_global": events_global,
                        "totals_global": totals_global,
                        "events_filtered": events_filtered,
                        "totals_filtered": totals_filtered,
                        "recent_packs": recent_packs,
                    }
                )
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
            if parsed.path == "/api/sessions":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["20"])[0])
                sessions = store.all_sessions()[:limit]
                for item in sessions:
                    item["metadata_json"] = from_json(item.get("metadata_json"))
                self._send_json({"items": sessions})
                return
            if parsed.path == "/api/projects":
                sessions = store.all_sessions()
                projects = sorted(
                    {
                        store._project_basename(p.strip())
                        for s in sessions
                        if (p := s.get("project"))
                        and isinstance(p, str)
                        and p.strip()
                        and not p.strip().lower().startswith("fatal:")
                        and store._project_basename(p.strip())
                    }
                )
                self._send_json({"projects": projects})
                return
            if parsed.path == "/api/observations":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["20"])[0])
                project = params.get("project", [None])[0]
                kinds = [
                    "bugfix",
                    "change",
                    "decision",
                    "discovery",
                    "exploration",
                    "feature",
                    "refactor",
                ]
                filters = {"project": project} if project else None
                items = store.recent_by_kinds(limit=limit, kinds=kinds, filters=filters)
                self._send_json({"items": items})
                return
            if parsed.path == "/api/pack":
                params = parse_qs(parsed.query)
                context = params.get("context", [""])[0]
                if not context:
                    self._send_json({"error": "context required"}, status=400)
                    return
                config = load_config()
                try:
                    limit = int(params.get("limit", [str(config.pack_observation_limit)])[0])
                except ValueError:
                    self._send_json({"error": "limit must be int"}, status=400)
                    return
                token_budget = params.get("token_budget", [None])[0]
                if token_budget in (None, ""):
                    token_budget_value = None
                else:
                    try:
                        token_budget_value = int(token_budget)
                    except ValueError:
                        self._send_json({"error": "token_budget must be int"}, status=400)
                        return
                project = params.get("project", [None])[0]
                filters = {"project": project} if project else None
                pack = store.build_memory_pack(
                    context=context,
                    limit=limit,
                    token_budget=token_budget_value,
                    filters=filters,
                )
                self._send_json(pack)
                return
            if parsed.path == "/api/memory":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["20"])[0])
                kind = params.get("kind", [None])[0]
                project = params.get("project", [None])[0]
                filters = {}
                if kind:
                    filters["kind"] = kind
                if project:
                    filters["project"] = project
                items = store.recent(limit=limit, filters=filters if filters else None)
                self._send_json({"items": items})
                return
            if parsed.path == "/api/artifacts":
                params = parse_qs(parsed.query)
                session_id = params.get("session_id", [None])[0]
                if not session_id:
                    self._send_json({"error": "session_id required"}, status=400)
                    return
                items = store.session_artifacts(int(session_id))
                self._send_json({"items": items})
                return
            if parsed.path == "/api/config":
                config_path = get_config_path()
                try:
                    config_data = read_config_file(config_path)
                except ValueError as exc:
                    self._send_json({"error": str(exc), "path": str(config_path)}, status=500)
                    return
                effective = asdict(load_config(config_path))
                self._send_json(
                    {
                        "path": str(config_path),
                        "config": config_data,
                        "defaults": asdict(OpencodeMemConfig()),
                        "effective": effective,
                        "env_overrides": get_env_overrides(),
                        "providers": _load_provider_options(),
                    }
                )
                return
            if parsed.path == "/api/sync/status":
                params = parse_qs(parsed.query)
                include_diagnostics = params.get("includeDiagnostics", ["0"])[0] in {
                    "1",
                    "true",
                    "yes",
                }
                config = load_config()
                device_row = store.conn.execute(
                    "SELECT device_id, fingerprint FROM sync_device LIMIT 1"
                ).fetchone()
                daemon_state = store.get_sync_daemon_state() or {}
                peer_count = store.conn.execute(
                    "SELECT COUNT(1) AS total FROM sync_peers"
                ).fetchone()
                last_sync = store.conn.execute(
                    "SELECT MAX(last_sync_at) AS last_sync_at FROM sync_peers"
                ).fetchone()
                last_error = daemon_state.get("last_error")
                last_error_at = daemon_state.get("last_error_at")
                last_ok_at = daemon_state.get("last_ok_at")
                daemon_state_value = "ok"
                if last_error and (not last_ok_at or str(last_ok_at) < str(last_error_at or "")):
                    daemon_state_value = "error"

                include = getattr(config, "sync_projects_include", []) or []
                exclude = getattr(config, "sync_projects_exclude", []) or []
                project_filter_active = bool([p for p in include if p] or [p for p in exclude if p])
                payload: dict[str, Any] = {
                    "enabled": config.sync_enabled,
                    "interval_s": config.sync_interval_s,
                    "peer_count": int(peer_count["total"]) if peer_count else 0,
                    "last_sync_at": last_sync["last_sync_at"] if last_sync else None,
                    "daemon_state": daemon_state_value,
                    "project_filter_active": project_filter_active,
                    "project_filter": {"include": include, "exclude": exclude},
                    "redacted": not include_diagnostics,
                }

                if include_diagnostics:
                    payload.update(
                        {
                            "device_id": device_row["device_id"] if device_row else None,
                            "fingerprint": device_row["fingerprint"] if device_row else None,
                            "bind": f"{config.sync_host}:{config.sync_port}",
                            "daemon_last_error": last_error,
                            "daemon_last_error_at": last_error_at,
                            "daemon_last_ok_at": last_ok_at,
                        }
                    )
                self._send_json(payload)
                return
            if parsed.path == "/api/sync/peers":
                params = parse_qs(parsed.query)
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
                            "fingerprint": row["pinned_fingerprint"]
                            if include_diagnostics
                            else None,
                            "pinned": bool(row["pinned_fingerprint"]),
                            "addresses": addresses,
                            "last_seen_at": row["last_seen_at"],
                            "last_sync_at": row["last_sync_at"],
                            "last_error": row["last_error"] if include_diagnostics else None,
                            "has_error": bool(row["last_error"]),
                        }
                    )
                self._send_json({"items": peers, "redacted": not include_diagnostics})
                return
            if parsed.path == "/api/sync/attempts":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["25"])[0])
                rows = store.conn.execute(
                    """
                    SELECT peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out
                    FROM sync_attempts
                    ORDER BY finished_at DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
                self._send_json({"items": [dict(row) for row in rows]})
                return
            if parsed.path == "/api/sync/pairing":
                params = parse_qs(parsed.query)
                include_diagnostics = params.get("includeDiagnostics", ["0"])[0] in {
                    "1",
                    "true",
                    "yes",
                }
                config = load_config()
                if not include_diagnostics:
                    self._send_json({"redacted": True})
                    return
                keys_dir_value = os.environ.get("OPENCODE_MEM_KEYS_DIR")
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
                    self._send_json({"error": "public key missing"}, status=500)
                    return
                payload = {
                    "device_id": device_id,
                    "fingerprint": fingerprint,
                    "public_key": public_key,
                    "addresses": [
                        f"{host}:{config.sync_port}"
                        for host in pick_advertise_hosts(config.sync_advertise)
                        if host and host != "0.0.0.0"
                    ]
                    or [
                        f"{pick_advertise_host(config.sync_advertise) or config.sync_host}:{config.sync_port}"
                    ],
                }
                self._send_json(payload)
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
        if parsed.path == "/api/sync/peers/rename":
            payload = self._read_json()
            if payload is None:
                self._send_json({"error": "invalid json"}, status=400)
                return
            peer_device_id = payload.get("peer_device_id")
            name = payload.get("name")
            if not isinstance(peer_device_id, str) or not peer_device_id:
                self._send_json({"error": "peer_device_id required"}, status=400)
                return
            if not isinstance(name, str) or not name.strip():
                self._send_json({"error": "name required"}, status=400)
                return
            store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
            try:
                row = store.conn.execute(
                    "SELECT 1 FROM sync_peers WHERE peer_device_id = ?",
                    (peer_device_id,),
                ).fetchone()
                if row is None:
                    self._send_json({"error": "peer not found"}, status=404)
                    return
                store.conn.execute(
                    "UPDATE sync_peers SET name = ? WHERE peer_device_id = ?",
                    (name.strip(), peer_device_id),
                )
                store.conn.commit()
                self._send_json({"ok": True})
                return
            finally:
                store.close()
        if parsed.path == "/api/sync/actions/sync-now":
            payload = self._read_json() or {}
            peer_device_id = payload.get("peer_device_id")
            store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
            try:
                config = load_config()
                if not config.sync_enabled:
                    self._send_json({"error": "sync_disabled"}, status=403)
                    return
                rows = []
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
                self._send_json({"items": results})
                return
            finally:
                store.close()
        if parsed.path == "/api/raw-events":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length else ""
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                self._send_json({"error": "invalid json"}, status=400)
                return
            if not isinstance(payload, dict):
                self._send_json({"error": "payload must be an object"}, status=400)
                return

            try:
                store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
            except Exception as exc:  # pragma: no cover
                response: dict[str, Any] = {"error": "internal server error"}
                if os.environ.get("OPENCODE_MEM_VIEWER_DEBUG") == "1":
                    response["detail"] = str(exc)
                self._send_json(response, status=500)
                return
            try:
                cwd = payload.get("cwd")
                if cwd is not None and not isinstance(cwd, str):
                    self._send_json({"error": "cwd must be string"}, status=400)
                    return
                project = payload.get("project")
                if project is not None and not isinstance(project, str):
                    self._send_json({"error": "project must be string"}, status=400)
                    return
                started_at = payload.get("started_at")
                if started_at is not None and not isinstance(started_at, str):
                    self._send_json({"error": "started_at must be string"}, status=400)
                    return

                items = payload.get("events")
                if items is None:
                    items = [payload]
                if not isinstance(items, list):
                    self._send_json({"error": "events must be a list"}, status=400)
                    return

                default_session_id = str(payload.get("opencode_session_id") or "")
                if default_session_id.startswith("msg_"):
                    self._send_json({"error": "invalid opencode_session_id"}, status=400)
                    return

                inserted = 0
                last_seen_by_session: dict[str, int] = {}
                meta_by_session: dict[str, dict[str, str]] = {}
                session_ids: set[str] = set()
                batch: list[dict[str, Any]] = []
                batch_by_session: dict[str, list[dict[str, Any]]] = {}
                for item in items:
                    if not isinstance(item, dict):
                        self._send_json({"error": "event must be an object"}, status=400)
                        return
                    opencode_session_id = str(
                        item.get("opencode_session_id") or default_session_id or ""
                    )
                    if not opencode_session_id:
                        self._send_json({"error": "opencode_session_id required"}, status=400)
                        return
                    if opencode_session_id.startswith("msg_"):
                        self._send_json({"error": "invalid opencode_session_id"}, status=400)
                        return
                    event_id = str(item.get("event_id") or "")
                    event_type = str(item.get("event_type") or "")
                    if not event_type:
                        self._send_json({"error": "event_type required"}, status=400)
                        return
                    event_seq_value = item.get("event_seq")
                    if event_seq_value is not None:
                        try:
                            int(str(event_seq_value))
                        except (TypeError, ValueError):
                            self._send_json({"error": "event_seq must be int"}, status=400)
                            return

                    ts_wall_ms = item.get("ts_wall_ms")
                    if ts_wall_ms is not None:
                        try:
                            ts_wall_ms = int(ts_wall_ms)
                        except (TypeError, ValueError):
                            self._send_json({"error": "ts_wall_ms must be int"}, status=400)
                            return
                        last_seen_by_session[opencode_session_id] = max(
                            last_seen_by_session.get(opencode_session_id, ts_wall_ms),
                            ts_wall_ms,
                        )
                    ts_mono_ms = item.get("ts_mono_ms")
                    if ts_mono_ms is not None:
                        try:
                            ts_mono_ms = float(ts_mono_ms)
                        except (TypeError, ValueError):
                            self._send_json({"error": "ts_mono_ms must be number"}, status=400)
                            return
                    event_payload = item.get("payload")
                    if event_payload is None:
                        event_payload = {}
                    if not isinstance(event_payload, dict):
                        self._send_json({"error": "payload must be an object"}, status=400)
                        return

                    item_cwd = item.get("cwd")
                    if item_cwd is not None and not isinstance(item_cwd, str):
                        self._send_json({"error": "cwd must be string"}, status=400)
                        return
                    item_project = item.get("project")
                    if item_project is not None and not isinstance(item_project, str):
                        self._send_json({"error": "project must be string"}, status=400)
                        return
                    item_started_at = item.get("started_at")
                    if item_started_at is not None and not isinstance(item_started_at, str):
                        self._send_json({"error": "started_at must be string"}, status=400)
                        return

                    event_payload = _strip_private_obj(event_payload)

                    if not event_id:
                        # Backwards-compat: derive a stable id for legacy senders.
                        if event_seq_value is not None:
                            raw_id = json.dumps(
                                {"s": event_seq_value, "t": event_type, "p": event_payload},
                                sort_keys=True,
                                ensure_ascii=False,
                            )
                            event_hash = hashlib.sha256(raw_id.encode("utf-8")).hexdigest()[:16]
                            event_id = f"legacy-seq-{event_seq_value}-{event_hash}"
                        else:
                            raw_id = json.dumps(
                                {
                                    "t": event_type,
                                    "p": event_payload,
                                    "w": ts_wall_ms,
                                    "m": ts_mono_ms,
                                },
                                sort_keys=True,
                                ensure_ascii=False,
                            )
                            event_id = (
                                "legacy-" + hashlib.sha256(raw_id.encode("utf-8")).hexdigest()[:16]
                            )
                    event_entry = {
                        "event_id": event_id,
                        "event_type": event_type,
                        "payload": event_payload,
                        "ts_wall_ms": ts_wall_ms,
                        "ts_mono_ms": ts_mono_ms,
                    }
                    batch.append(event_entry)

                    session_ids.add(opencode_session_id)
                    batch_by_session.setdefault(opencode_session_id, []).append(dict(event_entry))

                    if item_cwd or item_project or item_started_at:
                        per_session = meta_by_session.setdefault(opencode_session_id, {})
                        if item_cwd:
                            per_session["cwd"] = item_cwd
                        if item_project:
                            per_session["project"] = item_project
                        if item_started_at:
                            per_session["started_at"] = item_started_at

                if len(session_ids) == 1:
                    single_session_id = next(iter(session_ids))
                    result = store.record_raw_events_batch(
                        opencode_session_id=single_session_id,
                        events=batch,
                    )
                    inserted = int(result["inserted"])
                else:
                    # Fallback: handle multiple sessions individually.
                    for sid, sid_events in batch_by_session.items():
                        result = store.record_raw_events_batch(
                            opencode_session_id=sid,
                            events=sid_events,
                        )
                        inserted += int(result["inserted"])

                for meta_session_id in session_ids:
                    session_meta = meta_by_session.get(meta_session_id, {})
                    apply_request_meta = (
                        len(session_ids) == 1 or meta_session_id == default_session_id
                    )
                    store.update_raw_event_session_meta(
                        opencode_session_id=meta_session_id,
                        cwd=session_meta.get("cwd") or (cwd if apply_request_meta else None),
                        project=session_meta.get("project")
                        or (project if apply_request_meta else None),
                        started_at=session_meta.get("started_at")
                        or (started_at if apply_request_meta else None),
                        last_seen_ts_wall_ms=last_seen_by_session.get(meta_session_id),
                    )
                    RAW_EVENT_FLUSHER.note_activity(meta_session_id)
                self._send_json({"inserted": inserted, "received": len(items)})
                return
            except Exception as exc:  # pragma: no cover
                response: dict[str, Any] = {"error": "internal server error"}
                if os.environ.get("OPENCODE_MEM_VIEWER_DEBUG") == "1":
                    response["detail"] = str(exc)
                self._send_json(response, status=500)
            finally:
                store.close()

        if parsed.path != "/api/config":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            self._send_json({"error": "invalid json"}, status=400)
            return
        if not isinstance(payload, dict):
            self._send_json({"error": "payload must be an object"}, status=400)
            return
        updates = payload.get("config") if "config" in payload else payload
        if not isinstance(updates, dict):
            self._send_json({"error": "config must be an object"}, status=400)
            return
        allowed_keys = {
            "observer_provider",
            "observer_model",
            "observer_max_chars",
            "pack_observation_limit",
            "pack_session_limit",
            "sync_enabled",
            "sync_host",
            "sync_port",
            "sync_interval_s",
            "sync_mdns",
        }
        allowed_providers = set(_load_provider_options())
        config_path = get_config_path()
        try:
            config_data = read_config_file(config_path)
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=500)
            return
        for key in allowed_keys:
            if key not in updates:
                continue
            value = updates[key]
            if value in (None, ""):
                config_data.pop(key, None)
                continue
            if key == "observer_provider":
                if not isinstance(value, str):
                    self._send_json({"error": "observer_provider must be string"}, status=400)
                    return
                provider = value.strip().lower()
                if provider not in allowed_providers:
                    self._send_json(
                        {"error": "observer_provider must match a configured provider"},
                        status=400,
                    )
                    return
                config_data[key] = provider
                continue
            if key == "observer_model":
                if not isinstance(value, str):
                    self._send_json({"error": "observer_model must be string"}, status=400)
                    return
                model_value = value.strip()
                if not model_value:
                    config_data.pop(key, None)
                    continue
                config_data[key] = model_value
                continue
            if key == "observer_max_chars":
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    self._send_json({"error": "observer_max_chars must be int"}, status=400)
                    return
                if value <= 0:
                    self._send_json({"error": "observer_max_chars must be positive"}, status=400)
                    return
                config_data[key] = value
                continue
            if key in {"pack_observation_limit", "pack_session_limit"}:
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    self._send_json({"error": f"{key} must be int"}, status=400)
                    return
                if value <= 0:
                    self._send_json({"error": f"{key} must be positive"}, status=400)
                    return
                config_data[key] = value
                continue
            if key in {"sync_enabled", "sync_mdns"}:
                if not isinstance(value, bool):
                    self._send_json({"error": f"{key} must be boolean"}, status=400)
                    return
                config_data[key] = value
                continue
            if key == "sync_host":
                if not isinstance(value, str):
                    self._send_json({"error": "sync_host must be string"}, status=400)
                    return
                host_value = value.strip()
                if not host_value:
                    config_data.pop(key, None)
                    continue
                config_data[key] = host_value
                continue
            if key in {"sync_port", "sync_interval_s"}:
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    self._send_json({"error": f"{key} must be int"}, status=400)
                    return
                if value <= 0:
                    self._send_json({"error": f"{key} must be positive"}, status=400)
                    return
                config_data[key] = value
                continue
        try:
            write_config_file(config_data, config_path)
        except OSError:
            self._send_json({"error": "failed to write config"}, status=500)
            return
        self._send_json({"path": str(config_path), "config": config_data})

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if self._reject_cross_origin():
            return
        if not parsed.path.startswith("/api/sync/peers/"):
            self.send_response(404)
            self.end_headers()
            return
        peer_device_id = parsed.path.split("/api/sync/peers/", 1)[1].strip()
        if not peer_device_id:
            self._send_json({"error": "peer_device_id required"}, status=400)
            return
        store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
        try:
            row = store.conn.execute(
                "SELECT 1 FROM sync_peers WHERE peer_device_id = ?",
                (peer_device_id,),
            ).fetchone()
            if row is None:
                self._send_json({"error": "peer not found"}, status=404)
                return
            store.conn.execute(
                "DELETE FROM sync_peers WHERE peer_device_id = ?",
                (peer_device_id,),
            )
            store.conn.commit()
            self._send_json({"ok": True})
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
