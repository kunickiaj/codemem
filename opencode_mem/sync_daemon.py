from __future__ import annotations

import contextlib
import datetime as dt
import json
import os
import socket
import threading
import traceback
from http.client import HTTPConnection, HTTPSConnection
from http.server import HTTPServer
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlencode, urlparse

from . import db
from .store import MemoryStore, ReplicationOp
from .sync_api import MAX_SYNC_BODY_BYTES, build_sync_handler
from .sync_auth import build_auth_headers
from .sync_discovery import (
    advertise_mdns,
    discover_peers_via_mdns,
    load_peer_addresses,
    mdns_addresses_for_peer,
    mdns_enabled,
    record_peer_success,
    record_sync_attempt,
    select_dial_addresses,
    update_peer_addresses,
)
from .sync_identity import ensure_device_identity


def sync_pass_preflight(
    store: MemoryStore,
    *,
    legacy_limit: int = 2000,
    replication_backfill_limit: int = 200,
) -> None:
    store.migrate_legacy_import_keys(limit=legacy_limit)
    store.backfill_replication_ops(limit=replication_backfill_limit)


def run_sync_pass(
    store: MemoryStore,
    peer_device_id: str,
    *,
    mdns_entries: list[dict[str, Any]] | None = None,
    limit: int = 200,
) -> dict[str, Any]:
    if mdns_entries is None:
        mdns_entries = discover_peers_via_mdns() if mdns_enabled() else []
    stored = load_peer_addresses(store.conn, peer_device_id)
    mdns_addresses = mdns_addresses_for_peer(peer_device_id, mdns_entries)
    if mdns_addresses:
        update_peer_addresses(store.conn, peer_device_id, mdns_addresses)
        stored = load_peer_addresses(store.conn, peer_device_id)
    dial_addresses = select_dial_addresses(stored=stored, mdns=mdns_addresses)
    return sync_once(store, peer_device_id, dial_addresses, limit=limit)


def _chunk_ops_by_size(
    ops: list[ReplicationOp],
    *,
    max_bytes: int,
) -> list[list[ReplicationOp]]:
    def _body_bytes(batch: list[ReplicationOp]) -> int:
        return len(json.dumps({"ops": batch}, ensure_ascii=False).encode("utf-8"))

    batches: list[list[ReplicationOp]] = []
    current: list[ReplicationOp] = []
    for op in ops:
        candidate = [*current, op]
        if _body_bytes(candidate) <= max_bytes:
            current = candidate
            continue
        if not current:
            raise RuntimeError("single op exceeds size limit")
        batches.append(current)
        current = [op]
        if _body_bytes(current) > max_bytes:
            raise RuntimeError("single op exceeds size limit")
    if current:
        batches.append(current)
    return batches


def _build_base_url(address: str) -> str:
    trimmed = address.strip().rstrip("/")
    if not trimmed:
        return ""
    parsed = urlparse(trimmed)
    if parsed.scheme:
        return trimmed
    return f"http://{trimmed}"


def _request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    body_bytes: bytes | None = None,
    timeout_s: float = 3.0,
) -> tuple[int, dict[str, Any] | None]:
    parsed = urlparse(url)
    if not parsed.hostname:
        raise ValueError("missing hostname")
    if parsed.scheme == "https":
        conn = HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=timeout_s)
    else:
        conn = HTTPConnection(parsed.hostname, parsed.port or 80, timeout=timeout_s)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    payload = None
    if body_bytes is None and body is not None:
        body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request_headers = {"Accept": "application/json"}
    if body_bytes is not None:
        request_headers["Content-Type"] = "application/json"
        request_headers["Content-Length"] = str(len(body_bytes))
    if headers:
        request_headers.update(headers)
    conn.request(method, path, body=body_bytes, headers=request_headers)
    resp = conn.getresponse()
    raw = resp.read()
    if raw:
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            payload = None
    conn.close()
    return resp.status, payload if isinstance(payload, dict) else None


