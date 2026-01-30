from __future__ import annotations

import datetime as dt
import json
from typing import cast

from ..store import MemoryStore, ReplicationOp


def chunk_ops_by_size(
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


def get_replication_cursor(
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


def set_replication_cursor(
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


def extract_replication_ops(payload: object) -> list[ReplicationOp]:
    if not isinstance(payload, dict):
        return []
    ops = payload.get("ops")
    if not isinstance(ops, list):
        return []
    return cast(list[ReplicationOp], ops)
