from __future__ import annotations

import datetime as dt
import json
import re
import sqlite3
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any, cast
from uuid import uuid4

from .. import db
from . import utils as store_utils
from .types import ReplicationClock, ReplicationOp

if TYPE_CHECKING:
    from ._store import MemoryStore

LEGACY_IMPORT_KEY_OLD_RE = re.compile(r"^legacy:memory_item:(\d+)$")
LEGACY_IMPORT_KEY_NEW_RE = re.compile(r"^legacy:([^:]+):memory_item:(\d+)$")


def _effective_sync_project_filters(
    store: MemoryStore, *, peer_device_id: str | None = None
) -> tuple[list[str], list[str]]:
    """Return include/exclude filters for a specific peer.

    Semantics:
    - If the peer has no per-peer override (both columns NULL), fall back to global config.
    - If either per-peer column is non-NULL, treat missing side as empty (no implicit global merge).
    """

    if not peer_device_id:
        return store._sync_projects_include, store._sync_projects_exclude
    row = store.conn.execute(
        """
        SELECT projects_include_json, projects_exclude_json
        FROM sync_peers
        WHERE peer_device_id = ?
        """,
        (peer_device_id,),
    ).fetchone()
    if row is None:
        return store._sync_projects_include, store._sync_projects_exclude
    include_text = row["projects_include_json"]
    exclude_text = row["projects_exclude_json"]
    has_override = include_text is not None or exclude_text is not None
    if not has_override:
        return store._sync_projects_include, store._sync_projects_exclude
    include = store._safe_json_list(include_text)
    exclude = store._safe_json_list(exclude_text)
    return include, exclude


def _sync_project_allowed(
    store: MemoryStore, project: str | None, *, peer_device_id: str | None = None
) -> bool:
    include_list, exclude_list = _effective_sync_project_filters(
        store, peer_device_id=peer_device_id
    )
    include = {store._project_basename(p) for p in include_list if p}
    exclude = {store._project_basename(p) for p in exclude_list if p}

    value = None
    if isinstance(project, str) and project.strip():
        value = store._project_basename(project.strip())

    if value and value in exclude:
        return False
    if include:
        return bool(value and value in include)
    return True