def _get_replication_cursor(
    store: MemoryStore, peer_device_id: str
) -> tuple[str | None, str | None]:
    row = store.conn.execute(
        """
        SELECT last_applied_cursor, last_acked_cursor
        FROM replication_cursors
        WHERE peer_device_id = ?
        """,
        (peer_device_id,),
    ).fetchone()
    if row is None:
        return None, None
    return row["last_applied_cursor"], row["last_acked_cursor"]


def _set_replication_cursor(
    store: MemoryStore,
    peer_device_id: str,
    *,
    last_applied: str | None = None,
    last_acked: str | None = None,
) -> None:
    now = dt.datetime.now(dt.UTC).isoformat()
    row = store.conn.execute(
        "SELECT 1 FROM replication_cursors WHERE peer_device_id = ?",
        (peer_device_id,),
    ).fetchone()
    if row is None:
        store.conn.execute(
            """
            INSERT INTO replication_cursors(
                peer_device_id,
                last_applied_cursor,
                last_acked_cursor,
                updated_at
            )
            VALUES (?, ?, ?, ?)
            """,
            (peer_device_id, last_applied, last_acked, now),
        )
    else:
        store.conn.execute(
            """
            UPDATE replication_cursors
            SET last_applied_cursor = COALESCE(?, last_applied_cursor),
                last_acked_cursor = COALESCE(?, last_acked_cursor),
                updated_at = ?
            WHERE peer_device_id = ?
            """,
            (last_applied, last_acked, now, peer_device_id),
        )
    store.conn.commit()


