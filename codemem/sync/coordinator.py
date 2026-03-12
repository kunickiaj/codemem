from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse

from ..config import OpencodeMemConfig, load_config
from ..net import pick_advertise_hosts
from ..store import MemoryStore
from ..sync_auth import build_auth_headers
from ..sync_identity import ensure_device_identity, load_public_key
from . import discovery, http_client


def coordinator_enabled(config: OpencodeMemConfig | None = None) -> bool:
    cfg = config or load_config()
    return bool(
        str(cfg.sync_coordinator_url or "").strip()
        and str(cfg.sync_coordinator_group or "").strip()
    )


def _coordinator_base_url(config: OpencodeMemConfig) -> str:
    return http_client.build_base_url(str(config.sync_coordinator_url or "").strip())


def _keys_dir() -> Path | None:
    value = os.environ.get("CODEMEM_KEYS_DIR")
    return Path(value).expanduser() if value else None


def _advertised_sync_addresses(config: OpencodeMemConfig) -> list[str]:
    addresses: list[str] = []
    for host in pick_advertise_hosts(config.sync_advertise):
        host_value = host.strip()
        if not host_value:
            continue
        parsed = urlparse(host_value)
        if parsed.scheme:
            addresses.append(http_client.build_base_url(host_value))
            continue
        addresses.append(http_client.build_base_url(f"http://{host_value}:{config.sync_port}"))
    return discovery.merge_addresses([], addresses)


def register_presence(
    store: MemoryStore, *, config: OpencodeMemConfig | None = None
) -> dict[str, Any] | None:
    cfg = config or load_config()
    if not coordinator_enabled(cfg):
        return None
    keys_dir = _keys_dir()
    device_id, fingerprint = ensure_device_identity(store.conn, keys_dir=keys_dir)
    public_key = load_public_key(keys_dir)
    if not public_key:
        raise RuntimeError("public key missing")
    base_url = _coordinator_base_url(cfg)
    if not base_url:
        raise RuntimeError("coordinator url missing")
    payload = {
        "group_id": str(cfg.sync_coordinator_group or "").strip(),
        "fingerprint": fingerprint,
        "public_key": public_key,
        "addresses": _advertised_sync_addresses(cfg),
        "ttl_s": max(1, int(cfg.sync_coordinator_presence_ttl_s)),
    }
    body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    url = f"{base_url}/v1/presence"
    headers = build_auth_headers(
        device_id=device_id,
        method="POST",
        url=url,
        body_bytes=body_bytes,
        keys_dir=keys_dir,
    )
    status, response = http_client.request_json(
        "POST",
        url,
        headers=headers,
        body=payload,
        body_bytes=body_bytes,
        timeout_s=max(1.0, float(cfg.sync_coordinator_timeout_s)),
    )
    if status != 200 or not isinstance(response, dict):
        detail = response.get("error") if isinstance(response, dict) else None
        raise RuntimeError(f"coordinator presence failed ({status}: {detail or 'unknown'})")
    return response


def lookup_peers(
    store: MemoryStore, *, config: OpencodeMemConfig | None = None
) -> list[dict[str, Any]]:
    cfg = config or load_config()
    if not coordinator_enabled(cfg):
        return []
    keys_dir = _keys_dir()
    device_id, _fingerprint = ensure_device_identity(store.conn, keys_dir=keys_dir)
    base_url = _coordinator_base_url(cfg)
    if not base_url:
        return []
    query = urlencode({"group_id": str(cfg.sync_coordinator_group or "").strip()})
    url = f"{base_url}/v1/peers?{query}"
    headers = build_auth_headers(
        device_id=device_id,
        method="GET",
        url=url,
        body_bytes=b"",
        keys_dir=keys_dir,
    )
    status, response = http_client.request_json(
        "GET",
        url,
        headers=headers,
        timeout_s=max(1.0, float(cfg.sync_coordinator_timeout_s)),
    )
    if status != 200 or not isinstance(response, dict):
        detail = response.get("error") if isinstance(response, dict) else None
        raise RuntimeError(f"coordinator lookup failed ({status}: {detail or 'unknown'})")
    items = response.get("items")
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def refresh_peer_address_cache(
    store: MemoryStore, *, config: OpencodeMemConfig | None = None
) -> dict[str, int]:
    cfg = config or load_config()
    if not coordinator_enabled(cfg):
        return {"updated_peers": 0, "ignored_peers": 0}
    register_presence(store, config=cfg)
    items = lookup_peers(store, config=cfg)
    updated = 0
    ignored = 0
    now = dt.datetime.now(dt.UTC)
    for item in items:
        peer_device_id = str(item.get("device_id") or "").strip()
        if not peer_device_id:
            ignored += 1
            continue
        row = store.conn.execute(
            "SELECT pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?",
            (peer_device_id,),
        ).fetchone()
        if row is None:
            ignored += 1
            continue
        expected_fingerprint = str(row["pinned_fingerprint"] or "").strip()
        fingerprint = str(item.get("fingerprint") or "").strip()
        if not expected_fingerprint or expected_fingerprint != fingerprint:
            ignored += 1
            continue
        expires_at = str(item.get("expires_at") or "").strip()
        if expires_at:
            try:
                expires = dt.datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                if expires.tzinfo is None:
                    expires = expires.replace(tzinfo=dt.UTC)
                if expires <= now:
                    ignored += 1
                    continue
            except ValueError:
                pass
        addresses = item.get("addresses")
        if not isinstance(addresses, list):
            ignored += 1
            continue
        normalized = [str(address) for address in addresses if isinstance(address, str)]
        if not normalized:
            ignored += 1
            continue
        merged = discovery.merge_addresses(
            normalized,
            discovery.load_peer_addresses(store.conn, peer_device_id),
        )
        store.conn.execute(
            "UPDATE sync_peers SET addresses_json = ?, last_seen_at = ? WHERE peer_device_id = ?",
            (json.dumps(merged, ensure_ascii=False), now.isoformat(), peer_device_id),
        )
        store.conn.commit()
        updated += 1
    return {"updated_peers": updated, "ignored_peers": ignored}