def count_replication_ops_missing_project(store: MemoryStore) -> int:
    """Count memory_item replication ops whose payload lacks a usable project.

    When sync include-lists are active, these ops cannot be reliably filtered.
    """

    try:
        row = store.conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM replication_ops
            WHERE entity_type = 'memory_item'
              AND (
                payload_json IS NULL
                OR TRIM(payload_json) = ''
                OR json_extract(payload_json, '$.project') IS NULL
                OR TRIM(COALESCE(json_extract(payload_json, '$.project'), '')) = ''
              )
            """
        ).fetchone()
        return int(row["count"] or 0) if row else 0
    except sqlite3.OperationalError:
        rows = store.conn.execute(
            "SELECT payload_json FROM replication_ops WHERE entity_type = 'memory_item'"
        ).fetchall()
        missing = 0
        for row in rows:
            payload_json = row["payload_json"]
            if not payload_json or not str(payload_json).strip():
                missing += 1
                continue
            try:
                payload = json.loads(payload_json)
            except json.JSONDecodeError:
                missing += 1
                continue
            project = payload.get("project") if isinstance(payload, dict) else None
            if not isinstance(project, str) or not project.strip():
                missing += 1
        return missing


def filter_replication_ops_for_sync(
    store: MemoryStore,
    ops: Sequence[ReplicationOp],
    *,
    peer_device_id: str | None = None,
) -> tuple[list[ReplicationOp], str | None]:
    allowed_ops, next_cursor, _blocked = filter_replication_ops_for_sync_with_status(
        store, ops, peer_device_id=peer_device_id
    )
    return allowed_ops, next_cursor


def filter_replication_ops_for_sync_with_status(
    store: MemoryStore,
    ops: Sequence[ReplicationOp],
    *,
    peer_device_id: str | None = None,
) -> tuple[list[ReplicationOp], str | None, dict[str, Any] | None]:
    """Filter outbound replication ops, skipping disallowed projects.

    Returns:
    - allowed ops: ops that pass the project filter (disallowed ops are skipped)
    - next_cursor: cursor for the last *processed* op (advances past skipped ops)
    - skipped: metadata about skipped ops (count + first skipped), or None
    """

    allowed_ops: list[ReplicationOp] = []
    next_cursor: str | None = None
    skipped_count = 0
    first_skipped: dict[str, Any] | None = None
    for op in ops:
        entity_type = str(op.get("entity_type") or "")
        if entity_type == "memory_item":
            project = None
            payload = op.get("payload")
            if isinstance(payload, dict):
                project_value = payload.get("project")
                project = project_value if isinstance(project_value, str) else None
            if not _sync_project_allowed(store, project, peer_device_id=peer_device_id):
                skipped_count += 1
                if first_skipped is None:
                    first_skipped = {
                        "reason": "project_filter",
                        "op_id": str(op.get("op_id") or ""),
                        "created_at": str(op.get("created_at") or ""),
                        "entity_type": entity_type,
                        "entity_id": str(op.get("entity_id") or ""),
                        "project": project,
                    }
                # Advance cursor past the skipped op so sync doesn't stall
                next_cursor = store_utils.compute_cursor(
                    str(op.get("created_at") or ""), str(op.get("op_id") or "")
                )
                continue
        allowed_ops.append(op)
        next_cursor = store_utils.compute_cursor(
            str(op.get("created_at") or ""), str(op.get("op_id") or "")
        )
    skipped: dict[str, Any] | None = None
    if first_skipped is not None:
        skipped = {**first_skipped, "skipped_count": skipped_count}
    return allowed_ops, next_cursor, skipped


def migrate_legacy_import_keys(store: MemoryStore, *, limit: int = 2000) -> int:
    """Make legacy import_key values globally unique.

    Earlier versions used import keys like `legacy:memory_item:{row_id}`, which collide
    across devices and can cause replication ops to no-op.
    """

    device_row = store.conn.execute("SELECT device_id FROM sync_device LIMIT 1").fetchone()
    device_id = str(device_row["device_id"]) if device_row else ""
    if not device_id:
        return 0

    rows = store.conn.execute(
        """
        SELECT id, import_key, metadata_json
        FROM memory_items
        WHERE import_key IS NULL
           OR TRIM(import_key) = ''
           OR import_key LIKE 'legacy:memory_item:%'
        ORDER BY id ASC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    if not rows:
        return 0

    updated = 0
    for row in rows:
        memory_id = int(row["id"])
        current = str(row["import_key"] or "").strip()
        metadata = store._normalize_metadata(row["metadata_json"])
        clock_device_id = str(metadata.get("clock_device_id") or "").strip()

        canonical = ""
        if not current:
            canonical = f"legacy:{device_id}:memory_item:{memory_id}"
        else:
            match = LEGACY_IMPORT_KEY_OLD_RE.match(current)
            if not match:
                continue
            suffix = match.group(1)
            origin = (
                clock_device_id if clock_device_id and clock_device_id != "local" else device_id
            )
            canonical = f"legacy:{origin}:memory_item:{suffix}" if origin else ""
        if not canonical or canonical == current:
            continue
        existing = store.conn.execute(
            "SELECT id FROM memory_items WHERE import_key = ? LIMIT 1",
            (canonical,),
        ).fetchone()
        if existing is not None and int(existing["id"]) != memory_id:
            continue
        store.conn.execute(
            "UPDATE memory_items SET import_key = ? WHERE id = ?",
            (canonical, memory_id),
        )
        updated += 1
    store.conn.commit()
    return updated


def _legacy_import_key_suffix(import_key: str) -> str | None:
    match = LEGACY_IMPORT_KEY_OLD_RE.match(import_key)
    if match:
        return match.group(1)
    match = LEGACY_IMPORT_KEY_NEW_RE.match(import_key)
    if match:
        return match.group(2)
    return None


def _canonical_legacy_import_key(
    import_key: str,
    *,
    clock_device_id: str,
    local_device_id: str,
    memory_id: int,
) -> str | None:
    cleaned = import_key.strip()
    if not cleaned:
        if not local_device_id:
            return None
        return f"legacy:{local_device_id}:memory_item:{memory_id}"
    if LEGACY_IMPORT_KEY_NEW_RE.match(cleaned):
        return cleaned
    match = LEGACY_IMPORT_KEY_OLD_RE.match(cleaned)
    if not match:
        return None
    suffix = match.group(1)
    origin = (
        clock_device_id.strip()
        if clock_device_id.strip() and clock_device_id != "local"
        else local_device_id
    )
    if not origin:
        return None
    return f"legacy:{origin}:memory_item:{suffix}"


def _legacy_import_key_aliases(import_key: str, *, clock_device_id: str) -> list[str]:
    aliases: list[str] = []
    cleaned = import_key.strip()
    match = LEGACY_IMPORT_KEY_NEW_RE.match(cleaned)
    if match:
        suffix = match.group(2)
        aliases.append(f"legacy:memory_item:{suffix}")
    match = LEGACY_IMPORT_KEY_OLD_RE.match(cleaned)
    if match and clock_device_id and clock_device_id != "local":
        suffix = match.group(1)
        aliases.append(f"legacy:{clock_device_id}:memory_item:{suffix}")
    return aliases