def sync_once(
    store: MemoryStore,
    peer_device_id: str,
    addresses: list[str],
    *,
    limit: int = 200,
) -> dict[str, Any]:
    pinned_row = store.conn.execute(
        "SELECT pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?",
        (peer_device_id,),
    ).fetchone()
    pinned_fingerprint = str(pinned_row["pinned_fingerprint"]) if pinned_row else ""
    if not pinned_fingerprint:
        return {"ok": False, "error": "peer not pinned"}
    last_applied, last_acked = _get_replication_cursor(store, peer_device_id)
    keys_dir_value = os.environ.get("OPENCODE_MEM_KEYS_DIR")
    keys_dir = Path(keys_dir_value).expanduser() if keys_dir_value else None
    device_id, _ = ensure_device_identity(store.conn, keys_dir=keys_dir)
    error: str | None = None
    for address in addresses:
        base_url = _build_base_url(address)
        if not base_url:
            continue
        try:
            status_url = f"{base_url}/v1/status"
            status_headers = build_auth_headers(
                device_id=device_id,
                method="GET",
                url=status_url,
                body_bytes=b"",
                keys_dir=keys_dir,
            )
            status_code, status_payload = _request_json(
                "GET",
                status_url,
                headers=status_headers,
            )
            if status_code != 200 or not status_payload:
                detail = status_payload.get("error") if isinstance(status_payload, dict) else None
                suffix = f" ({status_code}: {detail})" if detail else f" ({status_code})"
                raise RuntimeError(f"peer status failed{suffix}")
            if status_payload.get("fingerprint") != pinned_fingerprint:
                raise RuntimeError("peer fingerprint mismatch")
            query = urlencode({"since": last_applied or "", "limit": limit})
            get_url = f"{base_url}/v1/ops?{query}"
            get_headers = build_auth_headers(
                device_id=device_id,
                method="GET",
                url=get_url,
                body_bytes=b"",
                keys_dir=keys_dir,
            )
            status, payload = _request_json("GET", get_url, headers=get_headers)
            if status != 200 or payload is None:
                detail = payload.get("error") if isinstance(payload, dict) else None
                suffix = f" ({status}: {detail})" if detail else f" ({status})"
                raise RuntimeError(f"peer ops fetch failed{suffix}")
            if payload.get("blocked") is True:
                blocked_op = payload.get("blocked_op")
                op_id = ""
                project = ""
                if isinstance(blocked_op, dict):
                    op_id = str(blocked_op.get("op_id") or "")
                    project = str(blocked_op.get("project") or "")
                reason = str(payload.get("blocked_reason") or "blocked")
                suffix = f" op={op_id}" if op_id else ""
                if project:
                    suffix += f" project={project}"
                raise RuntimeError(f"peer ops blocked ({reason}){suffix}")
            ops = payload.get("ops")
            if not isinstance(ops, list):
                raise RuntimeError("invalid ops response")
            received_at = dt.datetime.now(dt.UTC).isoformat()
            applied = store.apply_replication_ops(
                cast(list[ReplicationOp], ops),
                source_device_id=peer_device_id,
                received_at=received_at,
            )
            if ops:
                last_op = ops[-1] if isinstance(ops[-1], dict) else None
                op_id = str(last_op.get("op_id") or "") if last_op else ""
                created_at = str(last_op.get("created_at") or "") if last_op else ""
                if op_id and created_at:
                    local_next = store.compute_cursor(created_at, op_id)
                    _set_replication_cursor(store, peer_device_id, last_applied=local_next)
                    last_applied = local_next

            effective_last_acked = store.normalize_outbound_cursor(last_acked, device_id=device_id)
            outbound_ops, outbound_cursor = store.load_replication_ops_since(
                effective_last_acked,
                limit=limit,
                device_id=device_id,
            )
            outbound_ops, outbound_cursor = store.filter_replication_ops_for_sync(
                outbound_ops, peer_device_id=peer_device_id
            )
            post_url = f"{base_url}/v1/ops"
            if outbound_ops:
                batches = _chunk_ops_by_size(outbound_ops, max_bytes=MAX_SYNC_BODY_BYTES)
                for batch in batches:
                    body = {"ops": batch}
                    body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
                    post_headers = build_auth_headers(
                        device_id=device_id,
                        method="POST",
                        url=post_url,
                        body_bytes=body_bytes,
                        keys_dir=keys_dir,
                    )
                    status, payload = _request_json(
                        "POST",
                        post_url,
                        headers=post_headers,
                        body=body,
                        body_bytes=body_bytes,
                    )
                    if status != 200 or payload is None:
                        detail = payload.get("error") if isinstance(payload, dict) else None
                        suffix = f" ({status}: {detail})" if detail else f" ({status})"
                        raise RuntimeError(f"peer ops push failed{suffix}")
                if outbound_cursor:
                    _set_replication_cursor(store, peer_device_id, last_acked=outbound_cursor)
                    last_acked = outbound_cursor

            record_peer_success(store.conn, peer_device_id, base_url)
            record_sync_attempt(
                store.conn,
                peer_device_id,
                ok=True,
                ops_in=applied.get("inserted", 0) + applied.get("updated", 0),
                ops_out=len(outbound_ops),
            )
            return {
                "ok": True,
                "address": base_url,
                "ops_in": len(ops),
                "ops_out": len(outbound_ops),
            }
        except Exception as exc:
            error = f"{base_url}: {exc}"
            continue
    record_sync_attempt(store.conn, peer_device_id, ok=False, error=error)
    return {"ok": False, "error": error}


def sync_daemon_tick(store: MemoryStore) -> list[dict[str, Any]]:
    sync_pass_preflight(store)
    rows = store.conn.execute("SELECT peer_device_id FROM sync_peers").fetchall()
    mdns_entries = discover_peers_via_mdns() if mdns_enabled() else []
    results: list[dict[str, Any]] = []
    for row in rows:
        peer_device_id = str(row["peer_device_id"])
        results.append(run_sync_pass(store, peer_device_id, mdns_entries=mdns_entries))
    return results


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
                    sync_daemon_tick(store)
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
