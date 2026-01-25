from __future__ import annotations

import datetime as dt
import sqlite3
import time
from typing import Any
from urllib.parse import urlparse

from . import db
from .config import load_config

DEFAULT_SERVICE_TYPE = "_opencode-mem._tcp.local."


def mdns_enabled() -> bool:
    config = load_config()
    return config.sync_mdns


def normalize_address(address: str) -> str:
    value = address.strip()
    if not value:
        return ""
    parsed = urlparse(value)
    if parsed.scheme:
        host = (parsed.hostname or "").lower()
        if not host:
            return value.rstrip("/")
        netloc = host
        if parsed.port:
            netloc = f"{host}:{parsed.port}"
        path = parsed.path.rstrip("/")
        scheme = parsed.scheme.lower()
        return f"{scheme}://{netloc}{path}"
    return value.rstrip("/")


def merge_addresses(existing: list[str], candidates: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for address in existing + candidates:
        cleaned = normalize_address(address)
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        normalized.append(cleaned)
    return normalized


def load_peer_addresses(conn: sqlite3.Connection, peer_device_id: str) -> list[str]:
    row = conn.execute(
        "SELECT addresses_json FROM sync_peers WHERE peer_device_id = ?",
        (peer_device_id,),
    ).fetchone()
    if row is None:
        return []
    raw = db.from_json(row["addresses_json"]) if row["addresses_json"] else []
    if not isinstance(raw, list):
        return []
    items: list[str] = [str(item) for item in raw if isinstance(item, str)]
    return items


def update_peer_addresses(
    conn: sqlite3.Connection,
    peer_device_id: str,
    addresses: list[str],
    *,
    name: str | None = None,
    pinned_fingerprint: str | None = None,
    public_key: str | None = None,
) -> list[str]:
    merged = merge_addresses(load_peer_addresses(conn, peer_device_id), addresses)
    now = dt.datetime.now(dt.UTC).isoformat()
    row = conn.execute(
        "SELECT 1 FROM sync_peers WHERE peer_device_id = ?",
        (peer_device_id,),
    ).fetchone()
    if row is None:
        conn.execute(
            """
            INSERT INTO sync_peers(
                peer_device_id,
                name,
                pinned_fingerprint,
                public_key,
                addresses_json,
                created_at,
                last_seen_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                peer_device_id,
                name,
                pinned_fingerprint,
                public_key,
                db.to_json(merged),
                now,
                now,
            ),
        )
    else:
        conn.execute(
            """
            UPDATE sync_peers
            SET name = COALESCE(?, name),
                pinned_fingerprint = COALESCE(?, pinned_fingerprint),
                public_key = COALESCE(?, public_key),
                addresses_json = ?,
                last_seen_at = ?
            WHERE peer_device_id = ?
            """,
            (
                name,
                pinned_fingerprint,
                public_key,
                db.to_json(merged),
                now,
                peer_device_id,
            ),
        )
    conn.commit()
    return merged


def record_sync_attempt(
    conn: sqlite3.Connection,
    peer_device_id: str,
    *,
    ok: bool,
    ops_in: int = 0,
    ops_out: int = 0,
    error: str | None = None,
) -> None:
    now = dt.datetime.now(dt.UTC).isoformat()
    conn.execute(
        """
        INSERT INTO sync_attempts(
            peer_device_id,
            started_at,
            finished_at,
            ok,
            ops_in,
            ops_out,
            error
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (peer_device_id, now, now, 1 if ok else 0, ops_in, ops_out, error),
    )
    if ok:
        conn.execute(
            """
            UPDATE sync_peers
            SET last_sync_at = ?, last_error = NULL
            WHERE peer_device_id = ?
            """,
            (now, peer_device_id),
        )
    else:
        conn.execute(
            """
            UPDATE sync_peers
            SET last_error = ?
            WHERE peer_device_id = ?
            """,
            (error, peer_device_id),
        )
    conn.commit()


def record_peer_success(
    conn: sqlite3.Connection, peer_device_id: str, address: str | None
) -> list[str]:
    addresses = load_peer_addresses(conn, peer_device_id)
    normalized = normalize_address(address or "")
    ordered = addresses
    if normalized:
        remaining = [item for item in addresses if normalize_address(item) != normalized]
        ordered = [normalized, *remaining]
        conn.execute(
            """
            UPDATE sync_peers
            SET addresses_json = ?, last_sync_at = ?, last_error = NULL
            WHERE peer_device_id = ?
            """,
            (
                db.to_json(ordered),
                dt.datetime.now(dt.UTC).isoformat(),
                peer_device_id,
            ),
        )
        conn.commit()
    return ordered


def select_dial_addresses(
    *,
    stored: list[str],
    mdns: list[str],
) -> list[str]:
    if not mdns:
        return merge_addresses(stored, [])
    ordered = merge_addresses(mdns, stored)
    return ordered


def mdns_addresses_for_peer(peer_device_id: str, entries: list[dict[str, Any]]) -> list[str]:
    addresses: list[str] = []
    for entry in entries:
        props = entry.get("properties") or {}
        device_id = props.get(b"device_id") or props.get("device_id")
        if device_id is None:
            continue
        if isinstance(device_id, bytes):
            device_id = device_id.decode("utf-8")
        if device_id != peer_device_id:
            continue
        host = entry.get("host") or ""
        port = entry.get("port") or 0
        if host:
            addresses.append(f"{host}:{port}")
    return addresses


def discover_peers_via_mdns(
    *,
    service_type: str = DEFAULT_SERVICE_TYPE,
    timeout_s: float = 1.5,
) -> list[dict[str, Any]]:
    try:
        from zeroconf import ServiceBrowser, Zeroconf  # type: ignore[import-not-found]
    except Exception:
        return []

    found: list[dict[str, Any]] = []
    zeroconf = Zeroconf()

    class Listener:
        def add_service(self, zc: Zeroconf, service_type: str, name: str) -> None:
            info = zc.get_service_info(service_type, name, timeout=int(timeout_s * 1000))
            if info is None:
                return
            address = None
            if info.addresses:
                address = info.addresses[0]
            host = info.server.rstrip(".") if info.server else ""
            port = info.port
            payload = {
                "name": name,
                "host": host,
                "port": port,
                "address": address,
                "properties": info.properties or {},
            }
            found.append(payload)

        def remove_service(self, zc: Zeroconf, service_type: str, name: str) -> None:
            return

    listener = Listener()
    browser = ServiceBrowser(zeroconf, service_type, listener)
    try:
        time.sleep(timeout_s)
    finally:
        browser.cancel()
        zeroconf.close()
    return found


def advertise_mdns(
    *,
    device_id: str,
    port: int,
    service_type: str = DEFAULT_SERVICE_TYPE,
    name: str | None = None,
) -> Any:
    try:
        from zeroconf import ServiceInfo, Zeroconf  # type: ignore[import-not-found]
    except Exception:
        return None

    service_name = name or f"{device_id}.{service_type}"
    info = ServiceInfo(
        service_type,
        service_name,
        port=port,
        properties={"device_id": device_id},
    )
    zc = Zeroconf()
    zc.register_service(info)
    return zc