def _record_replication_delete_for_key(
    store: MemoryStore, *, import_key: str, payload: dict[str, Any]
) -> None:
    metadata = store._normalize_metadata(payload.get("metadata_json"))
    metadata["clock_device_id"] = store.device_id
    payload = dict(payload)
    payload["metadata_json"] = metadata
    payload["import_key"] = import_key
    payload["active"] = 0
    payload["deleted_at"] = payload.get("deleted_at") or store._now_iso()
    payload["updated_at"] = payload.get("updated_at") or payload["deleted_at"]
    payload["rev"] = int(payload.get("rev") or 0) + 1
    clock = _clock_from_payload(store, payload)
    record_replication_op(
        store,
        op_id=str(uuid4()),
        entity_type="memory_item",
        entity_id=import_key,
        op_type="delete",
        payload=payload,
        clock=clock,
        device_id=clock["device_id"],
        created_at=store._now_iso(),
    )


def repair_legacy_import_keys(
    store: MemoryStore,
    *,
    limit: int = 10000,
    dry_run: bool = False,
) -> dict[str, int]:
    """Repair legacy import_key duplication across old/new formats.

    Older databases used `legacy:memory_item:<n>` which collides across devices.
    Newer code uses `legacy:<device_id>:memory_item:<n>`. If a database contains both,
    sync can duplicate the same conceptual memories.
    """

    device_row = store.conn.execute("SELECT device_id FROM sync_device LIMIT 1").fetchone()
    local_device_id = str(device_row["device_id"]) if device_row else store.device_id
    now = store._now_iso()

    rows = store.conn.execute(
        """
        SELECT id, import_key, metadata_json, rev, updated_at
        FROM memory_items
        WHERE import_key IS NULL
           OR TRIM(import_key) = ''
           OR (active = 1 AND import_key LIKE 'legacy:memory_item:%')
        ORDER BY id ASC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()

    stats = {
        "checked": 0,
        "renamed": 0,
        "merged": 0,
        "tombstoned": 0,
        "skipped": 0,
        "ops": 0,
    }

    for row in rows:
        stats["checked"] += 1
        memory_id = int(row["id"])
        current = str(row["import_key"] or "").strip()
        metadata = store._normalize_metadata(row["metadata_json"])
        clock_device_id = str(metadata.get("clock_device_id") or "").strip()

        canonical = None
        suffix = _legacy_import_key_suffix(current)
        if suffix and LEGACY_IMPORT_KEY_OLD_RE.match(current):
            # Prefer any existing new-format key for the same suffix.
            picked = store.conn.execute(
                """
                SELECT id, import_key
                FROM memory_items
                WHERE import_key LIKE ?
                ORDER BY active DESC, updated_at DESC, id DESC
                LIMIT 1
                """,
                (f"legacy:%:memory_item:{suffix}",),
            ).fetchone()
            if picked is not None:
                canonical = str(picked["import_key"] or "").strip() or None
        if canonical is None:
            canonical = _canonical_legacy_import_key(
                current,
                clock_device_id=clock_device_id,
                local_device_id=local_device_id,
                memory_id=memory_id,
            )
        if not canonical or canonical == current:
            stats["skipped"] += 1
            continue

        canonical_row = store.conn.execute(
            "SELECT * FROM memory_items WHERE import_key = ? LIMIT 1",
            (canonical,),
        ).fetchone()

        if canonical_row is None:
            if dry_run:
                stats["renamed"] += 1
                continue
            if current and LEGACY_IMPORT_KEY_OLD_RE.match(current):
                original = store.conn.execute(
                    "SELECT * FROM memory_items WHERE id = ? LIMIT 1",
                    (memory_id,),
                ).fetchone()
                if original is not None:
                    _record_replication_delete_for_key(
                        store,
                        import_key=current,
                        payload=_memory_item_payload(store, dict(original)),
                    )
                    stats["ops"] += 1
            store.conn.execute(
                "UPDATE memory_items SET import_key = ?, updated_at = ? WHERE id = ?",
                (canonical, now, memory_id),
            )
            store.conn.commit()
            _record_memory_item_op(store, memory_id, "upsert")
            stats["ops"] += 1
            stats["renamed"] += 1
            continue

        canonical_id = int(canonical_row["id"])
        if canonical_id == memory_id:
            stats["skipped"] += 1
            continue

        if dry_run:
            stats["merged"] += 1
            stats["tombstoned"] += 1
            continue

        # Merge: keep the newer clock row's content under the canonical key.
        old_row = dict(
            store.conn.execute(
                "SELECT * FROM memory_items WHERE id = ? LIMIT 1",
                (memory_id,),
            ).fetchone()
        )
        new_row = dict(canonical_row)
        winner = "canonical"
        if _is_newer_clock(_memory_item_clock(store, old_row), _memory_item_clock(store, new_row)):
            winner = "old"

        if winner == "old":
            merged_meta = store._normalize_metadata(old_row.get("metadata_json"))
            merged_meta["clock_device_id"] = store.device_id
            merged_json = db.to_json(merged_meta)
            store.conn.execute(
                """
                UPDATE memory_items
                SET session_id = ?, kind = ?, title = ?, body_text = ?, confidence = ?, tags_text = ?,
                    active = ?, created_at = ?, updated_at = ?, metadata_json = ?, subtitle = ?, facts = ?,
                    narrative = ?, concepts = ?, files_read = ?, files_modified = ?, prompt_number = ?,
                    deleted_at = ?, rev = ?
                WHERE id = ?
                """,
                (
                    int(old_row.get("session_id") or 0),
                    str(old_row.get("kind") or ""),
                    str(old_row.get("title") or ""),
                    str(old_row.get("body_text") or ""),
                    float(old_row.get("confidence") or 0.5),
                    str(old_row.get("tags_text") or ""),
                    int(old_row.get("active") or 1),
                    str(old_row.get("created_at") or now),
                    now,
                    merged_json,
                    old_row.get("subtitle"),
                    old_row.get("facts"),
                    old_row.get("narrative"),
                    old_row.get("concepts"),
                    old_row.get("files_read"),
                    old_row.get("files_modified"),
                    old_row.get("prompt_number"),
                    old_row.get("deleted_at"),
                    max(int(new_row.get("rev") or 0), int(old_row.get("rev") or 0)) + 1,
                    canonical_id,
                ),
            )
            store.conn.commit()
            _record_memory_item_op(store, canonical_id, "upsert")
            stats["ops"] += 1

        # Tombstone the old key (so peers delete it) and deactivate locally.
        delete_payload = _memory_item_payload(store, old_row)
        _record_replication_delete_for_key(
            store, import_key=current or f"memory:{memory_id}", payload=delete_payload
        )
        stats["ops"] += 1
        tombstone_meta = store._normalize_metadata(old_row.get("metadata_json"))
        tombstone_meta["clock_device_id"] = store.device_id
        store.conn.execute(
            "UPDATE memory_items SET active = 0, deleted_at = ?, updated_at = ?, metadata_json = ?, rev = rev + 1 WHERE id = ?",
            (now, now, db.to_json(tombstone_meta), memory_id),
        )
        store.conn.commit()

        stats["merged"] += 1
        stats["tombstoned"] += 1

    return stats


def _clock_tuple(
    rev: int | None, updated_at: str | None, device_id: str | None
) -> tuple[int, str, str]:
    return (int(rev or 0), str(updated_at or ""), str(device_id or ""))


def _is_newer_clock(candidate: tuple[int, str, str], existing: tuple[int, str, str]) -> bool:
    return candidate > existing


def _memory_item_clock(store: MemoryStore, row: dict[str, Any]) -> tuple[int, str, str]:
    metadata = store._normalize_metadata(row.get("metadata_json"))
    device_id = str(metadata.get("clock_device_id") or "")
    return _clock_tuple(row.get("rev"), row.get("updated_at"), device_id)


def _memory_item_payload(store: MemoryStore, row: dict[str, Any]) -> dict[str, Any]:
    metadata = store._normalize_metadata(row.get("metadata_json"))
    session_id = row.get("session_id")
    project = None
    if session_id is not None:
        try:
            session_row = store.conn.execute(
                "SELECT project FROM sessions WHERE id = ?",
                (int(session_id),),
            ).fetchone()
            if session_row is not None:
                raw = session_row["project"]
                if isinstance(raw, str) and raw.strip():
                    project = store._project_basename(raw.strip())
        except Exception:
            project = None
    return {
        "session_id": session_id,
        "project": project,
        "kind": row.get("kind"),
        "title": row.get("title"),
        "body_text": row.get("body_text"),
        "confidence": row.get("confidence"),
        "tags_text": row.get("tags_text"),
        "active": row.get("active"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "metadata_json": metadata,
        "subtitle": row.get("subtitle"),
        "facts": row.get("facts"),
        "narrative": row.get("narrative"),
        "concepts": row.get("concepts"),
        "files_read": row.get("files_read"),
        "files_modified": row.get("files_modified"),
        "prompt_number": row.get("prompt_number"),
        "import_key": row.get("import_key"),
        "deleted_at": row.get("deleted_at"),
        "rev": row.get("rev"),
    }


def _clock_from_payload(store: MemoryStore, payload: dict[str, Any]) -> ReplicationClock:
    metadata = store._normalize_metadata(payload.get("metadata_json"))
    device_id = str(metadata.get("clock_device_id") or store.device_id)
    return {
        "rev": int(payload.get("rev") or 0),
        "updated_at": str(payload.get("updated_at") or ""),
        "device_id": device_id,
    }


def _record_memory_item_op(store: MemoryStore, memory_id: int, op_type: str) -> None:
    row = store.conn.execute(
        "SELECT * FROM memory_items WHERE id = ?",
        (memory_id,),
    ).fetchone()
    if row is None:
        return
    payload = _memory_item_payload(store, dict(row))
    clock = _clock_from_payload(store, payload)
    entity_id = str(payload.get("import_key") or memory_id)
    record_replication_op(
        store,
        op_id=str(uuid4()),
        entity_type="memory_item",
        entity_id=entity_id,
        op_type=op_type,
        payload=payload,
        clock=clock,
        device_id=clock["device_id"],
        created_at=store._now_iso(),
    )


def backfill_replication_ops(store: MemoryStore, *, limit: int = 200) -> int:
    """Generate deterministic ops for rows that predate replication.

    This is used to bootstrap peers so existing databases converge without
    requiring a manual command.
    """

    migrate_legacy_import_keys(store, limit=2000)
    # Prioritize delete/tombstone ops so peers converge quickly.
    rows = store.conn.execute(
        """
        SELECT mi.*
        FROM memory_items mi
        WHERE (mi.deleted_at IS NOT NULL OR mi.active = 0)
          AND NOT EXISTS (
            SELECT 1
            FROM replication_ops ro
            WHERE ro.entity_type = 'memory_item'
              AND ro.entity_id = mi.import_key
              AND ro.op_type = 'delete'
              AND ro.clock_rev = COALESCE(mi.rev, 0)
          )
        ORDER BY mi.updated_at ASC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()

    remaining = max(0, limit - len(rows))
    if remaining:
        upsert_rows = store.conn.execute(
            """
            SELECT mi.*
            FROM memory_items mi
            WHERE mi.deleted_at IS NULL
              AND mi.active = 1
              AND NOT EXISTS (
                SELECT 1
                FROM replication_ops ro
                WHERE ro.entity_type = 'memory_item'
                  AND ro.entity_id = mi.import_key
                  AND ro.op_type = 'upsert'
                  AND ro.clock_rev = COALESCE(mi.rev, 0)
              )
            ORDER BY mi.updated_at ASC
            LIMIT ?
            """,
            (remaining,),
        ).fetchall()
        rows = [*rows, *upsert_rows]
    count = 0
    for row in rows:
        payload = _memory_item_payload(store, dict(row))
        clock = _clock_from_payload(store, payload)
        import_key = str(payload.get("import_key") or "")
        if not import_key:
            device_row = store.conn.execute("SELECT device_id FROM sync_device LIMIT 1").fetchone()
            device_id = str(device_row["device_id"]) if device_row else ""
            prefix = f"legacy:{device_id}:" if device_id else "legacy:"
            import_key = f"{prefix}memory_item:{row['id']}"
            store.conn.execute(
                "UPDATE memory_items SET import_key = ? WHERE id = ?",
                (import_key, row["id"]),
            )
            store.conn.commit()
        op_type = (
            "delete"
            if payload.get("deleted_at") or int(payload.get("active") or 1) == 0
            else "upsert"
        )
        op_id = f"backfill:memory_item:{import_key}:{clock['rev']}"
        op_id = f"{op_id}:{op_type}"
        if _replication_op_exists(store, op_id):
            continue
        record_replication_op(
            store,
            op_id=op_id,
            entity_type="memory_item",
            entity_id=import_key,
            op_type=op_type,
            payload=payload,
            clock=clock,
            device_id=clock["device_id"],
            created_at=store._now_iso(),
        )
        count += 1
    return count


def _ensure_session_for_replication(
    store: MemoryStore,
    session_id: int,
    started_at: str | None,
    *,
    project: str | None = None,
) -> None:
    row = store.conn.execute(
        "SELECT id, project FROM sessions WHERE id = ?",
        (session_id,),
    ).fetchone()
    if row is not None:
        # Backfill project on existing sessions that lack one.
        if project and (not row["project"] or not str(row["project"]).strip()):
            store.conn.execute(
                "UPDATE sessions SET project = ? WHERE id = ?",
                (project, session_id),
            )
        return
    created_at = started_at or store._now_iso()
    store.conn.execute(
        "INSERT INTO sessions(id, started_at, project) VALUES (?, ?, ?)",
        (session_id, created_at, project),
    )


def _replication_op_exists(store: MemoryStore, op_id: str) -> bool:
    row = store.conn.execute(
        "SELECT 1 FROM replication_ops WHERE op_id = ?",
        (op_id,),
    ).fetchone()
    return row is not None


def record_replication_op(
    store: MemoryStore,
    *,
    op_id: str,
    entity_type: str,
    entity_id: str,
    op_type: str,
    payload: dict[str, Any] | None,
    clock: ReplicationClock,
    device_id: str,
    created_at: str,
) -> None:
    payload_json = None if payload is None else db.to_json(payload)
    store.conn.execute(
        """
        INSERT INTO replication_ops(
            op_id,
            entity_type,
            entity_id,
            op_type,
            payload_json,
            clock_rev,
            clock_updated_at,
            clock_device_id,
            device_id,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            op_id,
            entity_type,
            entity_id,
            op_type,
            payload_json,
            int(clock.get("rev") or 0),
            str(clock.get("updated_at") or ""),
            str(clock.get("device_id") or ""),
            device_id,
            created_at,
        ),
    )
    store.conn.commit()


def load_replication_ops_since(
    store: MemoryStore,
    cursor: str | None,
    limit: int = 100,
    *,
    device_id: str | None = None,
) -> tuple[list[ReplicationOp], str | None]:
    parsed = store._parse_cursor(cursor)
    params: list[Any] = []
    where: list[str] = []
    if parsed:
        created_at, op_id = parsed
        where.append("(created_at > ? OR (created_at = ? AND op_id > ?))")
        params.extend([created_at, created_at, op_id])
    if device_id:
        where.append("(device_id = ? OR device_id = 'local')")
        params.append(device_id)
    where_clause = f"WHERE {' AND '.join(where)}" if where else ""
    rows = store.conn.execute(
        f"""
        SELECT *
        FROM replication_ops
        {where_clause}
        ORDER BY created_at ASC, op_id ASC
        LIMIT ?
        """,
        (*params, limit),
    ).fetchall()
    ops: list[ReplicationOp] = []
    for row in rows:
        payload = db.from_json(row["payload_json"]) if row["payload_json"] else None
        ops.append(
            {
                "op_id": str(row["op_id"]),
                "entity_type": str(row["entity_type"]),
                "entity_id": str(row["entity_id"]),
                "op_type": str(row["op_type"]),
                "payload": payload,
                "clock": {
                    "rev": int(row["clock_rev"]),
                    "updated_at": str(row["clock_updated_at"]),
                    "device_id": str(row["clock_device_id"]),
                },
                "device_id": str(row["device_id"]),
                "created_at": str(row["created_at"]),
            }
        )
    next_cursor = None
    if rows:
        last = rows[-1]
        next_cursor = store_utils.compute_cursor(str(last["created_at"]), str(last["op_id"]))
    return ops, next_cursor


def max_replication_cursor(store: MemoryStore, *, device_id: str | None = None) -> str | None:
    params: list[Any] = []
    where = ""
    if device_id:
        where = "WHERE (device_id = ? OR device_id = 'local')"
        params.append(device_id)
    row = store.conn.execute(
        f"""
        SELECT created_at, op_id
        FROM replication_ops
        {where}
        ORDER BY created_at DESC, op_id DESC
        LIMIT 1
        """,
        (*params,),
    ).fetchone()
    if row is None:
        return None
    return store_utils.compute_cursor(str(row["created_at"]), str(row["op_id"]))


def normalize_outbound_cursor(
    store: MemoryStore, cursor: str | None, *, device_id: str
) -> str | None:
    if not cursor:
        return None
    parsed = store._parse_cursor(cursor)
    if not parsed:
        return None
    max_cursor = max_replication_cursor(store, device_id=device_id)
    if not max_cursor:
        return None
    max_parsed = store._parse_cursor(max_cursor)
    if not max_parsed:
        return None
    if parsed > max_parsed:
        return None
    return cursor


def _legacy_import_key_device_id(key: str) -> str | None:
    if not key.startswith("legacy:"):
        return None
    parts = key.split(":")
    if len(parts) >= 4 and parts[0] == "legacy" and parts[2] == "memory_item":
        return parts[1]
    return None


def _sanitize_inbound_replication_op(
    store: MemoryStore,
    op: ReplicationOp,
    *,
    source_device_id: str | None,
    received_at: dt.datetime | None,
) -> ReplicationOp:
    sanitized: dict[str, Any] = dict(op)
    clock = dict(cast(dict[str, Any], op.get("clock") or {}))
    sanitized["clock"] = clock
    payload_value = op.get("payload")
    if isinstance(payload_value, dict):
        sanitized["payload"] = dict(payload_value)

    op_id = str(sanitized.get("op_id") or "")
    if not op_id:
        raise ValueError("invalid_ops")

    if source_device_id:
        op_device_id = str(sanitized.get("device_id") or "")
        clock_device_id = str(clock.get("device_id") or "")
        if op_device_id != source_device_id or clock_device_id != source_device_id:
            raise ValueError("identity_mismatch")
        if source_device_id != "local" and (op_device_id == "local" or clock_device_id == "local"):
            raise ValueError("identity_mismatch")

        if str(sanitized.get("entity_type") or "") == "memory_item":
            entity_id = str(sanitized.get("entity_id") or "")
            entity_match = LEGACY_IMPORT_KEY_OLD_RE.match(entity_id) if entity_id else None
            if entity_match is not None:
                sanitized["entity_id"] = (
                    f"legacy:{source_device_id}:memory_item:{entity_match.group(1)}"
                )
            payload = sanitized.get("payload")
            if isinstance(payload, dict):
                import_key = str(payload.get("import_key") or "")
                import_match = LEGACY_IMPORT_KEY_OLD_RE.match(import_key) if import_key else None
                if import_match is not None:
                    payload["import_key"] = (
                        f"legacy:{source_device_id}:memory_item:{import_match.group(1)}"
                    )

    created_at = str(sanitized.get("created_at") or "")
    created_parsed = store_utils.parse_iso8601(created_at)
    if created_parsed is None:
        raise ValueError("invalid_timestamp")
    clock_updated_at = str(clock.get("updated_at") or "")
    clock_parsed = store_utils.parse_iso8601(clock_updated_at)
    if clock_parsed is None:
        raise ValueError("invalid_timestamp")
    if received_at is not None:
        max_future = received_at + dt.timedelta(minutes=10)
        if created_parsed > max_future:
            sanitized["created_at"] = received_at.isoformat()
        if clock_parsed > max_future:
            clock["updated_at"] = received_at.isoformat()
    return cast(ReplicationOp, sanitized)


def apply_replication_ops(
    store: MemoryStore,
    ops: list[ReplicationOp],
    *,
    source_device_id: str | None = None,
    received_at: str | None = None,
) -> dict[str, int]:
    inserted = 0
    updated = 0
    skipped = 0

    received_at_dt = None
    if received_at:
        received_at_dt = store_utils.parse_iso8601(received_at)
    with store.conn:
        for op in ops:
            op = _sanitize_inbound_replication_op(
                store, op, source_device_id=source_device_id, received_at=received_at_dt
            )
            op_id = str(op.get("op_id") or "")
            if not op_id or _replication_op_exists(store, op_id):
                skipped += 1
                continue
            payload = op.get("payload")
            clock = cast(ReplicationClock, op.get("clock") or {})
            store.conn.execute(
                """
                INSERT INTO replication_ops(
                    op_id,
                    entity_type,
                    entity_id,
                    op_type,
                    payload_json,
                    clock_rev,
                    clock_updated_at,
                    clock_device_id,
                    device_id,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    op_id,
                    str(op.get("entity_type") or ""),
                    str(op.get("entity_id") or ""),
                    str(op.get("op_type") or ""),
                    None if payload is None else db.to_json(payload),
                    int(clock.get("rev") or 0),
                    str(clock.get("updated_at") or ""),
                    str(clock.get("device_id") or ""),
                    str(op.get("device_id") or ""),
                    str(op.get("created_at") or ""),
                ),
            )

            if op.get("entity_type") != "memory_item":
                skipped += 1
                continue
            op_type = str(op.get("op_type") or "")
            project = None
            payload = op.get("payload") or {}
            if isinstance(payload, dict):
                project_value = payload.get("project")
                project = project_value if isinstance(project_value, str) else None
            if not _sync_project_allowed(store, project, peer_device_id=source_device_id):
                skipped += 1
                continue
            if op_type == "upsert":
                action = _apply_memory_item_upsert(store, op)
            elif op_type == "delete":
                action = _apply_memory_item_delete(store, op)
            else:
                skipped += 1
                continue
            if action == "inserted":
                inserted += 1
            elif action == "updated":
                updated += 1
            else:
                skipped += 1
    return {"inserted": inserted, "updated": updated, "skipped": skipped}


def _apply_memory_item_upsert(store: MemoryStore, op: ReplicationOp) -> str:
    payload = op.get("payload") or {}
    entity_id = str(op.get("entity_id") or "")
    import_key = str(payload.get("import_key") or entity_id)
    session_id = payload.get("session_id")
    if not import_key or session_id is None:
        return "skipped"
    clock = cast(ReplicationClock, op.get("clock") or {})
    clock_device_id = str(clock.get("device_id") or "")
    lookup_key = import_key
    row = store.conn.execute(
        "SELECT * FROM memory_items WHERE import_key = ?",
        (lookup_key,),
    ).fetchone()
    if row is None:
        for alias in _legacy_import_key_aliases(import_key, clock_device_id=clock_device_id):
            candidate = store.conn.execute(
                "SELECT * FROM memory_items WHERE import_key = ?",
                (alias,),
            ).fetchone()
            if candidate is not None:
                row = candidate
                lookup_key = alias
                break
    op_clock = _clock_tuple(clock.get("rev"), clock.get("updated_at"), clock.get("device_id"))
    if row is not None:
        existing = dict(row)
        if not _is_newer_clock(op_clock, _memory_item_clock(store, existing)):
            return "skipped"
    metadata = store._normalize_metadata(payload.get("metadata_json"))
    metadata["clock_device_id"] = clock_device_id
    metadata_json = db.to_json(metadata)
    created_at = str(payload.get("created_at") or clock.get("updated_at") or "")
    updated_at = str(payload.get("updated_at") or clock.get("updated_at") or "")
    project_value = payload.get("project")
    project = project_value if isinstance(project_value, str) and project_value.strip() else None
    _ensure_session_for_replication(store, int(session_id), created_at, project=project)
    values = (
        int(session_id),
        str(payload.get("kind") or ""),
        str(payload.get("title") or ""),
        str(payload.get("body_text") or ""),
        float(payload.get("confidence") or 0.5),
        str(payload.get("tags_text") or ""),
        int(payload.get("active") or 1),
        created_at,
        updated_at,
        metadata_json,
        payload.get("subtitle"),
        payload.get("facts"),
        payload.get("narrative"),
        payload.get("concepts"),
        payload.get("files_read"),
        payload.get("files_modified"),
        payload.get("prompt_number"),
        import_key,
        payload.get("deleted_at"),
        int(clock.get("rev") or payload.get("rev") or 0),
    )
    if row is None:
        store.conn.execute(
            """
            INSERT INTO memory_items(
                session_id,
                kind,
                title,
                body_text,
                confidence,
                tags_text,
                active,
                created_at,
                updated_at,
                metadata_json,
                subtitle,
                facts,
                narrative,
                concepts,
                files_read,
                files_modified,
                prompt_number,
                import_key,
                deleted_at,
                rev
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            values,
        )
        return "inserted"
    store.conn.execute(
        """
        UPDATE memory_items
        SET session_id = ?,
            kind = ?,
            title = ?,
            body_text = ?,
            confidence = ?,
            tags_text = ?,
            active = ?,
            created_at = ?,
            updated_at = ?,
            metadata_json = ?,
            subtitle = ?,
            facts = ?,
            narrative = ?,
            concepts = ?,
            files_read = ?,
            files_modified = ?,
            prompt_number = ?,
            import_key = ?,
            deleted_at = ?,
            rev = ?
        WHERE import_key = ?
        """,
        (*values, lookup_key),
    )
    return "updated"


def _apply_memory_item_delete(store: MemoryStore, op: ReplicationOp) -> str:
    payload = op.get("payload") or {}
    entity_id = str(op.get("entity_id") or "")
    import_key = str(payload.get("import_key") or entity_id)
    if not import_key:
        return "skipped"
    clock = cast(ReplicationClock, op.get("clock") or {})
    clock_device_id = str(clock.get("device_id") or "")
    lookup_key = import_key
    row = store.conn.execute(
        "SELECT * FROM memory_items WHERE import_key = ?",
        (lookup_key,),
    ).fetchone()
    if row is None:
        for alias in _legacy_import_key_aliases(import_key, clock_device_id=clock_device_id):
            candidate = store.conn.execute(
                "SELECT * FROM memory_items WHERE import_key = ?",
                (alias,),
            ).fetchone()
            if candidate is not None:
                row = candidate
                lookup_key = alias
                break
    op_clock = _clock_tuple(clock.get("rev"), clock.get("updated_at"), clock.get("device_id"))
    if row is not None:
        existing = dict(row)
        if not _is_newer_clock(op_clock, _memory_item_clock(store, existing)):
            return "skipped"
    metadata = store._normalize_metadata(payload.get("metadata_json"))
    metadata["clock_device_id"] = clock_device_id
    metadata_json = db.to_json(metadata)
    deleted_at = str(clock.get("updated_at") or payload.get("deleted_at") or "")
    updated_at = deleted_at
    rev = int(clock.get("rev") or payload.get("rev") or 0)
    if row is None:
        session_id = payload.get("session_id")
        if session_id is None:
            return "skipped"
        created_at = str(payload.get("created_at") or deleted_at)
        delete_project_value = payload.get("project")
        delete_project = (
            delete_project_value
            if isinstance(delete_project_value, str) and delete_project_value.strip()
            else None
        )
        _ensure_session_for_replication(store, int(session_id), created_at, project=delete_project)
        store.conn.execute(
            """
            INSERT INTO memory_items(
                session_id,
                kind,
                title,
                body_text,
                confidence,
                tags_text,
                active,
                created_at,
                updated_at,
                metadata_json,
                subtitle,
                facts,
                narrative,
                concepts,
                files_read,
                files_modified,
                prompt_number,
                import_key,
                deleted_at,
                rev
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(session_id),
                str(payload.get("kind") or ""),
                str(payload.get("title") or ""),
                str(payload.get("body_text") or ""),
                float(payload.get("confidence") or 0.5),
                str(payload.get("tags_text") or ""),
                0,
                created_at,
                updated_at,
                metadata_json,
                payload.get("subtitle"),
                payload.get("facts"),
                payload.get("narrative"),
                payload.get("concepts"),
                payload.get("files_read"),
                payload.get("files_modified"),
                payload.get("prompt_number"),
                import_key,
                deleted_at,
                rev,
            ),
        )
        return "inserted"
    store.conn.execute(
        """
        UPDATE memory_items
        SET active = 0,
            deleted_at = ?,
            updated_at = ?,
            metadata_json = ?,
            rev = ?
        WHERE import_key = ?
        """,
        (deleted_at, updated_at, metadata_json, rev, lookup_key),
    )
    return "updated"
