from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlencode

from ..store import MemoryStore, ReplicationOp
from ..sync_api import MAX_SYNC_BODY_BYTES
from ..sync_auth import build_auth_headers
from ..sync_identity import ensure_device_identity
from . import discovery, http_client, replication


def _backfill_derived_fields_for_applied_ops(
    store: MemoryStore,
    ops: list[ReplicationOp],
    applied: dict[str, int],
) -> None:
    changed_count = int(applied.get("inserted", 0)) + int(applied.get("updated", 0))
    if changed_count <= 0:
        return

    import_keys: list[str] = []
    for op in ops:
        if not isinstance(op, dict):
            continue
        if str(op.get("entity_type") or "") != "memory_item":
            continue
        if str(op.get("op_type") or "") != "upsert":
            continue
        payload = op.get("payload")
        if not isinstance(payload, dict):
            continue
        import_key = str(payload.get("import_key") or op.get("entity_id") or "").strip()
        if import_key:
            import_keys.append(import_key)
    if not import_keys:
        return

    deduped_keys: list[str] = []
    seen: set[str] = set()
    for import_key in import_keys:
        if import_key in seen:
            continue
        seen.add(import_key)
        deduped_keys.append(import_key)

    placeholders = ",".join(["?"] * len(deduped_keys))
    rows = store.conn.execute(
        f"SELECT id FROM memory_items WHERE import_key IN ({placeholders})",
        deduped_keys,
    ).fetchall()
    if not rows:
        return
    memory_ids = [int(row["id"]) for row in rows]
    store.backfill_tags_text(memory_ids=memory_ids, active_only=True)
    store.backfill_vectors(memory_ids=memory_ids, active_only=True)


def _cursor_advances(current: str | None, candidate: str | None) -> bool:
    if not candidate:
        return False
    if "|" not in candidate:
        return False
    if not current:
        return True
    return candidate > current


def _error_detail(payload: dict[str, Any] | None) -> str | None:
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    reason = payload.get("reason")
    if isinstance(error, str) and isinstance(reason, str):
        return f"{error}:{reason}"
    if isinstance(error, str):
        return error
    return None


def _summarize_address_errors(address_errors: list[dict[str, str]]) -> str | None:
    if not address_errors:
        return None
    parts = [f"{item['address']}: {item['error']}" for item in address_errors]
    return "all addresses failed | " + " || ".join(parts)


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
        mdns_entries = discovery.discover_peers_via_mdns() if discovery.mdns_enabled() else []
    stored = discovery.load_peer_addresses(store.conn, peer_device_id)
    mdns_addresses = discovery.mdns_addresses_for_peer(peer_device_id, mdns_entries)
    if mdns_addresses:
        discovery.update_peer_addresses(store.conn, peer_device_id, mdns_addresses)
        stored = discovery.load_peer_addresses(store.conn, peer_device_id)
    dial_addresses = discovery.select_dial_addresses(stored=stored, mdns=mdns_addresses)
    return sync_once(store, peer_device_id, dial_addresses, limit=limit)


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
    last_applied, last_acked = replication.get_replication_cursor(store, peer_device_id)
    keys_dir_value = os.environ.get("CODEMEM_KEYS_DIR")
    keys_dir = Path(keys_dir_value).expanduser() if keys_dir_value else None
    device_id, _ = ensure_device_identity(store.conn, keys_dir=keys_dir)
    error: str | None = None
    address_errors: list[dict[str, str]] = []
    attempted_any = False

    def _push_ops(
        *,
        post_url: str,
        device_id: str,
        keys_dir: Path | None,
        ops: list[ReplicationOp],
    ) -> None:
        if not ops:
            return

        body = {"ops": ops}
        body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
        post_headers = build_auth_headers(
            device_id=device_id,
            method="POST",
            url=post_url,
            body_bytes=body_bytes,
            keys_dir=keys_dir,
        )
        status, payload = http_client.request_json(
            "POST",
            post_url,
            headers=post_headers,
            body=body,
            body_bytes=body_bytes,
        )
        if status == 200 and payload is not None:
            return

        detail = _error_detail(payload)
        if status == 413 and len(ops) > 1 and detail in {"payload_too_large", "too_many_ops"}:
            mid = len(ops) // 2
            _push_ops(post_url=post_url, device_id=device_id, keys_dir=keys_dir, ops=ops[:mid])
            _push_ops(post_url=post_url, device_id=device_id, keys_dir=keys_dir, ops=ops[mid:])
            return

        suffix = f" ({status}: {detail})" if detail else f" ({status})"
        raise RuntimeError(f"peer ops push failed{suffix}")

    for address in addresses:
        base_url = http_client.build_base_url(address)
        if not base_url:
            continue
        attempted_any = True
        try:
            status_url = f"{base_url}/v1/status"
            status_headers = build_auth_headers(
                device_id=device_id,
                method="GET",
                url=status_url,
                body_bytes=b"",
                keys_dir=keys_dir,
            )
            status_code, status_payload = http_client.request_json(
                "GET",
                status_url,
                headers=status_headers,
            )
            if status_code != 200 or not status_payload:
                detail = _error_detail(status_payload)
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
            status, payload = http_client.request_json("GET", get_url, headers=get_headers)
            if status != 200 or payload is None:
                detail = _error_detail(payload)
                suffix = f" ({status}: {detail})" if detail else f" ({status})"
                raise RuntimeError(f"peer ops fetch failed{suffix}")
            ops = payload.get("ops")
            if not isinstance(ops, list):
                raise RuntimeError("invalid ops response")
            received_at = dt.datetime.now(dt.UTC).isoformat()
            applied = store.apply_replication_ops(
                cast(list[ReplicationOp], ops),
                source_device_id=peer_device_id,
                received_at=received_at,
            )
            _backfill_derived_fields_for_applied_ops(store, cast(list[ReplicationOp], ops), applied)
            if ops:
                last_op = ops[-1] if isinstance(ops[-1], dict) else None
                op_id = str(last_op.get("op_id") or "") if last_op else ""
                created_at = str(last_op.get("created_at") or "") if last_op else ""
                if op_id and created_at:
                    local_next = store.compute_cursor(created_at, op_id)
                    replication.set_replication_cursor(
                        store,
                        peer_device_id,
                        last_applied=local_next,
                    )
                    last_applied = local_next
            else:
                peer_next = str(payload.get("next_cursor") or "").strip()
                skipped_value = payload.get("skipped")
                skipped_count = int(skipped_value) if isinstance(skipped_value, int) else 0
                if skipped_count > 0 and _cursor_advances(last_applied, peer_next):
                    replication.set_replication_cursor(
                        store,
                        peer_device_id,
                        last_applied=peer_next,
                    )
                    last_applied = peer_next

            effective_last_acked = store.normalize_outbound_cursor(last_acked, device_id=device_id)
            outbound_ops, outbound_cursor = store.load_replication_ops_since(
                effective_last_acked,
                limit=limit,
                device_id=device_id,
            )
            outbound_ops, outbound_cursor = store.filter_replication_ops_for_sync(
                outbound_ops,
                peer_device_id=peer_device_id,
            )
            post_url = f"{base_url}/v1/ops"
            if outbound_ops:
                batches = replication.chunk_ops_by_size(
                    outbound_ops,
                    max_bytes=MAX_SYNC_BODY_BYTES,
                )
                for batch in batches:
                    _push_ops(
                        post_url=post_url,
                        device_id=device_id,
                        keys_dir=keys_dir,
                        ops=cast(list[ReplicationOp], batch),
                    )
            if outbound_cursor:
                replication.set_replication_cursor(
                    store,
                    peer_device_id,
                    last_acked=outbound_cursor,
                )
                last_acked = outbound_cursor

            discovery.record_peer_success(store.conn, peer_device_id, base_url)
            discovery.record_sync_attempt(
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
            detail = str(exc).strip() or exc.__class__.__name__
            address_errors.append({"address": base_url, "error": detail})
            continue
    error = _summarize_address_errors(address_errors) or error
    if not attempted_any:
        error = "no dialable peer addresses"
    if not error:
        error = "sync failed without diagnostic detail"
    discovery.record_sync_attempt(store.conn, peer_device_id, ok=False, error=error)
    return {"ok": False, "error": error, "address_errors": address_errors}


def sync_daemon_tick(store: MemoryStore) -> list[dict[str, Any]]:
    sync_pass_preflight(store)
    rows = store.conn.execute("SELECT peer_device_id FROM sync_peers").fetchall()
    mdns_entries = discovery.discover_peers_via_mdns() if discovery.mdns_enabled() else []
    results: list[dict[str, Any]] = []
    for row in rows:
        peer_device_id = str(row["peer_device_id"])
        results.append(run_sync_pass(store, peer_device_id, mdns_entries=mdns_entries))
    return results
