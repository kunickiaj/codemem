from __future__ import annotations

import datetime as dt
import difflib
import hashlib
import json
import math
import os
import re
import sqlite3
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypedDict, cast
from uuid import uuid4

from . import db
from .config import load_config
from .semantic import chunk_text, embed_texts, get_embedding_client, hash_text
from .summarizer import Summary, is_low_signal_observation

LEGACY_IMPORT_KEY_OLD_RE = re.compile(r"^legacy:memory_item:(\d+)$")
LEGACY_IMPORT_KEY_NEW_RE = re.compile(r"^legacy:([^:]+):memory_item:(\d+)$")


@dataclass
class MemoryResult:
    id: int
    kind: str
    title: str
    body_text: str
    confidence: float
    created_at: str
    updated_at: str
    tags_text: str
    score: float
    session_id: int
    metadata: dict[str, Any]


class ReplicationClock(TypedDict):
    rev: int
    updated_at: str
    device_id: str


class ReplicationOp(TypedDict):
    op_id: str
    entity_type: str
    entity_id: str
    op_type: str
    payload: dict[str, Any] | None
    clock: ReplicationClock
    device_id: str
    created_at: str


class MemoryStore:
    RECALL_RECENCY_DAYS = 180
    TASK_RECENCY_DAYS = 365
    FUZZY_CANDIDATE_LIMIT = 200
    FUZZY_MIN_SCORE = 0.18
    SEMANTIC_CANDIDATE_LIMIT = 200
    STOPWORDS = {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "but",
        "by",
        "for",
        "from",
        "has",
        "have",
        "i",
        "in",
        "is",
        "it",
        "me",
        "my",
        "next",
        "of",
        "on",
        "or",
        "our",
        "should",
        "so",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "this",
        "to",
        "up",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "who",
        "with",
        "you",
        "your",
    }

    def _normalize_tag(self, value: str) -> str:
        lowered = (value or "").strip().lower()
        if not lowered:
            return ""
        lowered = re.sub(r"[^a-z0-9_]+", "-", lowered)
        lowered = re.sub(r"-+", "-", lowered).strip("-")
        if not lowered or lowered in self.STOPWORDS:
            return ""
        if len(lowered) > 40:
            lowered = lowered[:40].rstrip("-")
        return lowered

    def _file_tags(self, path_value: str) -> list[str]:
        raw = (path_value or "").strip()
        if not raw:
            return []
        parts = re.split(r"[\\/]+", raw)
        parts = [p for p in parts if p and p not in {".", ".."}]
        if not parts:
            return []
        tags: list[str] = []
        basename = self._normalize_tag(parts[-1])
        if basename:
            tags.append(basename)
        if len(parts) >= 2:
            parent = self._normalize_tag(parts[-2])
            if parent:
                tags.append(parent)
        if len(parts) >= 3:
            top = self._normalize_tag(parts[0])
            if top:
                tags.append(top)
        return tags

    def _derive_tags(
        self,
        *,
        kind: str,
        title: str = "",
        concepts: list[str] | None = None,
        files_read: list[str] | None = None,
        files_modified: list[str] | None = None,
    ) -> list[str]:
        tags: list[str] = []
        kind_tag = self._normalize_tag(kind)
        if kind_tag:
            tags.append(kind_tag)
        for concept in concepts or []:
            normalized = self._normalize_tag(concept)
            if normalized:
                tags.append(normalized)
        for path_value in (files_read or []) + (files_modified or []):
            tags.extend(self._file_tags(path_value))

        if not tags and title:
            for token in re.findall(r"[A-Za-z0-9_]+", title.lower()):
                normalized = self._normalize_tag(token)
                if normalized:
                    tags.append(normalized)

        deduped: list[str] = []
        seen: set[str] = set()
        for tag in tags:
            if tag in seen:
                continue
            seen.add(tag)
            deduped.append(tag)
            if len(deduped) >= 20:
                break
        return deduped

    def _safe_json_list(self, value: str | None) -> list[str]:
        if not value:
            return []
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        if not isinstance(parsed, list):
            return []
        items: list[str] = []
        for item in parsed:
            if isinstance(item, str) and item.strip():
                items.append(item.strip())
        return items

    def __init__(
        self,
        db_path: Path | str = db.DEFAULT_DB_PATH,
        *,
        check_same_thread: bool = True,
    ):
        self.db_path = Path(db_path).expanduser()
        self.conn = db.connect(self.db_path, check_same_thread=check_same_thread)
        db.initialize_schema(self.conn)
        self.device_id = os.getenv("OPENCODE_MEM_DEVICE_ID", "")
        if not self.device_id:
            row = self.conn.execute("SELECT device_id FROM sync_device LIMIT 1").fetchone()
            self.device_id = str(row["device_id"]) if row else "local"

        cfg = load_config()
        self._sync_projects_include = [
            p.strip() for p in cfg.sync_projects_include if p and p.strip()
        ]
        self._sync_projects_exclude = [
            p.strip() for p in cfg.sync_projects_exclude if p and p.strip()
        ]

    def _sync_project_allowed(self, project: str | None) -> bool:
        include = {self._project_basename(p) for p in self._sync_projects_include if p}
        exclude = {self._project_basename(p) for p in self._sync_projects_exclude if p}

        value = None
        if isinstance(project, str) and project.strip():
            value = self._project_basename(project.strip())

        if value and value in exclude:
            return False
        if include:
            return bool(value and value in include)
        return True

    def count_replication_ops_missing_project(self) -> int:
        """Count memory_item replication ops whose payload lacks a usable project.

        When sync include-lists are active, these ops cannot be reliably filtered.
        """

        try:
            row = self.conn.execute(
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
            rows = self.conn.execute(
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
        self, ops: Sequence[ReplicationOp]
    ) -> tuple[list[ReplicationOp], str | None]:
        allowed_ops, next_cursor, _blocked = self.filter_replication_ops_for_sync_with_status(ops)
        return allowed_ops, next_cursor

    def filter_replication_ops_for_sync_with_status(
        self, ops: Sequence[ReplicationOp]
    ) -> tuple[list[ReplicationOp], str | None, dict[str, Any] | None]:
        """Filter outbound replication ops with safe cursor semantics.

        Returns:
        - allowed ops: longest prefix allowed by current include/exclude
        - next_cursor: cursor for the last returned op (never advances past filtered)
        - blocked: metadata for the first blocked op (if any)
        """

        allowed_ops: list[ReplicationOp] = []
        next_cursor: str | None = None
        blocked: dict[str, Any] | None = None
        for op in ops:
            entity_type = str(op.get("entity_type") or "")
            if entity_type == "memory_item":
                project = None
                payload = op.get("payload")
                if isinstance(payload, dict):
                    project_value = payload.get("project")
                    project = project_value if isinstance(project_value, str) else None
                if not self._sync_project_allowed(project):
                    blocked = {
                        "reason": "project_filter",
                        "op_id": str(op.get("op_id") or ""),
                        "created_at": str(op.get("created_at") or ""),
                        "entity_type": entity_type,
                        "entity_id": str(op.get("entity_id") or ""),
                        "project": project,
                    }
                    break
            allowed_ops.append(op)
            next_cursor = self.compute_cursor(
                str(op.get("created_at") or ""), str(op.get("op_id") or "")
            )
        return allowed_ops, next_cursor, blocked

    def migrate_legacy_import_keys(self, *, limit: int = 2000) -> int:
        """Make legacy import_key values globally unique.

        Earlier versions used import keys like `legacy:memory_item:{row_id}`, which collide
        across devices and can cause replication ops to no-op.
        """

        device_row = self.conn.execute("SELECT device_id FROM sync_device LIMIT 1").fetchone()
        device_id = str(device_row["device_id"]) if device_row else ""
        if not device_id:
            return 0

        rows = self.conn.execute(
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
            metadata = self._normalize_metadata(row["metadata_json"])
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
            existing = self.conn.execute(
                "SELECT id FROM memory_items WHERE import_key = ? LIMIT 1",
                (canonical,),
            ).fetchone()
            if existing is not None and int(existing["id"]) != memory_id:
                continue
            self.conn.execute(
                "UPDATE memory_items SET import_key = ? WHERE id = ?",
                (canonical, memory_id),
            )
            updated += 1
        self.conn.commit()
        return updated

    def get_sync_daemon_state(self) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT last_error, last_traceback, last_error_at, last_ok_at FROM sync_daemon_state WHERE id = 1"
        ).fetchone()
        if row is None:
            return None
        return {
            "last_error": row["last_error"],
            "last_traceback": row["last_traceback"],
            "last_error_at": row["last_error_at"],
            "last_ok_at": row["last_ok_at"],
        }

    def set_sync_daemon_error(self, error: str, traceback_text: str) -> None:
        now = self._now_iso()
        self.conn.execute(
            """
            INSERT INTO sync_daemon_state(id, last_error, last_traceback, last_error_at)
            VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                last_error = excluded.last_error,
                last_traceback = excluded.last_traceback,
                last_error_at = excluded.last_error_at
            """,
            (error, traceback_text, now),
        )
        self.conn.commit()

    def set_sync_daemon_ok(self) -> None:
        now = self._now_iso()
        self.conn.execute(
            """
            INSERT INTO sync_daemon_state(id, last_ok_at)
            VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET
                last_ok_at = excluded.last_ok_at
            """,
            (now,),
        )
        self.conn.commit()

    def _legacy_import_key_suffix(self, import_key: str) -> str | None:
        match = LEGACY_IMPORT_KEY_OLD_RE.match(import_key)
        if match:
            return match.group(1)
        match = LEGACY_IMPORT_KEY_NEW_RE.match(import_key)
        if match:
            return match.group(2)
        return None

    def _canonical_legacy_import_key(
        self,
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

    def _legacy_import_key_aliases(self, import_key: str, *, clock_device_id: str) -> list[str]:
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
        self, *, import_key: str, payload: dict[str, Any]
    ) -> None:
        metadata = self._normalize_metadata(payload.get("metadata_json"))
        metadata["clock_device_id"] = self.device_id
        payload = dict(payload)
        payload["metadata_json"] = metadata
        payload["import_key"] = import_key
        payload["active"] = 0
        payload["deleted_at"] = payload.get("deleted_at") or self._now_iso()
        payload["updated_at"] = payload.get("updated_at") or payload["deleted_at"]
        payload["rev"] = int(payload.get("rev") or 0) + 1
        clock = self._clock_from_payload(payload)
        self.record_replication_op(
            op_id=str(uuid4()),
            entity_type="memory_item",
            entity_id=import_key,
            op_type="delete",
            payload=payload,
            clock=clock,
            device_id=clock["device_id"],
            created_at=self._now_iso(),
        )

    def repair_legacy_import_keys(
        self,
        *,
        limit: int = 10000,
        dry_run: bool = False,
    ) -> dict[str, int]:
        """Repair legacy import_key duplication across old/new formats.

        Older databases used `legacy:memory_item:<n>` which collides across devices.
        Newer code uses `legacy:<device_id>:memory_item:<n>`. If a database contains both,
        sync can duplicate the same conceptual memories.
        """

        device_row = self.conn.execute("SELECT device_id FROM sync_device LIMIT 1").fetchone()
        local_device_id = str(device_row["device_id"]) if device_row else self.device_id
        now = self._now_iso()

        rows = self.conn.execute(
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
            metadata = self._normalize_metadata(row["metadata_json"])
            clock_device_id = str(metadata.get("clock_device_id") or "").strip()

            canonical = None
            suffix = self._legacy_import_key_suffix(current)
            if suffix and LEGACY_IMPORT_KEY_OLD_RE.match(current):
                # Prefer any existing new-format key for the same suffix.
                picked = self.conn.execute(
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
                canonical = self._canonical_legacy_import_key(
                    current,
                    clock_device_id=clock_device_id,
                    local_device_id=local_device_id,
                    memory_id=memory_id,
                )
            if not canonical or canonical == current:
                stats["skipped"] += 1
                continue

            canonical_row = self.conn.execute(
                "SELECT * FROM memory_items WHERE import_key = ? LIMIT 1",
                (canonical,),
            ).fetchone()

            if canonical_row is None:
                if dry_run:
                    stats["renamed"] += 1
                    continue
                if current and LEGACY_IMPORT_KEY_OLD_RE.match(current):
                    original = self.conn.execute(
                        "SELECT * FROM memory_items WHERE id = ? LIMIT 1",
                        (memory_id,),
                    ).fetchone()
                    if original is not None:
                        self._record_replication_delete_for_key(
                            import_key=current,
                            payload=self._memory_item_payload(dict(original)),
                        )
                        stats["ops"] += 1
                self.conn.execute(
                    "UPDATE memory_items SET import_key = ?, updated_at = ? WHERE id = ?",
                    (canonical, now, memory_id),
                )
                self.conn.commit()
                self._record_memory_item_op(memory_id, "upsert")
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
                self.conn.execute(
                    "SELECT * FROM memory_items WHERE id = ? LIMIT 1",
                    (memory_id,),
                ).fetchone()
            )
            new_row = dict(canonical_row)
            winner = "canonical"
            if self._is_newer_clock(
                self._memory_item_clock(old_row), self._memory_item_clock(new_row)
            ):
                winner = "old"

            if winner == "old":
                merged_meta = self._normalize_metadata(old_row.get("metadata_json"))
                merged_meta["clock_device_id"] = self.device_id
                merged_json = db.to_json(merged_meta)
                self.conn.execute(
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
                self.conn.commit()
                self._record_memory_item_op(canonical_id, "upsert")
                stats["ops"] += 1

            # Tombstone the old key (so peers delete it) and deactivate locally.
            delete_payload = self._memory_item_payload(old_row)
            self._record_replication_delete_for_key(
                import_key=current or f"memory:{memory_id}", payload=delete_payload
            )
            stats["ops"] += 1
            tombstone_meta = self._normalize_metadata(old_row.get("metadata_json"))
            tombstone_meta["clock_device_id"] = self.device_id
            self.conn.execute(
                "UPDATE memory_items SET active = 0, deleted_at = ?, updated_at = ?, metadata_json = ?, rev = rev + 1 WHERE id = ?",
                (now, now, db.to_json(tombstone_meta), memory_id),
            )
            self.conn.commit()

            stats["merged"] += 1
            stats["tombstoned"] += 1

        return stats

    @staticmethod
    def _now_iso() -> str:
        return dt.datetime.now(dt.UTC).isoformat()

    @staticmethod
    def compute_cursor(created_at: str, op_id: str) -> str:
        return f"{created_at}|{op_id}"

    @staticmethod
    def _parse_cursor(cursor: str | None) -> tuple[str, str] | None:
        if not cursor:
            return None
        if "|" not in cursor:
            return None
        created_at, op_id = cursor.split("|", 1)
        if not created_at or not op_id:
            return None
        return created_at, op_id

    @staticmethod
    def _normalize_metadata(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return dict(value)
        if isinstance(value, str):
            return db.from_json(value)
        return {}

    @staticmethod
    def _clock_tuple(
        rev: int | None, updated_at: str | None, device_id: str | None
    ) -> tuple[int, str, str]:
        return (int(rev or 0), str(updated_at or ""), str(device_id or ""))

    @staticmethod
    def _is_newer_clock(candidate: tuple[int, str, str], existing: tuple[int, str, str]) -> bool:
        return candidate > existing

    def _memory_item_clock(self, row: dict[str, Any]) -> tuple[int, str, str]:
        metadata = self._normalize_metadata(row.get("metadata_json"))
        device_id = str(metadata.get("clock_device_id") or "")
        return self._clock_tuple(row.get("rev"), row.get("updated_at"), device_id)

    def _memory_item_payload(self, row: dict[str, Any]) -> dict[str, Any]:
        metadata = self._normalize_metadata(row.get("metadata_json"))
        session_id = row.get("session_id")
        project = None
        if session_id is not None:
            try:
                session_row = self.conn.execute(
                    "SELECT project FROM sessions WHERE id = ?",
                    (int(session_id),),
                ).fetchone()
                if session_row is not None:
                    raw = session_row["project"]
                    if isinstance(raw, str) and raw.strip():
                        project = self._project_basename(raw.strip())
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

    def _clock_from_payload(self, payload: dict[str, Any]) -> ReplicationClock:
        metadata = self._normalize_metadata(payload.get("metadata_json"))
        device_id = str(metadata.get("clock_device_id") or self.device_id)
        return {
            "rev": int(payload.get("rev") or 0),
            "updated_at": str(payload.get("updated_at") or ""),
            "device_id": device_id,
        }

    def _record_memory_item_op(self, memory_id: int, op_type: str) -> None:
        row = self.conn.execute(
            "SELECT * FROM memory_items WHERE id = ?",
            (memory_id,),
        ).fetchone()
        if row is None:
            return
        payload = self._memory_item_payload(dict(row))
        clock = self._clock_from_payload(payload)
        entity_id = str(payload.get("import_key") or memory_id)
        self.record_replication_op(
            op_id=str(uuid4()),
            entity_type="memory_item",
            entity_id=entity_id,
            op_type=op_type,
            payload=payload,
            clock=clock,
            device_id=clock["device_id"],
            created_at=self._now_iso(),
        )

    def backfill_replication_ops(self, *, limit: int = 200) -> int:
        """Generate deterministic ops for rows that predate replication.

        This is used to bootstrap peers so existing databases converge without
        requiring a manual command.
        """
        self.migrate_legacy_import_keys(limit=2000)
        # Prioritize delete/tombstone ops so peers converge quickly.
        rows = self.conn.execute(
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
            upsert_rows = self.conn.execute(
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
            payload = self._memory_item_payload(dict(row))
            clock = self._clock_from_payload(payload)
            import_key = str(payload.get("import_key") or "")
            if not import_key:
                device_row = self.conn.execute(
                    "SELECT device_id FROM sync_device LIMIT 1"
                ).fetchone()
                device_id = str(device_row["device_id"]) if device_row else ""
                prefix = f"legacy:{device_id}:" if device_id else "legacy:"
                import_key = f"{prefix}memory_item:{row['id']}"
                self.conn.execute(
                    "UPDATE memory_items SET import_key = ? WHERE id = ?",
                    (import_key, row["id"]),
                )
                self.conn.commit()
            op_type = (
                "delete"
                if payload.get("deleted_at") or int(payload.get("active") or 1) == 0
                else "upsert"
            )
            op_id = f"backfill:memory_item:{import_key}:{clock['rev']}"
            op_id = f"{op_id}:{op_type}"
            if self._replication_op_exists(op_id):
                continue
            self.record_replication_op(
                op_id=op_id,
                entity_type="memory_item",
                entity_id=import_key,
                op_type=op_type,
                payload=payload,
                clock=clock,
                device_id=clock["device_id"],
                created_at=self._now_iso(),
            )
            count += 1
        return count

    def _session_discovery_tokens_from_raw_events(self, opencode_session_id: str) -> int:
        row = self.conn.execute(
            """
            SELECT
                COALESCE(
                    SUM(
                        COALESCE(CAST(json_extract(payload_json, '$.usage.input_tokens') AS INTEGER), 0)
                        + COALESCE(CAST(json_extract(payload_json, '$.usage.output_tokens') AS INTEGER), 0)
                        + COALESCE(
                            CAST(json_extract(payload_json, '$.usage.cache_creation_input_tokens') AS INTEGER),
                            0
                        )
                    ),
                    0
                ) AS total_tokens
            FROM raw_events
            WHERE opencode_session_id = ?
              AND event_type = 'assistant_usage'
              AND json_valid(payload_json) = 1
            """,
            (opencode_session_id,),
        ).fetchone()
        if row is None:
            return 0
        return int(row["total_tokens"] or 0)

    def _session_discovery_tokens_by_prompt(self, opencode_session_id: str) -> dict[int, int]:
        rows = self.conn.execute(
            """
            SELECT
                CAST(json_extract(payload_json, '$.prompt_number') AS INTEGER) AS prompt_number,
                COALESCE(
                    SUM(
                        COALESCE(CAST(json_extract(payload_json, '$.usage.input_tokens') AS INTEGER), 0)
                        + COALESCE(CAST(json_extract(payload_json, '$.usage.output_tokens') AS INTEGER), 0)
                        + COALESCE(
                            CAST(json_extract(payload_json, '$.usage.cache_creation_input_tokens') AS INTEGER),
                            0
                        )
                    ),
                    0
                ) AS total_tokens
            FROM raw_events
            WHERE opencode_session_id = ?
              AND event_type = 'assistant_usage'
              AND json_valid(payload_json) = 1
              AND json_extract(payload_json, '$.prompt_number') IS NOT NULL
            GROUP BY CAST(json_extract(payload_json, '$.prompt_number') AS INTEGER)
            """,
            (opencode_session_id,),
        ).fetchall()
        totals: dict[int, int] = {}
        for row in rows:
            try:
                prompt_number = int(row["prompt_number"])
            except (TypeError, ValueError):
                continue
            totals[prompt_number] = int(row["total_tokens"] or 0)
        return totals

    def _session_discovery_tokens_from_transcript(self, session_id: int) -> int:
        row = self.conn.execute(
            """
            SELECT content_text
            FROM artifacts
            WHERE session_id = ? AND kind = 'transcript'
            ORDER BY id DESC
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()
        if row is None:
            return 0
        text = str(row["content_text"] or "")
        if not text.strip():
            return 0
        return self.estimate_tokens(text)

    def _prompt_length_weights(self, session_id: int) -> dict[int, int]:
        rows = self.conn.execute(
            "SELECT prompt_number, prompt_text FROM user_prompts WHERE session_id = ?",
            (session_id,),
        ).fetchall()
        weights: dict[int, int] = {}
        for row in rows:
            value = row["prompt_number"]
            if value is None:
                continue
            try:
                prompt_number = int(value)
            except (TypeError, ValueError):
                continue
            text = str(row["prompt_text"] or "")
            weights[prompt_number] = weights.get(prompt_number, 0) + max(0, len(text))
        return weights

    def _allocate_tokens_by_weight(
        self,
        total_tokens: int,
        *,
        keys: list[int | None],
        weights: dict[int, int],
    ) -> dict[int | None, int]:
        if total_tokens <= 0 or not keys:
            return {key: 0 for key in keys}

        normalized: dict[int | None, int] = {}
        for key in keys:
            if key is None:
                normalized[key] = 1
            else:
                normalized[key] = max(0, int(weights.get(key, 1) or 1))

        weight_total = sum(normalized.values())
        if weight_total <= 0:
            normalized = {key: 1 for key in keys}
            weight_total = len(keys)

        base: dict[int | None, int] = {}
        remainders: list[tuple[int, str, int | None]] = []
        for key in keys:
            numerator = total_tokens * normalized[key]
            base[key] = numerator // weight_total
            remainder = numerator % weight_total
            stable = "unknown" if key is None else str(key)
            remainders.append((int(remainder), stable, key))

        remaining = total_tokens - sum(base.values())
        if remaining > 0:
            remainders.sort(key=lambda item: (item[0], item[1]), reverse=True)
            for _, __, key in remainders[:remaining]:
                base[key] += 1
        return base

    def backfill_discovery_tokens(self, *, limit_sessions: int = 50) -> int:
        """Backfill discovery_group + discovery_tokens for observer memories.

        Best effort uses raw assistant_usage events when possible; otherwise it falls back to
        session transcript estimates and prompt length weighting.
        """

        target_rows = self.conn.execute(
            """
            SELECT DISTINCT s.id AS session_id, os.opencode_session_id AS opencode_session_id
            FROM sessions s
            JOIN opencode_sessions os ON os.session_id = s.id
            JOIN memory_items mi ON mi.session_id = s.id
            WHERE json_valid(mi.metadata_json) = 1
              AND json_extract(mi.metadata_json, '$.source') = 'observer'
              AND (
                json_extract(mi.metadata_json, '$.discovery_group') IS NULL
              )
            ORDER BY s.id DESC
            LIMIT ?
            """,
            (limit_sessions,),
        ).fetchall()

        updated = 0
        for row in target_rows:
            session_id = int(row["session_id"])
            opencode_session_id = str(row["opencode_session_id"] or "").strip()
            if not opencode_session_id:
                continue

            items = self.conn.execute(
                "SELECT id, prompt_number, metadata_json FROM memory_items WHERE session_id = ?",
                (session_id,),
            ).fetchall()
            if not items:
                continue

            grouped: dict[int | None, list[tuple[int, dict[str, Any]]]] = {}
            for item in items:
                meta = db.from_json(item["metadata_json"])
                if str(meta.get("source") or "") != "observer":
                    continue
                pn = item["prompt_number"]
                if pn is None:
                    pn_meta = meta.get("prompt_number")
                    try:
                        pn = int(pn_meta) if pn_meta is not None else None
                    except (TypeError, ValueError):
                        pn = None
                prompt_number: int | None
                try:
                    prompt_number = int(pn) if pn is not None else None
                except (TypeError, ValueError):
                    prompt_number = None
                grouped.setdefault(prompt_number, []).append((int(item["id"]), meta))

            if not grouped:
                continue

            by_prompt = self._session_discovery_tokens_by_prompt(opencode_session_id)
            session_tokens = self._session_discovery_tokens_from_raw_events(opencode_session_id)
            source_label = "usage" if session_tokens > 0 else "estimate"
            if session_tokens <= 0:
                session_tokens = self._session_discovery_tokens_from_transcript(session_id)

            group_tokens: dict[int | None, int] = {}
            keys = sorted(grouped.keys(), key=lambda k: (-1 if k is None else k))
            if by_prompt:
                assigned = 0
                for key in keys:
                    if key is None:
                        continue
                    group_tokens[key] = int(by_prompt.get(key, 0) or 0)
                    assigned += group_tokens[key]
                if None in grouped:
                    group_tokens[None] = max(0, int(session_tokens) - assigned)
            else:
                if session_tokens > 0:
                    weights = self._prompt_length_weights(session_id)
                    allocation = self._allocate_tokens_by_weight(
                        int(session_tokens),
                        keys=keys,
                        weights=weights,
                    )
                    group_tokens.update({k: int(v) for k, v in allocation.items()})
                else:
                    # Last resort: use whatever discovery_tokens already exist on items.
                    # Older databases may not have raw_events or transcript artifacts.
                    source_label = "fallback"
                    for key in keys:
                        total = 0
                        for _, meta in grouped.get(key, []):
                            try:
                                total += int(meta.get("discovery_tokens") or 0)
                            except (TypeError, ValueError):
                                continue
                        group_tokens[key] = max(0, int(total))

            now = self._now_iso()
            for key, group_items in grouped.items():
                if key is None:
                    group_id = f"{opencode_session_id}:unknown"
                else:
                    group_id = f"{opencode_session_id}:p{key}"
                tokens_value = group_tokens.get(key)
                tokens = int(tokens_value) if isinstance(tokens_value, int) else 0
                for memory_id, meta in group_items:
                    existing_version = 0
                    existing_version_raw = meta.get("discovery_backfill_version")
                    if existing_version_raw is not None:
                        try:
                            existing_version = int(existing_version_raw)
                        except (TypeError, ValueError):
                            existing_version = 0
                    existing_tokens = None
                    existing_tokens_raw = meta.get("discovery_tokens")
                    if existing_tokens_raw is not None:
                        try:
                            existing_tokens = int(existing_tokens_raw)
                        except (TypeError, ValueError):
                            existing_tokens = None
                    if (
                        existing_version >= 2
                        and meta.get("discovery_group") == group_id
                        and existing_tokens == tokens
                        and meta.get("discovery_source") == source_label
                    ):
                        continue
                    meta["discovery_group"] = group_id
                    meta["discovery_tokens"] = tokens
                    meta["discovery_source"] = source_label
                    meta["discovery_backfill_version"] = 2
                    self.conn.execute(
                        "UPDATE memory_items SET metadata_json = ?, updated_at = ? WHERE id = ?",
                        (db.to_json(meta), now, memory_id),
                    )
                    updated += 1
            self.conn.commit()

        return updated

    def work_investment_tokens_sum(self, project: str | None = None) -> int:
        join = ""
        where = ""
        params: list[Any] = []
        if project:
            clause, clause_params = self._project_clause(project)
            if clause:
                join = " JOIN sessions ON sessions.id = memory_items.session_id"
                where = f" WHERE {clause}"
                params.extend(clause_params)
        row = self.conn.execute(
            f"""
            SELECT
                COALESCE(
                    SUM(
                        COALESCE(
                            CASE
                                WHEN json_valid(memory_items.metadata_json) = 1
                                THEN CAST(
                                    json_extract(memory_items.metadata_json, '$.discovery_tokens') AS INTEGER
                                )
                                ELSE 0
                            END,
                            0
                        )
                    ),
                    0
                ) AS total
            FROM memory_items{join}{where}
            """,
            (*params,),
        ).fetchone()
        if row is None:
            return 0
        return int(row["total"] or 0)

    def work_investment_tokens(self, project: str | None = None) -> int:
        """Additive work investment from unique discovery_group values."""

        join = ""
        where_project = ""
        params: list[Any] = []
        if project:
            clause, clause_params = self._project_clause(project)
            if clause:
                join = " JOIN sessions ON sessions.id = memory_items.session_id"
                where_project = f" AND {clause}"
                params.extend(clause_params)

        group_rows = self.conn.execute(
            f"""
            SELECT
                json_extract(memory_items.metadata_json, '$.discovery_group') AS grp,
                MAX(
                    COALESCE(
                        CAST(json_extract(memory_items.metadata_json, '$.discovery_tokens') AS INTEGER),
                        0
                    )
                ) AS tokens
            FROM memory_items{join}
            WHERE json_valid(memory_items.metadata_json) = 1
              AND json_extract(memory_items.metadata_json, '$.discovery_group') IS NOT NULL{where_project}
            GROUP BY json_extract(memory_items.metadata_json, '$.discovery_group')
            """,
            (*params,),
        ).fetchall()
        grouped_total = sum(int(row["tokens"] or 0) for row in group_rows)

        ungrouped_row = self.conn.execute(
            f"""
            SELECT
                COALESCE(
                    SUM(
                        COALESCE(
                            CAST(json_extract(memory_items.metadata_json, '$.discovery_tokens') AS INTEGER),
                            0
                        )
                    ),
                    0
                ) AS tokens
            FROM memory_items{join}
            WHERE json_valid(memory_items.metadata_json) = 1
              AND json_extract(memory_items.metadata_json, '$.discovery_group') IS NULL{where_project}
            """,
            (*params,),
        ).fetchone()
        ungrouped_total = int(ungrouped_row["tokens"] or 0) if ungrouped_row else 0
        return grouped_total + ungrouped_total

    def _ensure_session_for_replication(self, session_id: int, started_at: str | None) -> None:
        row = self.conn.execute(
            "SELECT 1 FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if row is not None:
            return
        created_at = started_at or self._now_iso()
        self.conn.execute(
            "INSERT INTO sessions(id, started_at) VALUES (?, ?)",
            (session_id, created_at),
        )

    def _replication_op_exists(self, op_id: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM replication_ops WHERE op_id = ?",
            (op_id,),
        ).fetchone()
        return row is not None

    def record_replication_op(
        self,
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
        self.conn.execute(
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
        self.conn.commit()

    def load_replication_ops_since(
        self, cursor: str | None, limit: int = 100, *, device_id: str | None = None
    ) -> tuple[list[ReplicationOp], str | None]:
        parsed = self._parse_cursor(cursor)
        params: list[Any] = []
        where: list[str] = []
        if parsed:
            created_at, op_id = parsed
            where.append("created_at > ? OR (created_at = ? AND op_id > ?)")
            params.extend([created_at, created_at, op_id])
        if device_id:
            where.append("(device_id = ? OR device_id = 'local')")
            params.append(device_id)
        where_clause = f"WHERE {' AND '.join(where)}" if where else ""
        rows = self.conn.execute(
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
            next_cursor = self.compute_cursor(str(last["created_at"]), str(last["op_id"]))
        return ops, next_cursor

    def max_replication_cursor(self, *, device_id: str | None = None) -> str | None:
        params: list[Any] = []
        where = ""
        if device_id:
            where = "WHERE (device_id = ? OR device_id = 'local')"
            params.append(device_id)
        row = self.conn.execute(
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
        return self.compute_cursor(str(row["created_at"]), str(row["op_id"]))

    def normalize_outbound_cursor(self, cursor: str | None, *, device_id: str) -> str | None:
        if not cursor:
            return None
        parsed = self._parse_cursor(cursor)
        if not parsed:
            return None
        max_cursor = self.max_replication_cursor(device_id=device_id)
        if not max_cursor:
            return None
        max_parsed = self._parse_cursor(max_cursor)
        if not max_parsed:
            return None
        if parsed > max_parsed:
            return None
        return cursor

    def _parse_iso8601(self, value: str) -> dt.datetime | None:
        raw = value.strip()
        if not raw:
            return None
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        try:
            parsed = dt.datetime.fromisoformat(raw)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.UTC)
        return parsed.astimezone(dt.UTC)

    def _legacy_import_key_device_id(self, key: str) -> str | None:
        if not key.startswith("legacy:"):
            return None
        parts = key.split(":")
        if len(parts) >= 4 and parts[0] == "legacy" and parts[2] == "memory_item":
            return parts[1]
        return None

    def _sanitize_inbound_replication_op(
        self,
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
            if source_device_id != "local" and (
                op_device_id == "local" or clock_device_id == "local"
            ):
                raise ValueError("identity_mismatch")
            entity_id = str(sanitized.get("entity_id") or "")
            import_key = ""
            payload = sanitized.get("payload")
            if isinstance(payload, dict):
                import_key = str(payload.get("import_key") or "")
            candidate_keys = [k for k in [entity_id, import_key] if k]
            for key in candidate_keys:
                prefix_device_id = self._legacy_import_key_device_id(key)
                if prefix_device_id and prefix_device_id != source_device_id:
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
                    import_match = (
                        LEGACY_IMPORT_KEY_OLD_RE.match(import_key) if import_key else None
                    )
                    if import_match is not None:
                        payload["import_key"] = (
                            f"legacy:{source_device_id}:memory_item:{import_match.group(1)}"
                        )

        created_at = str(sanitized.get("created_at") or "")
        created_parsed = self._parse_iso8601(created_at)
        if created_parsed is None:
            raise ValueError("invalid_timestamp")
        clock_updated_at = str(clock.get("updated_at") or "")
        clock_parsed = self._parse_iso8601(clock_updated_at)
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
        self,
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
            received_at_dt = self._parse_iso8601(received_at)
        with self.conn:
            for op in ops:
                op = self._sanitize_inbound_replication_op(
                    op, source_device_id=source_device_id, received_at=received_at_dt
                )
                op_id = str(op.get("op_id") or "")
                if not op_id or self._replication_op_exists(op_id):
                    skipped += 1
                    continue
                payload = op.get("payload")
                clock = cast(ReplicationClock, op.get("clock") or {})
                self.conn.execute(
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
                if not self._sync_project_allowed(project):
                    skipped += 1
                    continue
                if op_type == "upsert":
                    action = self._apply_memory_item_upsert(op)
                elif op_type == "delete":
                    action = self._apply_memory_item_delete(op)
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

    def _apply_memory_item_upsert(self, op: ReplicationOp) -> str:
        payload = op.get("payload") or {}
        entity_id = str(op.get("entity_id") or "")
        import_key = str(payload.get("import_key") or entity_id)
        session_id = payload.get("session_id")
        if not import_key or session_id is None:
            return "skipped"
        clock = cast(ReplicationClock, op.get("clock") or {})
        clock_device_id = str(clock.get("device_id") or "")
        lookup_key = import_key
        row = self.conn.execute(
            "SELECT * FROM memory_items WHERE import_key = ?",
            (lookup_key,),
        ).fetchone()
        if row is None:
            for alias in self._legacy_import_key_aliases(
                import_key, clock_device_id=clock_device_id
            ):
                candidate = self.conn.execute(
                    "SELECT * FROM memory_items WHERE import_key = ?",
                    (alias,),
                ).fetchone()
                if candidate is not None:
                    row = candidate
                    lookup_key = alias
                    break
        op_clock = self._clock_tuple(
            clock.get("rev"), clock.get("updated_at"), clock.get("device_id")
        )
        if row is not None:
            existing = dict(row)
            if not self._is_newer_clock(op_clock, self._memory_item_clock(existing)):
                return "skipped"
        metadata = self._normalize_metadata(payload.get("metadata_json"))
        metadata["clock_device_id"] = clock_device_id
        metadata_json = db.to_json(metadata)
        created_at = str(payload.get("created_at") or clock.get("updated_at") or "")
        updated_at = str(payload.get("updated_at") or clock.get("updated_at") or "")
        self._ensure_session_for_replication(int(session_id), created_at)
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
            self.conn.execute(
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
        self.conn.execute(
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

    def _apply_memory_item_delete(self, op: ReplicationOp) -> str:
        payload = op.get("payload") or {}
        entity_id = str(op.get("entity_id") or "")
        import_key = str(payload.get("import_key") or entity_id)
        if not import_key:
            return "skipped"
        clock = cast(ReplicationClock, op.get("clock") or {})
        clock_device_id = str(clock.get("device_id") or "")
        lookup_key = import_key
        row = self.conn.execute(
            "SELECT * FROM memory_items WHERE import_key = ?",
            (lookup_key,),
        ).fetchone()
        if row is None:
            for alias in self._legacy_import_key_aliases(
                import_key, clock_device_id=clock_device_id
            ):
                candidate = self.conn.execute(
                    "SELECT * FROM memory_items WHERE import_key = ?",
                    (alias,),
                ).fetchone()
                if candidate is not None:
                    row = candidate
                    lookup_key = alias
                    break
        op_clock = self._clock_tuple(
            clock.get("rev"), clock.get("updated_at"), clock.get("device_id")
        )
        if row is not None:
            existing = dict(row)
            if not self._is_newer_clock(op_clock, self._memory_item_clock(existing)):
                return "skipped"
        metadata = self._normalize_metadata(payload.get("metadata_json"))
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
            self._ensure_session_for_replication(int(session_id), created_at)
            self.conn.execute(
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
        self.conn.execute(
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

    def start_session(
        self,
        cwd: str,
        git_remote: str | None,
        git_branch: str | None,
        user: str,
        tool_version: str,
        project: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        now = dt.datetime.now(dt.UTC).isoformat()
        import_key = None
        if metadata and metadata.get("import_key"):
            import_key = metadata.get("import_key")
        cur = self.conn.execute(
            """
            INSERT INTO sessions(
                started_at, cwd, project, git_remote, git_branch, user, tool_version, metadata_json, import_key
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                now,
                cwd,
                project,
                git_remote,
                git_branch,
                user,
                tool_version,
                db.to_json(metadata),
                import_key,
            ),
        )
        self.conn.commit()
        lastrowid = cur.lastrowid
        if lastrowid is None:
            raise RuntimeError("Failed to create session")
        return int(lastrowid)

    def get_or_create_opencode_session(
        self,
        *,
        opencode_session_id: str,
        cwd: str,
        project: str | None,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        row = self.conn.execute(
            "SELECT session_id FROM opencode_sessions WHERE opencode_session_id = ?",
            (opencode_session_id,),
        ).fetchone()
        if row is not None and row["session_id"] is not None:
            return int(row["session_id"])

        session_id = self.start_session(
            cwd=cwd,
            project=project,
            git_remote=None,
            git_branch=None,
            user=os.environ.get("USER", "unknown"),
            tool_version="raw_events",
            metadata=metadata,
        )
        created_at = dt.datetime.now(dt.UTC).isoformat()
        self.conn.execute(
            """
            INSERT INTO opencode_sessions(opencode_session_id, session_id, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(opencode_session_id) DO UPDATE SET session_id = excluded.session_id
            """,
            (opencode_session_id, session_id, created_at),
        )
        self.conn.commit()
        return session_id

    def get_or_create_raw_event_flush_batch(
        self,
        *,
        opencode_session_id: str,
        start_event_seq: int,
        end_event_seq: int,
        extractor_version: str,
    ) -> tuple[int, str]:
        now = dt.datetime.now(dt.UTC).isoformat()
        cur = self.conn.execute(
            """
            INSERT INTO raw_event_flush_batches(
                opencode_session_id,
                start_event_seq,
                end_event_seq,
                extractor_version,
                status,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, 'started', ?, ?)
            ON CONFLICT(opencode_session_id, start_event_seq, end_event_seq, extractor_version)
            DO UPDATE SET updated_at = excluded.updated_at
            RETURNING id, status
            """,
            (opencode_session_id, start_event_seq, end_event_seq, extractor_version, now, now),
        )
        row = cur.fetchone()
        if row is None:
            raise RuntimeError("Failed to create flush batch")
        self.conn.commit()
        return int(row["id"]), str(row["status"])

    def update_raw_event_flush_batch_status(self, batch_id: int, status: str) -> None:
        now = dt.datetime.now(dt.UTC).isoformat()
        self.conn.execute(
            "UPDATE raw_event_flush_batches SET status = ?, updated_at = ? WHERE id = ?",
            (status, now, batch_id),
        )
        self.conn.commit()

    def record_raw_event(
        self,
        *,
        opencode_session_id: str,
        event_id: str,
        event_type: str,
        payload: dict[str, Any],
        ts_wall_ms: int | None = None,
        ts_mono_ms: float | None = None,
    ) -> bool:
        if not opencode_session_id.strip():
            raise ValueError("opencode_session_id is required")
        if not event_id.strip():
            raise ValueError("event_id is required")
        if not event_type.strip():
            raise ValueError("event_type is required")

        # Server-assigned sequencing. This avoids event_seq collisions when the plugin reloads.
        cur = self.conn.execute(
            "SELECT 1 FROM raw_events WHERE opencode_session_id = ? AND event_id = ?",
            (opencode_session_id, event_id),
        ).fetchone()
        if cur is not None:
            return False

        existing = self.conn.execute(
            "SELECT 1 FROM raw_event_sessions WHERE opencode_session_id = ?",
            (opencode_session_id,),
        ).fetchone()
        if existing is None:
            now = dt.datetime.now(dt.UTC).isoformat()
            self.conn.execute(
                """
                INSERT INTO raw_event_sessions(opencode_session_id, updated_at)
                VALUES (?, ?)
                """,
                (opencode_session_id, now),
            )

        row = self.conn.execute(
            """
            UPDATE raw_event_sessions
            SET last_received_event_seq = last_received_event_seq + 1,
                updated_at = ?
            WHERE opencode_session_id = ?
            RETURNING last_received_event_seq
            """,
            (dt.datetime.now(dt.UTC).isoformat(), opencode_session_id),
        ).fetchone()
        if row is None:
            raise RuntimeError("Failed to allocate raw event seq")
        event_seq = int(row["last_received_event_seq"])

        created_at = dt.datetime.now(dt.UTC).isoformat()
        self.conn.execute(
            """
            INSERT INTO raw_events(
                opencode_session_id,
                event_id,
                event_seq,
                event_type,
                ts_wall_ms,
                ts_mono_ms,
                payload_json,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                opencode_session_id,
                event_id,
                event_seq,
                event_type,
                ts_wall_ms,
                ts_mono_ms,
                db.to_json(payload),
                created_at,
            ),
        )
        self.conn.commit()
        return True

    def record_raw_events_batch(
        self,
        *,
        opencode_session_id: str,
        events: list[dict[str, Any]],
    ) -> dict[str, int]:
        if not opencode_session_id.strip():
            raise ValueError("opencode_session_id is required")
        inserted = 0
        skipped = 0
        now = dt.datetime.now(dt.UTC).isoformat()
        with self.conn:
            existing = self.conn.execute(
                "SELECT 1 FROM raw_event_sessions WHERE opencode_session_id = ?",
                (opencode_session_id,),
            ).fetchone()
            if existing is None:
                self.conn.execute(
                    "INSERT INTO raw_event_sessions(opencode_session_id, updated_at) VALUES (?, ?)",
                    (opencode_session_id, now),
                )

            normalized: list[dict[str, Any]] = []
            seen_ids: set[str] = set()
            for event in events:
                event_id = str(event.get("event_id") or "")
                event_type = str(event.get("event_type") or "")
                payload = event.get("payload")
                if not isinstance(payload, dict):
                    payload = {}
                ts_wall_ms = event.get("ts_wall_ms")
                ts_mono_ms = event.get("ts_mono_ms")
                if not event_id or not event_type:
                    skipped += 1
                    continue
                if event_id in seen_ids:
                    skipped += 1
                    continue
                seen_ids.add(event_id)
                normalized.append(
                    {
                        "event_id": event_id,
                        "event_type": event_type,
                        "payload": payload,
                        "ts_wall_ms": ts_wall_ms,
                        "ts_mono_ms": ts_mono_ms,
                    }
                )

            if not normalized:
                return {"inserted": 0, "skipped": skipped}

            existing_ids: set[str] = set()
            chunk_size = 500
            for i in range(0, len(normalized), chunk_size):
                chunk = normalized[i : i + chunk_size]
                placeholders = ",".join("?" for _ in chunk)
                rows = self.conn.execute(
                    f"SELECT event_id FROM raw_events WHERE opencode_session_id = ? AND event_id IN ({placeholders})",
                    [opencode_session_id, *[e["event_id"] for e in chunk]],
                ).fetchall()
                for row in rows:
                    existing_ids.add(str(row["event_id"]))

            new_events = [event for event in normalized if event["event_id"] not in existing_ids]
            skipped += len(normalized) - len(new_events)
            if not new_events:
                return {"inserted": 0, "skipped": skipped}

            row = self.conn.execute(
                """
                UPDATE raw_event_sessions
                SET last_received_event_seq = last_received_event_seq + ?,
                    updated_at = ?
                WHERE opencode_session_id = ?
                RETURNING last_received_event_seq
                """,
                (len(new_events), now, opencode_session_id),
            ).fetchone()
            if row is None:
                raise RuntimeError("Failed to allocate raw event seq")
            end_seq = int(row["last_received_event_seq"])
            start_seq = end_seq - len(new_events) + 1

            for offset, event in enumerate(new_events):
                try:
                    self.conn.execute(
                        """
                        INSERT INTO raw_events(
                            opencode_session_id,
                            event_id,
                            event_seq,
                            event_type,
                            ts_wall_ms,
                            ts_mono_ms,
                            payload_json,
                            created_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            opencode_session_id,
                            event["event_id"],
                            start_seq + offset,
                            event["event_type"],
                            event["ts_wall_ms"],
                            event["ts_mono_ms"],
                            db.to_json(event["payload"]),
                            now,
                        ),
                    )
                except sqlite3.IntegrityError:
                    skipped += 1
                    continue
                inserted += 1
        return {"inserted": inserted, "skipped": skipped}

    def raw_event_flush_state(self, opencode_session_id: str) -> int:
        row = self.conn.execute(
            "SELECT last_flushed_event_seq FROM raw_event_sessions WHERE opencode_session_id = ?",
            (opencode_session_id,),
        ).fetchone()
        if row is None:
            return -1
        return int(row["last_flushed_event_seq"])

    def update_raw_event_session_meta(
        self,
        *,
        opencode_session_id: str,
        cwd: str | None = None,
        project: str | None = None,
        started_at: str | None = None,
        last_seen_ts_wall_ms: int | None = None,
    ) -> None:
        now = dt.datetime.now(dt.UTC).isoformat()
        self.conn.execute(
            """
            INSERT INTO raw_event_sessions(
                opencode_session_id,
                cwd,
                project,
                started_at,
                last_seen_ts_wall_ms,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(opencode_session_id) DO UPDATE SET
                cwd = COALESCE(excluded.cwd, raw_event_sessions.cwd),
                project = COALESCE(excluded.project, raw_event_sessions.project),
                started_at = COALESCE(excluded.started_at, raw_event_sessions.started_at),
                last_seen_ts_wall_ms = COALESCE(excluded.last_seen_ts_wall_ms, raw_event_sessions.last_seen_ts_wall_ms),
                updated_at = excluded.updated_at
            """,
            (opencode_session_id, cwd, project, started_at, last_seen_ts_wall_ms, now),
        )
        self.conn.commit()

    def raw_event_session_meta(self, opencode_session_id: str) -> dict[str, Any]:
        row = self.conn.execute(
            """
            SELECT cwd, project, started_at, last_seen_ts_wall_ms, last_flushed_event_seq
            FROM raw_event_sessions
            WHERE opencode_session_id = ?
            """,
            (opencode_session_id,),
        ).fetchone()
        if row is None:
            return {}
        return {
            "cwd": row["cwd"],
            "project": row["project"],
            "started_at": row["started_at"],
            "last_seen_ts_wall_ms": row["last_seen_ts_wall_ms"],
            "last_flushed_event_seq": row["last_flushed_event_seq"],
        }

    def update_raw_event_flush_state(self, opencode_session_id: str, last_flushed: int) -> None:
        now = dt.datetime.now(dt.UTC).isoformat()
        self.conn.execute(
            """
            INSERT INTO raw_event_sessions(opencode_session_id, last_flushed_event_seq, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(opencode_session_id) DO UPDATE SET
                last_flushed_event_seq = excluded.last_flushed_event_seq,
                updated_at = excluded.updated_at
            """,
            (opencode_session_id, last_flushed, now),
        )
        self.conn.commit()

    def max_raw_event_seq(self, opencode_session_id: str) -> int:
        row = self.conn.execute(
            "SELECT MAX(event_seq) AS max_seq FROM raw_events WHERE opencode_session_id = ?",
            (opencode_session_id,),
        ).fetchone()
        if row is None:
            return -1
        value = row["max_seq"]
        return int(value) if value is not None else -1

    def raw_events_since(
        self,
        *,
        opencode_session_id: str,
        after_event_seq: int,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        limit_clause = "LIMIT ?" if limit else ""
        params: list[Any] = [opencode_session_id, after_event_seq]
        if limit:
            params.append(limit)
        rows = self.conn.execute(
            f"""
            SELECT event_seq, event_type, ts_wall_ms, ts_mono_ms, payload_json, event_id
            FROM raw_events
            WHERE opencode_session_id = ? AND event_seq > ?
            ORDER BY (ts_mono_ms IS NULL) ASC, ts_mono_ms ASC, event_seq ASC
            {limit_clause}
            """,
            params,
        ).fetchall()
        results: list[dict[str, Any]] = []
        for row in rows:
            payload = db.from_json(row["payload_json"])
            if not isinstance(payload, dict):
                payload = {}
            payload["type"] = payload.get("type") or row["event_type"]
            payload["timestamp_wall_ms"] = row["ts_wall_ms"]
            payload["timestamp_mono_ms"] = row["ts_mono_ms"]
            payload["event_seq"] = row["event_seq"]
            payload["event_id"] = row["event_id"]
            results.append(payload)
        return results

    def raw_event_sessions_pending_idle_flush(
        self,
        *,
        idle_before_ts_wall_ms: int,
        limit: int = 25,
    ) -> list[str]:
        rows = self.conn.execute(
            """
            WITH max_events AS (
                SELECT opencode_session_id, MAX(event_seq) AS max_seq
                FROM raw_events
                GROUP BY opencode_session_id
            )
            SELECT s.opencode_session_id
            FROM raw_event_sessions s
            JOIN max_events e ON e.opencode_session_id = s.opencode_session_id
            WHERE s.last_seen_ts_wall_ms IS NOT NULL
              AND s.last_seen_ts_wall_ms <= ?
              AND e.max_seq > s.last_flushed_event_seq
            ORDER BY s.last_seen_ts_wall_ms ASC
            LIMIT ?
            """,
            (idle_before_ts_wall_ms, limit),
        ).fetchall()
        return [str(row["opencode_session_id"]) for row in rows if row["opencode_session_id"]]

    def purge_raw_events_before(self, cutoff_ts_wall_ms: int) -> int:
        cur = self.conn.execute(
            "DELETE FROM raw_events WHERE ts_wall_ms IS NOT NULL AND ts_wall_ms < ?",
            (cutoff_ts_wall_ms,),
        )
        self.conn.commit()
        return int(cur.rowcount or 0)

    def purge_raw_events(self, max_age_ms: int) -> int:
        if max_age_ms <= 0:
            return 0
        now_ms = int(time.time() * 1000)
        cutoff = now_ms - max_age_ms
        return self.purge_raw_events_before(cutoff)

    def raw_event_backlog(self, *, limit: int = 25) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            WITH max_events AS (
                SELECT opencode_session_id, MAX(event_seq) AS max_seq
                FROM raw_events
                GROUP BY opencode_session_id
            )
            SELECT
              s.opencode_session_id,
              s.project,
              s.cwd,
              s.started_at,
              s.last_seen_ts_wall_ms,
              s.last_flushed_event_seq,
              e.max_seq,
              (e.max_seq - s.last_flushed_event_seq) AS pending
            FROM raw_event_sessions s
            JOIN max_events e ON e.opencode_session_id = s.opencode_session_id
            WHERE e.max_seq > s.last_flushed_event_seq
            ORDER BY s.last_seen_ts_wall_ms DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]

    def raw_event_backlog_totals(self) -> dict[str, int]:
        row = self.conn.execute(
            """
            WITH max_events AS (
                SELECT opencode_session_id, MAX(event_seq) AS max_seq
                FROM raw_events
                GROUP BY opencode_session_id
            )
            SELECT
              COUNT(1) AS sessions,
              SUM(e.max_seq - s.last_flushed_event_seq) AS pending
            FROM raw_event_sessions s
            JOIN max_events e ON e.opencode_session_id = s.opencode_session_id
            WHERE e.max_seq > s.last_flushed_event_seq
            """
        ).fetchone()
        if row is None:
            return {"sessions": 0, "pending": 0}
        sessions = int(row["sessions"] or 0)
        pending = int(row["pending"] or 0)
        return {"sessions": sessions, "pending": pending}

    def raw_event_batch_status_counts(self, opencode_session_id: str) -> dict[str, int]:
        rows = self.conn.execute(
            """
            SELECT status, COUNT(*) AS n
            FROM raw_event_flush_batches
            WHERE opencode_session_id = ?
            GROUP BY status
            """,
            (opencode_session_id,),
        ).fetchall()
        counts = {"started": 0, "running": 0, "completed": 0, "error": 0}
        for row in rows:
            status = str(row["status"] or "")
            if status in counts:
                counts[status] = int(row["n"])
        return counts

    def claim_raw_event_flush_batch(self, batch_id: int) -> bool:
        now = dt.datetime.now(dt.UTC).isoformat()
        row = self.conn.execute(
            """
            UPDATE raw_event_flush_batches
            SET status = 'running', updated_at = ?
            WHERE id = ? AND status IN ('started', 'error')
            RETURNING id
            """,
            (now, batch_id),
        ).fetchone()
        self.conn.commit()
        return row is not None

    def raw_event_error_batches(
        self, opencode_session_id: str, limit: int = 10
    ) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT id, start_event_seq, end_event_seq, extractor_version, status, updated_at
            FROM raw_event_flush_batches
            WHERE opencode_session_id = ? AND status = 'error'
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (opencode_session_id, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def mark_stuck_raw_event_batches_as_error(
        self,
        *,
        older_than_iso: str,
        limit: int = 100,
    ) -> int:
        now = dt.datetime.now(dt.UTC).isoformat()
        cur = self.conn.execute(
            """
            WITH candidates AS (
                SELECT id
                FROM raw_event_flush_batches
                WHERE status IN ('started', 'running') AND updated_at < ?
                ORDER BY updated_at
                LIMIT ?
            )
            UPDATE raw_event_flush_batches
            SET status = 'error', updated_at = ?
            WHERE id IN (SELECT id FROM candidates)
            """,
            (older_than_iso, limit, now),
        )
        self.conn.commit()
        changes = cur.rowcount
        if changes is None or changes < 0:
            row = self.conn.execute("SELECT changes() AS count").fetchone()
            changes = row["count"] if row else 0
        return int(changes or 0)

    def end_session(self, session_id: int, metadata: dict[str, Any] | None = None) -> None:
        ended_at = dt.datetime.now(dt.UTC).isoformat()
        metadata_text = None if metadata is None else db.to_json(metadata)
        self.conn.execute(
            "UPDATE sessions SET ended_at = ?, metadata_json = COALESCE(?, metadata_json) WHERE id = ?",
            (ended_at, metadata_text, session_id),
        )
        self.conn.commit()

    def find_imported_id(self, table: str, import_key: str) -> int | None:
        allowed_tables = {"sessions", "memory_items", "session_summaries", "user_prompts"}
        if table not in allowed_tables:
            raise ValueError(f"Unsupported table for import lookup: {table}")
        row = self.conn.execute(
            f"SELECT id FROM {table} WHERE import_key = ? LIMIT 1",
            (import_key,),
        ).fetchone()
        if not row:
            return None
        return int(row["id"])

    def add_artifact(
        self,
        session_id: int,
        kind: str,
        path: str | None,
        content_text: str,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        created_at = dt.datetime.now(dt.UTC).isoformat()
        content_hash = hashlib.sha256(content_text.encode("utf-8")).hexdigest()
        if metadata and metadata.get("flush_batch"):
            meta_text = db.to_json(metadata)
            row = self.conn.execute(
                """
                SELECT id FROM artifacts
                WHERE session_id = ? AND kind = ? AND content_hash = ? AND metadata_json = ?
                LIMIT 1
                """,
                (session_id, kind, content_hash, meta_text),
            ).fetchone()
            if row is not None:
                return int(row["id"])
        cur = self.conn.execute(
            """
            INSERT INTO artifacts(session_id, kind, path, content_text, content_hash, created_at, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                kind,
                path,
                content_text,
                content_hash,
                created_at,
                db.to_json(metadata),
            ),
        )
        self.conn.commit()
        lastrowid = cur.lastrowid
        if lastrowid is None:
            raise RuntimeError("Failed to add session summary")
        return int(lastrowid)

    def remember(
        self,
        session_id: int,
        kind: str,
        title: str,
        body_text: str,
        confidence: float = 0.5,
        tags: Iterable[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        created_at = self._now_iso()
        tags_text = " ".join(sorted(set(tags or [])))
        metadata_payload = dict(metadata or {})
        metadata_payload.setdefault("clock_device_id", self.device_id)
        import_key = metadata_payload.get("import_key") or None
        if not import_key:
            import_key = str(uuid4())
        if metadata_payload.get("flush_batch"):
            meta_text = db.to_json(metadata_payload)
            row = self.conn.execute(
                """
                SELECT id FROM memory_items
                WHERE session_id = ? AND kind = ? AND title = ? AND body_text = ? AND metadata_json = ?
                LIMIT 1
                """,
                (session_id, kind, title, body_text, meta_text),
            ).fetchone()
            if row is not None:
                return int(row["id"])
        cur = self.conn.execute(
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
                deleted_at,
                rev,
                import_key
            )
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                kind,
                title,
                body_text,
                confidence,
                tags_text,
                created_at,
                created_at,
                db.to_json(metadata_payload),
                None,
                1,
                import_key,
            ),
        )
        self.conn.commit()
        lastrowid = cur.lastrowid
        if lastrowid is None:
            raise RuntimeError("Failed to create memory item")
        memory_id = int(lastrowid)
        self._store_vectors(memory_id, title, body_text)
        self._record_memory_item_op(memory_id, "upsert")
        return memory_id

    def remember_observation(
        self,
        session_id: int,
        kind: str,
        title: str,
        narrative: str,
        subtitle: str | None = None,
        facts: list[str] | None = None,
        concepts: list[str] | None = None,
        files_read: list[str] | None = None,
        files_modified: list[str] | None = None,
        prompt_number: int | None = None,
        confidence: float = 0.5,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        created_at = self._now_iso()
        tags_text = " ".join(
            self._derive_tags(
                kind=kind,
                title=title,
                concepts=concepts,
                files_read=files_read,
                files_modified=files_modified,
            )
        )
        metadata_payload = dict(metadata or {})
        metadata_payload.setdefault("clock_device_id", self.device_id)
        if metadata_payload.get("flush_batch"):
            meta_text = db.to_json(metadata_payload)
            row = self.conn.execute(
                """
                SELECT id FROM memory_items
                WHERE session_id = ? AND kind = ? AND title = ? AND body_text = ? AND metadata_json = ?
                LIMIT 1
                """,
                (session_id, kind, title, narrative, meta_text),
            ).fetchone()
            if row is not None:
                return int(row["id"])
        detail = {
            "subtitle": subtitle,
            "facts": facts or [],
            "narrative": narrative,
            "concepts": concepts or [],
            "files_read": files_read or [],
            "files_modified": files_modified or [],
            "prompt_number": prompt_number,
        }
        for key, value in detail.items():
            if key in metadata_payload:
                continue
            if value is None:
                continue
            metadata_payload[key] = value
        import_key = metadata_payload.get("import_key") or None
        if not import_key:
            import_key = str(uuid4())
        cur = self.conn.execute(
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
                deleted_at,
                rev,
                import_key
            )
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                kind,
                title,
                narrative,
                confidence,
                tags_text,
                created_at,
                created_at,
                db.to_json(metadata_payload),
                subtitle,
                db.to_json(facts or []),
                narrative,
                db.to_json(concepts or []),
                db.to_json(files_read or []),
                db.to_json(files_modified or []),
                prompt_number,
                None,
                1,
                import_key,
            ),
        )
        self.conn.commit()
        lastrowid = cur.lastrowid
        if lastrowid is None:
            raise RuntimeError("Failed to create observation")
        memory_id = int(lastrowid)
        self._store_vectors(memory_id, title, narrative)
        self._record_memory_item_op(memory_id, "upsert")
        return memory_id

    def backfill_tags_text(
        self,
        limit: int | None = None,
        since: str | None = None,
        project: str | None = None,
        active_only: bool = True,
        dry_run: bool = False,
    ) -> dict[str, int]:
        params: list[Any] = []
        where_clauses = ["(memory_items.tags_text IS NULL OR TRIM(memory_items.tags_text) = '')"]
        join_sessions = False
        if active_only:
            where_clauses.append("memory_items.active = 1")
        if since:
            where_clauses.append("memory_items.created_at >= ?")
            params.append(since)
        if project:
            clause, clause_params = self._project_clause(project)
            if clause:
                where_clauses.append(clause)
                params.extend(clause_params)
            join_sessions = True
        where = " AND ".join(where_clauses)
        join_clause = (
            "JOIN sessions ON sessions.id = memory_items.session_id" if join_sessions else ""
        )
        limit_clause = "LIMIT ?" if limit else ""
        if limit:
            params.append(limit)

        rows = self.conn.execute(
            f"""
            SELECT memory_items.id,
                   memory_items.kind,
                   memory_items.title,
                   memory_items.concepts,
                   memory_items.files_read,
                   memory_items.files_modified
            FROM memory_items
            {join_clause}
            WHERE {where}
            ORDER BY memory_items.created_at ASC
            {limit_clause}
            """,
            params,
        ).fetchall()

        checked = 0
        updated = 0
        skipped = 0
        now = dt.datetime.now(dt.UTC).isoformat()

        for row in rows:
            checked += 1
            memory_id = int(row["id"])
            kind = str(row["kind"] or "")
            title = str(row["title"] or "")
            concepts = self._safe_json_list(row["concepts"])
            files_read = self._safe_json_list(row["files_read"])
            files_modified = self._safe_json_list(row["files_modified"])
            tags = self._derive_tags(
                kind=kind,
                title=title,
                concepts=concepts,
                files_read=files_read,
                files_modified=files_modified,
            )
            tags_text = " ".join(tags)
            if not tags_text:
                skipped += 1
                continue
            if not dry_run:
                self.conn.execute(
                    "UPDATE memory_items SET tags_text = ?, updated_at = ? WHERE id = ?",
                    (tags_text, now, memory_id),
                )
            updated += 1

        if not dry_run:
            self.conn.commit()
        return {"checked": checked, "updated": updated, "skipped": skipped}

    def backfill_vectors(
        self,
        limit: int | None = None,
        since: str | None = None,
        project: str | None = None,
        active_only: bool = True,
        dry_run: bool = False,
    ) -> dict[str, int]:
        client = get_embedding_client()
        if not client:
            return {"checked": 0, "embedded": 0, "inserted": 0, "skipped": 0}
        params: list[Any] = []
        where_clauses = []
        join_sessions = False
        if active_only:
            where_clauses.append("memory_items.active = 1")
        if since:
            where_clauses.append("memory_items.created_at >= ?")
            params.append(since)
        if project:
            clause, clause_params = self._project_clause(project)
            if clause:
                where_clauses.append(clause)
                params.extend(clause_params)
            join_sessions = True
        where = " AND ".join(where_clauses) if where_clauses else "1=1"
        join_clause = (
            "JOIN sessions ON sessions.id = memory_items.session_id" if join_sessions else ""
        )
        limit_clause = "LIMIT ?" if limit else ""
        if limit:
            params.append(limit)
        rows = self.conn.execute(
            f"""
            SELECT memory_items.id, memory_items.title, memory_items.body_text
            FROM memory_items
            {join_clause}
            WHERE {where}
            ORDER BY memory_items.created_at ASC
            {limit_clause}
            """,
            params,
        ).fetchall()
        checked = 0
        embedded = 0
        inserted = 0
        skipped = 0
        model = client.model
        for row in rows:
            checked += 1
            memory_id = int(row["id"])
            title = row["title"] or ""
            body_text = row["body_text"] or ""
            text = f"{title}\n{body_text}".strip()
            chunks = chunk_text(text)
            if not chunks:
                continue
            existing = self.conn.execute(
                """
                SELECT content_hash
                FROM memory_vectors
                WHERE memory_id = ? AND model = ?
                """,
                (memory_id, model),
            ).fetchall()
            existing_hashes = {row["content_hash"] for row in existing if row["content_hash"]}
            pending_chunks: list[str] = []
            pending_hashes: list[str] = []
            for chunk in chunks:
                content_hash = hash_text(chunk)
                if content_hash in existing_hashes:
                    skipped += 1
                    continue
                pending_chunks.append(chunk)
                pending_hashes.append(content_hash)
            if not pending_chunks:
                continue
            embeddings = embed_texts(pending_chunks)
            if not embeddings:
                continue
            embedded += len(embeddings)
            if dry_run:
                inserted += len(embeddings)
                continue
            for index, (vector, content_hash) in enumerate(
                zip(embeddings, pending_hashes, strict=False)
            ):
                self.conn.execute(
                    """
                    INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (vector, memory_id, index, content_hash, model),
                )
                inserted += 1
        if not dry_run:
            self.conn.commit()
        return {
            "checked": checked,
            "embedded": embedded,
            "inserted": inserted,
            "skipped": skipped,
        }

    def add_user_prompt(
        self,
        session_id: int,
        project: str | None,
        prompt_text: str,
        prompt_number: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        created_at = dt.datetime.now(dt.UTC).isoformat()
        created_at_epoch = int(dt.datetime.now(dt.UTC).timestamp() * 1000)
        import_key = None
        if metadata and metadata.get("import_key"):
            import_key = metadata.get("import_key")
        cur = self.conn.execute(
            """
            INSERT INTO user_prompts(
                session_id,
                project,
                prompt_text,
                prompt_number,
                created_at,
                created_at_epoch,
                metadata_json,
                import_key
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                project,
                prompt_text,
                prompt_number,
                created_at,
                created_at_epoch,
                db.to_json(metadata),
                import_key,
            ),
        )
        self.conn.commit()
        lastrowid = cur.lastrowid
        if lastrowid is None:
            raise RuntimeError("Failed to add prompt")
        return int(lastrowid)

    def add_session_summary(
        self,
        session_id: int,
        project: str | None,
        request: str,
        investigated: str,
        learned: str,
        completed: str,
        next_steps: str,
        notes: str,
        files_read: list[str] | None = None,
        files_edited: list[str] | None = None,
        prompt_number: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        created_at = dt.datetime.now(dt.UTC).isoformat()
        created_at_epoch = int(dt.datetime.now(dt.UTC).timestamp() * 1000)
        import_key = None
        if metadata and metadata.get("import_key"):
            import_key = metadata.get("import_key")
        if metadata and metadata.get("flush_batch"):
            meta_text = db.to_json(metadata)
            row = self.conn.execute(
                """
                SELECT id FROM session_summaries
                WHERE session_id = ? AND request = ? AND investigated = ? AND learned = ?
                  AND completed = ? AND next_steps = ? AND notes = ? AND metadata_json = ?
                LIMIT 1
                """,
                (
                    session_id,
                    request,
                    investigated,
                    learned,
                    completed,
                    next_steps,
                    notes,
                    meta_text,
                ),
            ).fetchone()
            if row is not None:
                return int(row["id"])
        cur = self.conn.execute(
            """
            INSERT INTO session_summaries(
                session_id,
                project,
                request,
                investigated,
                learned,
                completed,
                next_steps,
                notes,
                files_read,
                files_edited,
                prompt_number,
                created_at,
                created_at_epoch,
                metadata_json,
                import_key
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                project,
                request,
                investigated,
                learned,
                completed,
                next_steps,
                notes,
                db.to_json(files_read or []),
                db.to_json(files_edited or []),
                prompt_number,
                created_at,
                created_at_epoch,
                db.to_json(metadata),
                import_key,
            ),
        )
        self.conn.commit()
        lastrowid = cur.lastrowid
        if lastrowid is None:
            raise RuntimeError("Failed to add session summary")
        return int(lastrowid)

    def deactivate_low_signal_observations(
        self, limit: int | None = None, dry_run: bool = False
    ) -> dict[str, int]:
        return self.deactivate_low_signal_memories(
            kinds=["observation"], limit=limit, dry_run=dry_run
        )

    def deactivate_low_signal_memories(
        self,
        kinds: Iterable[str] | None = None,
        limit: int | None = None,
        dry_run: bool = False,
    ) -> dict[str, int]:
        selected_kinds = [k.strip() for k in (kinds or []) if k.strip()]
        if not selected_kinds:
            selected_kinds = [
                "observation",
                "discovery",
                "change",
                "feature",
                "bugfix",
                "refactor",
                "decision",
                "note",
                "entities",
                "session_summary",
            ]
        kind_placeholders = ",".join("?" for _ in selected_kinds)
        clause = "LIMIT ?" if limit else ""
        params: list[Any] = [*selected_kinds]
        if limit:
            params.append(limit)
        rows = self.conn.execute(
            f"""
            SELECT id, title, body_text
            FROM memory_items
            WHERE kind IN ({kind_placeholders}) AND active = 1
            ORDER BY id DESC
            {clause}
            """,
            params,
        ).fetchall()
        checked = len(rows)
        ids: list[int] = []
        for row in rows:
            text = row["body_text"] or row["title"] or ""
            if is_low_signal_observation(text):
                ids.append(int(row["id"]))
        if not ids or dry_run:
            return {"checked": checked, "deactivated": len(ids)}

        now = dt.datetime.now(dt.UTC).isoformat()
        chunk_size = 200
        for start in range(0, len(ids), chunk_size):
            chunk = ids[start : start + chunk_size]
            placeholders = ",".join("?" for _ in chunk)
            self.conn.execute(
                f"UPDATE memory_items SET active = 0, updated_at = ? WHERE id IN ({placeholders})",
                (now, *chunk),
            )
        self.conn.commit()
        return {"checked": checked, "deactivated": len(ids)}

    def forget(self, memory_id: int) -> None:
        row = self.conn.execute(
            "SELECT rev, metadata_json FROM memory_items WHERE id = ?",
            (memory_id,),
        ).fetchone()
        if row is None:
            return
        metadata = self._normalize_metadata(row["metadata_json"])
        metadata.setdefault("clock_device_id", self.device_id)
        rev = int(row["rev"] or 0) + 1
        now = self._now_iso()
        self.conn.execute(
            """
            UPDATE memory_items
            SET active = 0, deleted_at = ?, updated_at = ?, metadata_json = ?, rev = ?
            WHERE id = ?
            """,
            (now, now, db.to_json(metadata), rev, memory_id),
        )
        self.conn.commit()
        self._record_memory_item_op(memory_id, "delete")

    def get(self, memory_id: int) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM memory_items WHERE id = ?",
            (memory_id,),
        ).fetchone()
        if not row:
            self.record_usage("get", metadata={"found": False})
            return None
        data = dict(row)
        data["metadata_json"] = db.from_json(data.get("metadata_json"))
        tokens_read = self.estimate_tokens(f"{data.get('title', '')} {data.get('body_text', '')}")
        self.record_usage("get", tokens_read=tokens_read, metadata={"found": True})
        return data

    def get_many(self, ids: Iterable[int]) -> list[dict[str, Any]]:
        id_list = [int(mid) for mid in ids]
        if not id_list:
            return []
        placeholders = ",".join("?" for _ in id_list)
        rows = self.conn.execute(
            f"SELECT * FROM memory_items WHERE id IN ({placeholders})",
            id_list,
        ).fetchall()
        results = db.rows_to_dicts(rows)
        for item in results:
            item["metadata_json"] = db.from_json(item.get("metadata_json"))
        tokens_read = sum(
            self.estimate_tokens(f"{item.get('title', '')} {item.get('body_text', '')}")
            for item in results
        )
        self.record_usage(
            "get_observations",
            tokens_read=tokens_read,
            metadata={"count": len(results)},
        )
        return results

    def recent(
        self, limit: int = 10, filters: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        filters = filters or {}
        params: list[Any] = []
        where = ["active = 1"]
        join_sessions = False
        if filters.get("kind"):
            where.append("kind = ?")
            params.append(filters["kind"])
        if filters.get("project"):
            clause, clause_params = self._project_clause(filters["project"])
            if clause:
                where.append(clause)
                params.extend(clause_params)
            join_sessions = True
        where_clause = " AND ".join(where)
        from_clause = "memory_items"
        if join_sessions:
            from_clause = "memory_items JOIN sessions ON sessions.id = memory_items.session_id"
        rows = self.conn.execute(
            f"SELECT memory_items.* FROM {from_clause} WHERE {where_clause} ORDER BY created_at DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
        results = db.rows_to_dicts(rows)
        for item in results:
            item["metadata_json"] = db.from_json(item.get("metadata_json"))
        tokens_read = sum(
            self.estimate_tokens(f"{item.get('title', '')} {item.get('body_text', '')}")
            for item in results
        )
        self.record_usage(
            "recent",
            tokens_read=tokens_read,
            metadata={
                "limit": limit,
                "results": len(results),
                "kind": filters.get("kind"),
                "project": filters.get("project"),
            },
        )
        return results

    def recent_by_kinds(
        self,
        kinds: Iterable[str],
        limit: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        filters = filters or {}
        kinds_list = [str(kind) for kind in kinds if kind]
        if not kinds_list:
            return []
        params: list[Any] = list(kinds_list)
        where = [
            "active = 1",
            "kind IN ({})".format(", ".join("?" for _ in kinds_list)),
        ]
        join_sessions = False
        if filters.get("project"):
            clause, clause_params = self._project_clause(filters["project"])
            if clause:
                where.append(clause)
                params.extend(clause_params)
            join_sessions = True
        where_clause = " AND ".join(where)
        from_clause = "memory_items"
        if join_sessions:
            from_clause = "memory_items JOIN sessions ON sessions.id = memory_items.session_id"
        rows = self.conn.execute(
            f"SELECT memory_items.* FROM {from_clause} WHERE {where_clause} ORDER BY created_at DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
        results = db.rows_to_dicts(rows)
        for item in results:
            item["metadata_json"] = db.from_json(item.get("metadata_json"))
        tokens_read = sum(
            self.estimate_tokens(f"{item.get('title', '')} {item.get('body_text', '')}")
            for item in results
        )
        self.record_usage(
            "recent_kinds",
            tokens_read=tokens_read,
            metadata={
                "limit": limit,
                "results": len(results),
                "kinds": kinds_list,
                "project": filters.get("project"),
            },
        )
        return results

    def search_index(
        self, query: str, limit: int = 10, filters: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        results = self.search(query, limit=limit, filters=filters, log_usage=False)
        index_items = [
            {
                "id": item.id,
                "kind": item.kind,
                "title": item.title,
                "score": item.score,
                "created_at": item.created_at,
                "session_id": item.session_id,
            }
            for item in results
        ]
        tokens_read = sum(self.estimate_tokens(item["title"]) for item in index_items)
        self.record_usage(
            "search_index",
            tokens_read=tokens_read,
            metadata={
                "limit": limit,
                "results": len(index_items),
                "project": (filters or {}).get("project"),
            },
        )
        return index_items

    def timeline(
        self,
        query: str | None = None,
        memory_id: int | None = None,
        depth_before: int = 3,
        depth_after: int = 3,
        filters: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        anchor: MemoryResult | dict[str, Any] | None = None
        if memory_id is not None:
            item = self.get(memory_id)
            if item:
                anchor = item
        if anchor is None and query:
            matches = self.search(query, limit=1, filters=filters, log_usage=False)
            if matches:
                anchor = matches[0]
        if anchor is None:
            return []
        timeline = self._timeline_around(anchor, depth_before, depth_after, filters)
        tokens_read = sum(
            self.estimate_tokens(f"{item.get('title', '')} {item.get('body_text', '')}")
            for item in timeline
        )
        self.record_usage(
            "timeline",
            tokens_read=tokens_read,
            metadata={
                "depth_before": depth_before,
                "depth_after": depth_after,
                "project": (filters or {}).get("project"),
            },
        )
        return timeline

    def _expand_query(self, query: str) -> str:
        tokens = re.findall(r"[A-Za-z0-9_]+", query)
        tokens = [t for t in tokens if t.lower() not in {"or", "and", "not"}]
        if not tokens:
            return ""
        if len(tokens) == 1:
            return tokens[0]
        return " OR ".join(tokens)

    def _project_column_clause(self, column_expr: str, project: str) -> tuple[str, list[Any]]:
        project = project.strip()
        if not project:
            return "", []
        value = project
        if "/" in project or "\\" in project:
            base = self._project_basename(project)
            if not base:
                return "", []
            value = base
        return (
            f"({column_expr} = ? OR {column_expr} LIKE ? OR {column_expr} LIKE ?)",
            [value, f"%/{value}", f"%\\{value}"],
        )

    def _project_clause(self, project: str) -> tuple[str, list[Any]]:
        return self._project_column_clause("sessions.project", project)

    @staticmethod
    def _project_basename(value: str) -> str:
        normalized = value.replace("\\", "/").rstrip("/")
        if not normalized:
            return ""
        return normalized.split("/")[-1]

    def normalize_projects(self, *, dry_run: bool = True) -> dict[str, Any]:
        """Normalize project values in the DB.

        - Rewrites path-like projects ("/Users/.../repo") to their basename ("repo")
          to avoid machine-specific anchoring.
        - Rewrites obvious git error strings ("fatal: ...") to the session cwd basename
          when available.
        - Rewrites project="/" to the session cwd basename when possible.

        This is intended as a one-time cleanup when imports or older versions stored
        inconsistent project identifiers.
        """

        session_rows = self.conn.execute(
            "SELECT id, cwd, project FROM sessions ORDER BY started_at DESC"
        ).fetchall()
        raw_rows = self.conn.execute(
            "SELECT opencode_session_id, cwd, project FROM raw_event_sessions"
        ).fetchall()
        usage_rows = self.conn.execute(
            "SELECT id, metadata_json FROM usage_events WHERE event = 'pack'"
        ).fetchall()

        rewritten_paths: dict[str, str] = {}

        session_updates: list[tuple[str | None, int]] = []
        for row in session_rows:
            session_id = int(row["id"])
            cwd = row["cwd"]
            project = row["project"]
            if not project or not isinstance(project, str):
                continue
            proj = project.strip()
            if not proj:
                continue
            new_value: str | None = None

            if proj == "/" or proj.lower().startswith("fatal:"):
                if isinstance(cwd, str) and cwd.strip() and cwd.strip() != "/":
                    new_value = self._project_basename(cwd.strip())
            elif "/" in proj or "\\" in proj:
                base = self._project_basename(proj)
                if base and base != proj:
                    new_value = base
                    rewritten_paths.setdefault(proj, base)

            if new_value is not None and new_value != proj:
                session_updates.append((new_value, session_id))

        raw_updates: list[tuple[str | None, str]] = []
        for row in raw_rows:
            opencode_session_id = str(row["opencode_session_id"])
            cwd = row["cwd"]
            project = row["project"]
            if not project or not isinstance(project, str):
                continue
            proj = project.strip()
            if not proj:
                continue
            new_value: str | None = None
            if proj == "/" or proj.lower().startswith("fatal:"):
                if isinstance(cwd, str) and cwd.strip() and cwd.strip() != "/":
                    new_value = self._project_basename(cwd.strip())
            elif "/" in proj or "\\" in proj:
                base = self._project_basename(proj)
                if base and base != proj:
                    new_value = base
                    rewritten_paths.setdefault(proj, base)
            if new_value is not None and new_value != proj:
                raw_updates.append((new_value, opencode_session_id))

        usage_updates: list[tuple[str, int]] = []
        for row in usage_rows:
            usage_id = int(row["id"])
            metadata = db.from_json(row["metadata_json"]) if row["metadata_json"] else {}
            if not isinstance(metadata, dict):
                metadata = {}
            project_value = metadata.get("project")
            if not isinstance(project_value, str):
                continue
            proj = project_value.strip()
            if not proj:
                continue
            new_value: str | None = None
            if "/" in proj or "\\" in proj:
                base = self._project_basename(proj)
                if base and base != proj:
                    new_value = base
                    rewritten_paths.setdefault(proj, base)
            if new_value is not None and new_value != proj:
                metadata["project"] = new_value
                usage_updates.append((db.to_json(metadata), usage_id))

        preview = {
            "dry_run": dry_run,
            "rewritten_paths": rewritten_paths,
            "sessions_to_update": len(session_updates),
            "raw_event_sessions_to_update": len(raw_updates),
            "usage_events_to_update": len(usage_updates),
        }
        if dry_run:
            return preview

        for project, session_id in session_updates:
            self.conn.execute(
                "UPDATE sessions SET project = ? WHERE id = ?",
                (project, session_id),
            )
        for project, opencode_session_id in raw_updates:
            self.conn.execute(
                "UPDATE raw_event_sessions SET project = ? WHERE opencode_session_id = ?",
                (project, opencode_session_id),
            )
        for metadata_json, usage_id in usage_updates:
            self.conn.execute(
                "UPDATE usage_events SET metadata_json = ? WHERE id = ?",
                (metadata_json, usage_id),
            )
        self.conn.commit()
        return preview

    def _query_looks_like_tasks(self, query: str) -> bool:
        lowered = query.lower()
        if any(
            token in lowered
            for token in (
                "todo",
                "todos",
                "pending",
                "task",
                "tasks",
                "next",
                "resume",
                "continue",
                "backlog",
            )
        ):
            return True
        return any(
            phrase in lowered
            for phrase in (
                "follow up",
                "follow-up",
                "followups",
                "pick up",
                "pick-up",
                "left off",
                "where we left off",
                "work on next",
                "what's next",
                "what was next",
            )
        )

    def _query_looks_like_recall(self, query: str) -> bool:
        lowered = query.lower()
        if any(
            token in lowered
            for token in (
                "remember",
                "remind",
                "recall",
                "recap",
                "summary",
                "summarize",
            )
        ):
            return True
        return any(
            phrase in lowered
            for phrase in (
                "what did we do",
                "what did we work on",
                "what did we decide",
                "what happened",
                "last time",
                "previous session",
                "previous work",
                "where were we",
                "catch me up",
                "catch up",
            )
        )

    def _task_query_hint(self) -> str:
        return "todo todos task tasks pending follow up follow-up next resume continue backlog pick up pick-up"

    def _recall_query_hint(self) -> str:
        return "session summary recap remember last time previous work"

    def _task_fallback_recent(
        self, limit: int, filters: dict[str, Any] | None
    ) -> list[dict[str, Any]]:
        expanded_limit = max(limit * 3, limit)
        results = self.recent(limit=expanded_limit, filters=filters)
        return self._prioritize_task_results(results, limit)

    def _recall_fallback_recent(
        self, limit: int, filters: dict[str, Any] | None
    ) -> list[dict[str, Any]]:
        summary_filters = dict(filters or {})
        summary_filters["kind"] = "session_summary"
        summaries = self.recent(limit=limit, filters=summary_filters)
        if len(summaries) >= limit:
            return summaries[:limit]
        expanded_limit = max(limit * 3, limit)
        recent_all = self.recent(limit=expanded_limit, filters=filters)
        summary_ids = {item.get("id") for item in summaries}
        remainder = [item for item in recent_all if item.get("id") not in summary_ids]
        remainder = self._prioritize_task_results(remainder, limit - len(summaries))
        return summaries + remainder

    def _created_at_for(self, item: MemoryResult | dict[str, Any]) -> str:
        if isinstance(item, MemoryResult):
            return item.created_at
        return item.get("created_at", "")

    def _parse_created_at(self, value: str) -> dt.datetime | None:
        if not value:
            return None
        try:
            parsed = dt.datetime.fromisoformat(value)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=dt.UTC)
        return parsed

    def _recency_score(self, created_at: str) -> float:
        parsed = self._parse_created_at(created_at)
        if not parsed:
            return 0.0
        days_ago = (dt.datetime.now(dt.UTC) - parsed).days
        return 1.0 / (1.0 + (days_ago / 7.0))

    def _kind_bonus(self, kind: str | None) -> float:
        if kind == "session_summary":
            return 0.25
        if kind == "decision":
            return 0.2
        if kind == "note":
            return 0.15
        if kind == "observation":
            return 0.1
        if kind == "entities":
            return 0.05
        return 0.0

    def _filter_recent_results(
        self, results: Sequence[MemoryResult | dict[str, Any]], days: int
    ) -> list[MemoryResult | dict[str, Any]]:
        cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(days=days)
        filtered: list[MemoryResult | dict[str, Any]] = []
        for item in results:
            created_at = self._parse_created_at(self._created_at_for(item))
            if created_at and created_at >= cutoff:
                filtered.append(item)
        return filtered

    def _tokenize_query(self, query: str) -> list[str]:
        tokens = [token.lower() for token in re.findall(r"[A-Za-z0-9_]+", query)]
        return [token for token in tokens if token not in self.STOPWORDS]

    def _fuzzy_score(self, query_tokens: list[str], query: str, text: str) -> float:
        text_lower = text.lower()
        if not text_lower.strip():
            return 0.0
        match_tokens = set(re.findall(r"[A-Za-z0-9_]+", text_lower))
        overlap = 0.0
        if query_tokens:
            overlap = len(set(query_tokens) & match_tokens) / max(len(query_tokens), 1)
        ratio = difflib.SequenceMatcher(None, query.lower(), text_lower).ratio()
        return max(overlap, ratio)

    def _fuzzy_search(
        self, query: str, limit: int, filters: dict[str, Any] | None
    ) -> list[dict[str, Any]]:
        query_tokens = self._tokenize_query(query)
        if not query_tokens:
            return []
        candidate_limit = max(self.FUZZY_CANDIDATE_LIMIT, limit * 10)
        candidates = self.recent(limit=candidate_limit, filters=filters)
        scored: list[tuple[float, dict[str, Any]]] = []
        for item in candidates:
            text = f"{item.get('title', '')} {item.get('body_text', '')}"
            score = self._fuzzy_score(query_tokens, query, text)
            if score >= self.FUZZY_MIN_SCORE:
                scored.append((score, item))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [item for _, item in scored[:limit]]

    def _cosine_similarity(self, vec_a: list[float], vec_b: list[float]) -> float:
        dot = sum(a * b for a, b in zip(vec_a, vec_b, strict=False))
        norm_a = math.sqrt(sum(a * a for a in vec_a))
        norm_b = math.sqrt(sum(b * b for b in vec_b))
        if norm_a == 0.0 or norm_b == 0.0:
            return 0.0
        return dot / (norm_a * norm_b)

    def _semantic_search(
        self, query: str, limit: int, filters: dict[str, Any] | None
    ) -> list[dict[str, Any]]:
        if len(query.strip()) < 3:
            return []
        embeddings = embed_texts([query])
        if not embeddings:
            return []
        query_embedding = embeddings[0]
        params: list[Any] = [query_embedding, limit]
        where_clauses = ["memory_items.active = 1"]
        join_sessions = False
        if filters:
            if filters.get("kind"):
                where_clauses.append("memory_items.kind = ?")
                params.append(filters["kind"])
            if filters.get("session_id"):
                where_clauses.append("memory_items.session_id = ?")
                params.append(filters["session_id"])
            if filters.get("since"):
                where_clauses.append("memory_items.created_at >= ?")
                params.append(filters["since"])
            if filters.get("project"):
                clause, clause_params = self._project_clause(filters["project"])
                if clause:
                    where_clauses.append(clause)
                    params.extend(clause_params)
                join_sessions = True
        where = " AND ".join(where_clauses)
        join_clause = (
            "JOIN sessions ON sessions.id = memory_items.session_id" if join_sessions else ""
        )
        sql = f"""
            SELECT memory_items.*, memory_vectors.distance
            FROM memory_vectors
            JOIN memory_items ON memory_items.id = memory_vectors.memory_id
            {join_clause}
            WHERE memory_vectors.embedding MATCH ?
              AND k = ?
              AND {where}
            ORDER BY memory_vectors.distance ASC
        """
        rows = self.conn.execute(sql, params).fetchall()
        results = []
        for row in rows:
            results.append(
                {
                    "id": row["id"],
                    "kind": row["kind"],
                    "title": row["title"],
                    "body_text": row["body_text"],
                    "confidence": row["confidence"],
                    "tags_text": row["tags_text"],
                    "metadata_json": row["metadata_json"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                    "session_id": row["session_id"],
                    "score": 1.0 / (1.0 + float(row["distance"])),
                }
            )
        return results

    def _store_vectors(self, memory_id: int, title: str, body_text: str) -> None:
        client = get_embedding_client()
        if not client:
            return
        text = f"{title}\n{body_text}".strip()
        chunks = chunk_text(text)
        if not chunks:
            return
        embeddings = embed_texts(chunks)
        if not embeddings:
            return
        model = getattr(client, "model", "unknown")
        for index, (chunk, vector) in enumerate(zip(chunks, embeddings, strict=False)):
            if not vector:
                continue
            self.conn.execute(
                """
                INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
                VALUES (?, ?, ?, ?, ?)
                """,
                (vector, memory_id, index, hash_text(chunk), model),
            )
        self.conn.commit()

    def _prioritize_task_results(
        self, results: list[dict[str, Any]], limit: int
    ) -> list[dict[str, Any]]:
        def kind_rank(item: dict[str, Any]) -> int:
            kind = item.get("kind")
            if kind == "note":
                return 0
            if kind == "decision":
                return 1
            if kind == "observation":
                return 2
            return 3

        ordered = sorted(results, key=lambda item: item.get("created_at") or "", reverse=True)
        ordered = sorted(ordered, key=kind_rank)
        return ordered[:limit]

    def _prioritize_recall_results(
        self, results: list[MemoryResult | dict[str, Any]], limit: int
    ) -> list[MemoryResult | dict[str, Any]]:
        def kind_rank(item: MemoryResult | dict[str, Any]) -> int:
            kind = item.kind if isinstance(item, MemoryResult) else item.get("kind")
            if kind == "session_summary":
                return 0
            if kind == "decision":
                return 1
            if kind == "note":
                return 2
            if kind == "observation":
                return 3
            if kind == "entities":
                return 4
            return 5

        ordered = sorted(results, key=lambda item: self._created_at_for(item) or "", reverse=True)
        ordered = sorted(ordered, key=kind_rank)
        return ordered[:limit]

    def _rerank_results(
        self,
        results: list[MemoryResult],
        limit: int,
        recency_days: int | None = None,
    ) -> list[MemoryResult]:
        if recency_days:
            recent_results = self._filter_recent_results(results, recency_days)
            if recent_results:
                results = cast(list[MemoryResult], list(recent_results))

        def score(item: MemoryResult) -> float:
            return (
                (item.score * 1.5)
                + self._recency_score(item.created_at)
                + self._kind_bonus(item.kind)
            )

        ordered = sorted(results, key=score, reverse=True)
        return ordered[:limit]

    def _merge_ranked_results(
        self,
        results: Sequence[MemoryResult | dict[str, Any]],
        query: str,
        limit: int,
        filters: dict[str, Any] | None,
    ) -> list[MemoryResult]:
        fts_ids = {
            item.id if isinstance(item, MemoryResult) else item.get("id")
            for item in results
            if item is not None
        }
        vector_results = self._semantic_search(query, limit=limit, filters=filters)
        merged: list[MemoryResult | dict[str, Any]] = list(results)
        for item in vector_results:
            if item.get("id") in fts_ids:
                continue
            merged.append(item)
        if not merged:
            return []
        reranked: list[MemoryResult] = []
        for item in merged:
            if isinstance(item, MemoryResult):
                reranked.append(item)
                continue
            memory_id = item.get("id")
            kind = item.get("kind")
            title = item.get("title")
            body_text = item.get("body_text")
            created_at = item.get("created_at")
            updated_at = item.get("updated_at")
            session_id = item.get("session_id")
            confidence = item.get("confidence")
            if memory_id is None or kind is None or title is None or body_text is None:
                continue
            if created_at is None or updated_at is None or session_id is None:
                continue
            metadata = db.from_json(item.get("metadata_json"))
            reranked.append(
                MemoryResult(
                    id=int(memory_id),
                    kind=str(kind),
                    title=str(title),
                    body_text=str(body_text),
                    confidence=float(confidence or 0.0),
                    created_at=str(created_at),
                    updated_at=str(updated_at),
                    tags_text=str(item.get("tags_text") or ""),
                    score=float(item.get("score") or 0.0),
                    session_id=int(session_id),
                    metadata=metadata,
                )
            )
        return self._rerank_results(reranked, limit=limit, recency_days=self.RECALL_RECENCY_DAYS)

    def _timeline_around(
        self,
        anchor: MemoryResult | dict[str, Any],
        depth_before: int,
        depth_after: int,
        filters: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        anchor_id = anchor.id if isinstance(anchor, MemoryResult) else anchor.get("id")
        anchor_created_at = (
            anchor.created_at if isinstance(anchor, MemoryResult) else anchor.get("created_at")
        )
        anchor_session_id = (
            anchor.session_id if isinstance(anchor, MemoryResult) else anchor.get("session_id")
        )
        if not anchor_id or not anchor_created_at:
            return []
        filters = filters or {}
        params: list[Any] = []
        join_sessions = False
        where_base = ["memory_items.active = 1"]
        if filters.get("project"):
            clause, clause_params = self._project_clause(filters["project"])
            if clause:
                where_base.append(clause)
                params.extend(clause_params)
            join_sessions = True
        if anchor_session_id:
            where_base.append("memory_items.session_id = ?")
            params.append(anchor_session_id)
        where_clause = " AND ".join(where_base)
        join_clause = (
            "JOIN sessions ON sessions.id = memory_items.session_id" if join_sessions else ""
        )

        before_rows = self.conn.execute(
            f"""
            SELECT memory_items.*
            FROM memory_items
            {join_clause}
            WHERE {where_clause} AND memory_items.created_at < ?
            ORDER BY memory_items.created_at DESC
            LIMIT ?
            """,
            (*params, anchor_created_at, depth_before),
        ).fetchall()
        after_rows = self.conn.execute(
            f"""
            SELECT memory_items.*
            FROM memory_items
            {join_clause}
            WHERE {where_clause} AND memory_items.created_at > ?
            ORDER BY memory_items.created_at ASC
            LIMIT ?
            """,
            (*params, anchor_created_at, depth_after),
        ).fetchall()
        anchor_row = self.conn.execute(
            "SELECT * FROM memory_items WHERE id = ? AND active = 1",
            (anchor_id,),
        ).fetchone()
        rows = list(reversed(before_rows))
        if anchor_row:
            rows.append(anchor_row)
        rows.extend(after_rows)
        results = db.rows_to_dicts(rows)
        for item in results:
            item["metadata_json"] = db.from_json(item.get("metadata_json"))
        return results

    def search(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
        log_usage: bool = True,
    ) -> list[MemoryResult]:
        filters = filters or {}
        expanded_query = self._expand_query(query)
        if not expanded_query:
            return []
        params: list[Any] = [expanded_query]
        where_clauses = ["memory_items.active = 1", "memory_fts MATCH ?"]
        join_sessions = False
        if filters.get("kind"):
            where_clauses.append("memory_items.kind = ?")
            params.append(filters["kind"])
        if filters.get("session_id"):
            where_clauses.append("memory_items.session_id = ?")
            params.append(filters["session_id"])
        if filters.get("since"):
            where_clauses.append("memory_items.created_at >= ?")
            params.append(filters["since"])
        if filters.get("project"):
            clause, clause_params = self._project_clause(filters["project"])
            if clause:
                where_clauses.append(clause)
                params.extend(clause_params)
            join_sessions = True
        where = " AND ".join(where_clauses)
        join_clause = (
            "JOIN sessions ON sessions.id = memory_items.session_id" if join_sessions else ""
        )
        sql = f"""
            SELECT memory_items.*, bm25(memory_fts, 1.0, 1.0, 0.25) AS score,
                (1.0 / (1.0 + ((julianday('now') - julianday(memory_items.created_at)) / 7.0))) AS recency
            FROM memory_fts
            JOIN memory_items ON memory_items.id = memory_fts.rowid
            {join_clause}
            WHERE {where}
            ORDER BY (score * 1.5 + recency) DESC
            LIMIT ?
        """
        params.append(limit)
        rows = self.conn.execute(sql, params).fetchall()
        results: list[MemoryResult] = []
        for row in rows:
            metadata = db.from_json(row["metadata_json"])
            results.append(
                MemoryResult(
                    id=row["id"],
                    kind=row["kind"],
                    title=row["title"],
                    body_text=row["body_text"],
                    confidence=row["confidence"],
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                    tags_text=row["tags_text"],
                    score=float(row["score"]),
                    session_id=row["session_id"],
                    metadata=metadata,
                )
            )
        if log_usage:
            tokens_read = sum(self.estimate_tokens(f"{m.title} {m.body_text}") for m in results)
            self.record_usage(
                "search",
                tokens_read=tokens_read,
                metadata={
                    "limit": limit,
                    "results": len(results),
                    "kind": filters.get("kind"),
                    "project": filters.get("project"),
                },
            )
        return results

    def build_memory_pack(
        self,
        context: str,
        limit: int = 8,
        token_budget: int | None = None,
        filters: dict[str, Any] | None = None,
        log_usage: bool = True,
    ) -> dict[str, Any]:
        fallback_used = False
        merge_results = False
        recall_mode = False
        if self._query_looks_like_tasks(context):
            matches = self.search(
                self._task_query_hint(), limit=limit, filters=filters, log_usage=False
            )
            list(matches)
            if not matches:
                semantic_matches = self._semantic_search(context, limit=limit, filters=filters)
                if semantic_matches:
                    matches = semantic_matches
                    list(matches)
                    fallback_used = True
                else:
                    fuzzy_matches = self._fuzzy_search(context, limit=limit, filters=filters)
                    if fuzzy_matches:
                        matches = fuzzy_matches
                        list(matches)
                        fallback_used = True
                    else:
                        matches = self._task_fallback_recent(limit, filters)
                        list(matches)
                        fallback_used = True
            else:
                recent_matches = self._filter_recent_results(list(matches), self.TASK_RECENCY_DAYS)
                if recent_matches:
                    matches = self._prioritize_task_results(
                        [m.__dict__ if isinstance(m, MemoryResult) else m for m in recent_matches],
                        limit,
                    )
                    list(recent_matches)
        elif self._query_looks_like_recall(context):
            recall_mode = True
            recall_filters = dict(filters or {})
            recall_filters["kind"] = "session_summary"
            matches = self.search(
                context or self._recall_query_hint(),
                limit=limit,
                filters=recall_filters,
                log_usage=False,
            )
            list(matches)
            if not matches:
                semantic_matches = self._semantic_search(context, limit=limit, filters=filters)
                if semantic_matches:
                    matches = semantic_matches
                    list(matches)
                    fallback_used = True
                else:
                    fuzzy_matches = self._fuzzy_search(context, limit=limit, filters=filters)
                    if fuzzy_matches:
                        matches = fuzzy_matches
                        list(matches)
                        fallback_used = True
                    else:
                        matches = self._recall_fallback_recent(limit, filters)
                        list(matches)
                        fallback_used = True
            else:
                recent_matches = self._filter_recent_results(
                    list(matches), self.RECALL_RECENCY_DAYS
                )
                if recent_matches:
                    matches = self._prioritize_recall_results(list(recent_matches), limit)
                    list(recent_matches)
            if matches:
                depth_before = max(0, limit // 2)
                depth_after = max(0, limit - depth_before - 1)
                timeline = self._timeline_around(matches[0], depth_before, depth_after, filters)
                if timeline:
                    matches = timeline
                    list(matches)
        else:
            matches = self.search(context, limit=limit, filters=filters, log_usage=False)
            list(matches)
            if not matches:
                semantic_matches = self._semantic_search(context, limit=limit, filters=filters)
                if semantic_matches:
                    matches = semantic_matches
                    list(matches)
                    fallback_used = True
                else:
                    fuzzy_matches = self._fuzzy_search(context, limit=limit, filters=filters)
                    if fuzzy_matches:
                        matches = fuzzy_matches
                        list(matches)
                        fallback_used = True
            elif matches:
                matches = self._rerank_results(
                    list(matches), limit=limit, recency_days=self.RECALL_RECENCY_DAYS
                )
                list(matches)
            merge_results = True

        semantic_candidates = 0
        if merge_results:
            semantic_candidates = len(self._semantic_search(context, limit=limit, filters=filters))
            matches = self._merge_ranked_results(matches, context, limit, filters)

        def get_metadata(item: MemoryResult | dict[str, Any]) -> dict[str, Any]:
            if isinstance(item, MemoryResult):
                return item.metadata or {}
            metadata = item.get("metadata_json")
            if isinstance(metadata, str):
                return db.from_json(metadata)
            if isinstance(metadata, dict):
                return metadata
            return {}

        def estimate_work_tokens(item: MemoryResult | dict[str, Any]) -> int:
            metadata = get_metadata(item)
            discovery_tokens = metadata.get("discovery_tokens")
            if discovery_tokens is not None:
                try:
                    tokens = int(discovery_tokens)
                    if tokens >= 0:
                        return tokens
                except (TypeError, ValueError):
                    pass
            title = item.title if isinstance(item, MemoryResult) else item.get("title", "")
            body = item.body_text if isinstance(item, MemoryResult) else item.get("body_text", "")
            return self.estimate_tokens(f"{title} {body}".strip())

        def discovery_group(item: MemoryResult | dict[str, Any]) -> str:
            metadata = get_metadata(item)
            value = metadata.get("discovery_group")
            if isinstance(value, str) and value.strip():
                return value.strip()
            fallback_id = item_id(item)
            if fallback_id is not None:
                return f"memory:{fallback_id}"
            return "unknown"

        def avoided_work_tokens(item: MemoryResult | dict[str, Any]) -> tuple[int, str]:
            metadata = get_metadata(item)
            discovery_tokens = metadata.get("discovery_tokens")
            discovery_source = metadata.get("discovery_source")
            if discovery_tokens is not None:
                try:
                    tokens = int(discovery_tokens)
                    if tokens > 0:
                        return tokens, str(discovery_source or "known")
                except (TypeError, ValueError):
                    pass
            return 0, "unknown"

        def work_source(item: MemoryResult | dict[str, Any]) -> str:
            metadata = get_metadata(item)
            if metadata.get("discovery_source") == "usage":
                return "usage"
            return "estimate"

        def item_value(item: MemoryResult | dict[str, Any], key: str, default: Any = "") -> Any:
            if isinstance(item, MemoryResult):
                return getattr(item, key, default)
            return item.get(key, default)

        def item_id(item: MemoryResult | dict[str, Any]) -> int | None:
            value = item_value(item, "id")
            return int(value) if value is not None else None

        def item_kind(item: MemoryResult | dict[str, Any]) -> str:
            return str(item_value(item, "kind", "") or "")

        def item_created_at(item: MemoryResult | dict[str, Any]) -> str:
            return str(item_value(item, "created_at", "") or "")

        def item_body(item: MemoryResult | dict[str, Any]) -> str:
            return str(item_value(item, "body_text", "") or "")

        def item_title(item: MemoryResult | dict[str, Any]) -> str:
            return str(item_value(item, "title", "") or "")

        def item_confidence(item: MemoryResult | dict[str, Any]) -> float | None:
            value = item_value(item, "confidence")
            return float(value) if value is not None else None

        def item_tags(item: MemoryResult | dict[str, Any]) -> str:
            return str(item_value(item, "tags_text", "") or "")

        def sort_recent(
            items: Sequence[MemoryResult | dict[str, Any]],
        ) -> list[MemoryResult | dict[str, Any]]:
            return sorted(list(items), key=item_created_at, reverse=True)

        def sort_by_tag_overlap(
            items: Sequence[MemoryResult | dict[str, Any]],
            query: str,
        ) -> list[MemoryResult | dict[str, Any]]:
            tokens = {t for t in re.findall(r"[a-z0-9_]+", query.lower()) if t}
            if not tokens:
                return list(items)

            def overlap(item: MemoryResult | dict[str, Any]) -> int:
                tags = item_tags(item)
                tag_tokens = {t for t in tags.split() if t}
                return len(tokens.intersection(tag_tokens))

            return sorted(
                list(items), key=lambda item: (overlap(item), item_created_at(item)), reverse=True
            )

        def sort_oldest(
            items: Sequence[MemoryResult | dict[str, Any]],
        ) -> list[MemoryResult | dict[str, Any]]:
            return sorted(list(items), key=item_created_at)

        def normalize_items(
            items: Sequence[MemoryResult | dict[str, Any]] | None,
        ) -> list[MemoryResult | dict[str, Any]]:
            if not items:
                return []
            return list(items)

        summary_candidates = [m for m in matches if item_kind(m) == "session_summary"]
        summary_item: MemoryResult | dict[str, Any] | None = None
        if summary_candidates:
            summary_item = sort_recent(summary_candidates)[0]
        else:
            summary_filters = dict(filters or {})
            summary_filters["kind"] = "session_summary"
            recent_summary = normalize_items(self.recent(limit=1, filters=summary_filters))
            if recent_summary:
                summary_item = recent_summary[0]

        timeline_candidates = [m for m in matches if item_kind(m) != "session_summary"]
        if not timeline_candidates:
            timeline_candidates = [
                m
                for m in normalize_items(self.recent(limit=limit, filters=filters))
                if item_kind(m) != "session_summary"
            ]
        if not merge_results:
            timeline_candidates = sort_recent(timeline_candidates)

        observation_kinds = [
            "decision",
            "feature",
            "bugfix",
            "refactor",
            "change",
            "discovery",
            "exploration",
            "note",
        ]
        observation_rank = {kind: index for index, kind in enumerate(observation_kinds)}
        observation_candidates = [m for m in matches if item_kind(m) in observation_kinds]
        if not observation_candidates:
            observation_candidates = normalize_items(
                self.recent_by_kinds(
                    observation_kinds,
                    limit=max(limit * 3, 10),
                    filters=filters,
                )
            )
        if not observation_candidates:
            observation_candidates = list(timeline_candidates)
        observation_candidates = sort_recent(observation_candidates)
        observation_candidates = sorted(
            observation_candidates,
            key=lambda item: observation_rank.get(item_kind(item), len(observation_kinds)),
        )

        # Prefer items whose tags overlap the request context.
        observation_candidates = sort_by_tag_overlap(observation_candidates, context)

        remaining = max(0, limit)
        summary_items: list[MemoryResult | dict[str, Any]] = []
        if summary_item is not None:
            summary_items = [summary_item]
            remaining = max(0, remaining - 1)
        timeline_limit = min(3, remaining)
        remaining = max(0, remaining - timeline_limit)
        observation_limit = remaining

        if merge_results:
            timeline_items = list(timeline_candidates)
        else:
            timeline_items = timeline_candidates[:timeline_limit]
        observation_items = observation_candidates[:observation_limit]

        # Avoid same-y packs: allow only one session_summary per unique title prefix.
        if not merge_results and observation_items:
            seen = set()
            deduped: list[MemoryResult | dict[str, Any]] = []
            for item in observation_items:
                title = item_title(item)
                key = title.strip().lower()[:48]
                if key and key in seen:
                    continue
                if key:
                    seen.add(key)
                deduped.append(item)
            observation_items = deduped[:observation_limit]

        selected_ids: set[int] = set()
        sections: list[tuple[str, list[MemoryResult | dict[str, Any]]]] = []

        def add_section(
            title: str,
            items: list[MemoryResult | dict[str, Any]],
            allow_duplicates: bool = False,
        ) -> None:
            section_items: list[MemoryResult | dict[str, Any]] = []
            for item in items:
                candidate_id = item_id(item)
                if candidate_id is None:
                    continue
                if not allow_duplicates and candidate_id in selected_ids:
                    continue
                selected_ids.add(candidate_id)
                section_items.append(item)
            if section_items:
                sections.append((title, section_items))

        add_section("Summary", summary_items)
        add_section("Timeline", timeline_items)
        if not summary_items:
            sections.append(("Summary", []))
        if not timeline_items:
            sections.append(("Timeline", []))
        if observation_items:
            add_section("Observations", observation_items, allow_duplicates=True)
        elif timeline_items:
            add_section("Observations", timeline_items, allow_duplicates=True)
        else:
            sections.append(("Observations", []))

        required_titles = {"Summary", "Timeline", "Observations"}
        if token_budget:
            running = 0
            trimmed_sections: list[tuple[str, list[MemoryResult | dict[str, Any]]]] = []
            budget_exhausted = False
            for title, items in sections:
                if not items and title in required_titles:
                    trimmed_sections.append((title, []))
                    continue
                section_items: list[MemoryResult | dict[str, Any]] = []
                for item in items:
                    est = self.estimate_tokens(item_body(item))
                    if running + est > token_budget and trimmed_sections:
                        budget_exhausted = True
                        break
                    running += est
                    section_items.append(item)
                if section_items:
                    trimmed_sections.append((title, section_items))
                if budget_exhausted:
                    break
            sections = trimmed_sections

        final_items: list[MemoryResult | dict[str, Any]] = []
        if merge_results:
            final_items = list(timeline_items)
        else:
            for title, items in sections:
                if title == "Observations":
                    continue
                final_items.extend(items)

        if recall_mode:
            recall_items: list[MemoryResult | dict[str, Any]] = []
            seen_ids: set[int] = set()
            for item in timeline_items:
                candidate_id = item_id(item)
                if candidate_id is None or candidate_id in seen_ids:
                    continue
                seen_ids.add(candidate_id)
                recall_items.append(item)
            if summary_item is not None:
                summary_id = item_id(summary_item)
                if summary_id is not None and summary_id not in seen_ids:
                    recall_items.append(summary_item)
            final_items = sort_oldest(recall_items)

        formatted = [
            {
                "id": item_id(m),
                "kind": item_kind(m),
                "title": item_title(m),
                "body": item_body(m),
                "confidence": item_confidence(m),
                "tags": item_tags(m),
            }
            for m in final_items
        ]

        section_blocks = []
        for title, items in sections:
            lines = [
                f"[{item_id(m)}] ({item_kind(m)}) {item_title(m)} - {item_body(m)}" for m in items
            ]
            if lines:
                section_blocks.append(f"## {title}\n" + "\n".join(lines))
            else:
                section_blocks.append(f"## {title}\n")
        pack_text = "\n\n".join(section_blocks)
        pack_tokens = self.estimate_tokens(pack_text)
        work_tokens_sum = sum(estimate_work_tokens(m) for m in final_items)
        group_work: dict[str, int] = {}
        for item in final_items:
            key = discovery_group(item)
            group_work[key] = max(group_work.get(key, 0), estimate_work_tokens(item))
        work_tokens_unique = sum(group_work.values())
        avoided_tokens_total = 0
        avoided_known = 0
        avoided_unknown = 0
        avoided_sources: dict[str, int] = {}
        for item in final_items:
            tokens, source = avoided_work_tokens(item)
            if tokens > 0:
                avoided_tokens_total += tokens
                avoided_known += 1
                avoided_sources[source] = avoided_sources.get(source, 0) + 1
            else:
                avoided_unknown += 1
        tokens_saved = max(0, work_tokens_unique - pack_tokens)
        avoided_work_saved = max(0, avoided_tokens_total - pack_tokens)
        work_sources = [work_source(m) for m in final_items]
        usage_items = sum(1 for source in work_sources if source == "usage")
        estimate_items = sum(1 for source in work_sources if source != "usage")
        if usage_items and estimate_items:
            work_source_label = "mixed"
        elif usage_items:
            work_source_label = "usage"
        else:
            work_source_label = "estimate"
        semantic_hits = 0
        if merge_results:
            semantic_ids = {
                item.get("id") for item in self._semantic_search(context, limit, filters)
            }
            for item in formatted:
                if item.get("id") in semantic_ids:
                    semantic_hits += 1

        compression_ratio = None
        overhead_tokens = None
        if work_tokens_unique > 0:
            compression_ratio = float(pack_tokens) / float(work_tokens_unique)
            overhead_tokens = int(pack_tokens) - int(work_tokens_unique)

        avoided_work_ratio = None
        if avoided_tokens_total > 0:
            avoided_work_ratio = float(avoided_tokens_total) / float(pack_tokens or 1)

        metrics = {
            "limit": limit,
            "items": len(formatted),
            "token_budget": token_budget,
            "project": (filters or {}).get("project"),
            "fallback": "recent" if fallback_used else None,
            "work_tokens_unique": work_tokens_unique,
            "work_tokens": work_tokens_sum,
            "pack_tokens": pack_tokens,
            "tokens_saved": tokens_saved,
            "compression_ratio": compression_ratio,
            "overhead_tokens": overhead_tokens,
            "avoided_work_tokens": avoided_tokens_total,
            "avoided_work_saved": avoided_work_saved,
            "avoided_work_ratio": avoided_work_ratio,
            "avoided_work_known_items": avoided_known,
            "avoided_work_unknown_items": avoided_unknown,
            "avoided_work_sources": avoided_sources,
            "work_source": work_source_label,
            "work_usage_items": usage_items,
            "work_estimate_items": estimate_items,
            "semantic_candidates": semantic_candidates,
            "semantic_hits": semantic_hits,
        }
        if log_usage:
            self.record_usage(
                "pack",
                tokens_read=pack_tokens,
                tokens_saved=tokens_saved,
                metadata=metrics,
            )
        return {
            "context": context,
            "items": formatted,
            "pack_text": pack_text,
            "metrics": metrics,
        }

    def all_sessions(self) -> list[dict[str, Any]]:
        rows = self.conn.execute("SELECT * FROM sessions ORDER BY started_at DESC").fetchall()
        return db.rows_to_dicts(rows)

    def session_artifacts(self, session_id: int, limit: int = 100) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM artifacts WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            (session_id, limit),
        ).fetchall()
        results = db.rows_to_dicts(rows)
        for item in results:
            item["metadata_json"] = db.from_json(item.get("metadata_json"))
        return results

    def latest_transcript(self, session_id: int) -> str | None:
        row = self.conn.execute(
            """
            SELECT content_text FROM artifacts
            WHERE session_id = ? AND kind = 'transcript'
            ORDER BY id DESC LIMIT 1
            """,
            (session_id,),
        ).fetchone()
        if row:
            return row["content_text"]
        return None

    def replace_session_summary(self, session_id: int, summary: Summary) -> None:
        now = dt.datetime.now(dt.UTC).isoformat()
        self.conn.execute(
            """
            UPDATE memory_items
            SET active = 0, updated_at = ?
            WHERE session_id = ? AND kind IN ('session_summary', 'observation', 'entities')
            """,
            (now, session_id),
        )
        self.conn.commit()
        self.remember(
            session_id,
            kind="session_summary",
            title="Session summary",
            body_text=summary.session_summary,
            confidence=0.7,
        )
        for obs in summary.observations:
            self.remember(
                session_id,
                kind="observation",
                title=obs[:80],
                body_text=obs,
                confidence=0.6,
            )
        if summary.entities:
            self.remember(
                session_id,
                kind="entities",
                title="Entities",
                body_text="; ".join(summary.entities),
                confidence=0.4,
            )

    def close(self) -> None:
        self.conn.close()

    @staticmethod
    def estimate_tokens(text: str) -> int:
        return max(8, int(len(text) / 4))

    def record_usage(
        self,
        event: str,
        session_id: int | None = None,
        tokens_read: int = 0,
        tokens_written: int = 0,
        tokens_saved: int = 0,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        created_at = dt.datetime.now(dt.UTC).isoformat()
        cur = self.conn.execute(
            """
            INSERT INTO usage_events(session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                event,
                int(tokens_read),
                int(tokens_written),
                int(tokens_saved),
                created_at,
                db.to_json(metadata),
            ),
        )
        self.conn.commit()
        lastrowid = cur.lastrowid
        if lastrowid is None:
            raise RuntimeError("Failed to record usage")
        return int(lastrowid)

    def usage_summary(self, project: str | None = None) -> list[dict[str, Any]]:
        if not project:
            rows = self.conn.execute(
                """
                SELECT event,
                       COUNT(*) AS count,
                       COALESCE(SUM(tokens_read), 0) AS tokens_read,
                       COALESCE(SUM(tokens_written), 0) AS tokens_written,
                       COALESCE(SUM(tokens_saved), 0) AS tokens_saved
                FROM usage_events
                GROUP BY event
                ORDER BY event
                """
            ).fetchall()
            return db.rows_to_dicts(rows)

        session_clause, session_params = self._project_column_clause("sessions.project", project)
        meta_project_expr = (
            "CASE WHEN json_valid(usage_events.metadata_json) = 1 "
            "THEN json_extract(usage_events.metadata_json, '$.project') ELSE NULL END"
        )
        meta_clause, meta_params = self._project_column_clause(meta_project_expr, project)
        if not session_clause and not meta_clause:
            return []
        rows = self.conn.execute(
            f"""
            SELECT usage_events.event AS event,
                   COUNT(*) AS count,
                   COALESCE(SUM(usage_events.tokens_read), 0) AS tokens_read,
                   COALESCE(SUM(usage_events.tokens_written), 0) AS tokens_written,
                   COALESCE(SUM(usage_events.tokens_saved), 0) AS tokens_saved
            FROM usage_events
            LEFT JOIN sessions ON sessions.id = usage_events.session_id
            WHERE ({session_clause} OR {meta_clause})
            GROUP BY usage_events.event
            ORDER BY usage_events.event
            """,
            (*session_params, *meta_params),
        ).fetchall()
        return db.rows_to_dicts(rows)

    def usage_totals(self, project: str | None = None) -> dict[str, Any]:
        if not project:
            row = self.conn.execute(
                """
                SELECT COUNT(*) as count,
                       COALESCE(SUM(tokens_read), 0) as tokens_read,
                       COALESCE(SUM(tokens_written), 0) as tokens_written,
                       COALESCE(SUM(tokens_saved), 0) as tokens_saved
                FROM usage_events
                """
            ).fetchone()
            return {
                "events": int(row["count"] or 0) if row else 0,
                "tokens_read": int(row["tokens_read"] or 0) if row else 0,
                "tokens_written": int(row["tokens_written"] or 0) if row else 0,
                "tokens_saved": int(row["tokens_saved"] or 0) if row else 0,
                "work_investment_tokens": self.work_investment_tokens(),
                "work_investment_tokens_sum": self.work_investment_tokens_sum(),
            }

        session_clause, session_params = self._project_column_clause("sessions.project", project)
        meta_project_expr = (
            "CASE WHEN json_valid(usage_events.metadata_json) = 1 "
            "THEN json_extract(usage_events.metadata_json, '$.project') ELSE NULL END"
        )
        meta_clause, meta_params = self._project_column_clause(meta_project_expr, project)
        if not session_clause and not meta_clause:
            return {
                "events": 0,
                "tokens_read": 0,
                "tokens_written": 0,
                "tokens_saved": 0,
                "work_investment_tokens": 0,
                "work_investment_tokens_sum": 0,
            }
        row = self.conn.execute(
            f"""
            SELECT COUNT(*) as count,
                   COALESCE(SUM(usage_events.tokens_read), 0) as tokens_read,
                   COALESCE(SUM(usage_events.tokens_written), 0) as tokens_written,
                   COALESCE(SUM(usage_events.tokens_saved), 0) as tokens_saved
            FROM usage_events
            LEFT JOIN sessions ON sessions.id = usage_events.session_id
            WHERE ({session_clause} OR {meta_clause})
            """,
            (*session_params, *meta_params),
        ).fetchone()
        return {
            "events": int(row["count"] or 0) if row else 0,
            "tokens_read": int(row["tokens_read"] or 0) if row else 0,
            "tokens_written": int(row["tokens_written"] or 0) if row else 0,
            "tokens_saved": int(row["tokens_saved"] or 0) if row else 0,
            "work_investment_tokens": self.work_investment_tokens(project=project),
            "work_investment_tokens_sum": self.work_investment_tokens_sum(project=project),
        }

    def recent_pack_events(
        self, limit: int = 10, project: str | None = None
    ) -> list[dict[str, Any]]:
        if project:
            session_clause, session_params = self._project_column_clause(
                "sessions.project", project
            )
            meta_project_expr = (
                "CASE WHEN json_valid(usage_events.metadata_json) = 1 "
                "THEN json_extract(usage_events.metadata_json, '$.project') ELSE NULL END"
            )
            meta_clause, meta_params = self._project_column_clause(meta_project_expr, project)
            if not session_clause and not meta_clause:
                return []
            rows = self.conn.execute(
                f"""
                SELECT usage_events.id, usage_events.session_id, usage_events.event,
                       usage_events.tokens_read, usage_events.tokens_written, usage_events.tokens_saved,
                       usage_events.created_at, usage_events.metadata_json
                FROM usage_events
                LEFT JOIN sessions ON sessions.id = usage_events.session_id
                WHERE event = 'pack'
                  AND ({session_clause} OR {meta_clause})
                ORDER BY usage_events.created_at DESC
                LIMIT ?
                """,
                (*session_params, *meta_params, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                """
                SELECT id, session_id, event, tokens_read, tokens_written, tokens_saved,
                       created_at, metadata_json
                FROM usage_events
                WHERE event = 'pack'
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        results = db.rows_to_dicts(rows)
        for item in results:
            item["metadata_json"] = db.from_json(item.get("metadata_json"))
        return results

    def latest_pack_per_project(self) -> list[dict[str, Any]]:
        """Return the most recent pack event for each project."""
        rows = self.conn.execute(
            """
            SELECT id, session_id, event, tokens_read, tokens_written, tokens_saved,
                   created_at, metadata_json
            FROM usage_events
            WHERE event = 'pack'
              AND id IN (
                  SELECT MAX(id)
                  FROM usage_events
                  WHERE event = 'pack'
                    AND json_extract(metadata_json, '$.project') IS NOT NULL
                  GROUP BY json_extract(metadata_json, '$.project')
              )
            ORDER BY created_at DESC
            """
        ).fetchall()
        results = db.rows_to_dicts(rows)
        for item in results:
            item["metadata_json"] = db.from_json(item.get("metadata_json"))
        return results

    def stats(self) -> dict[str, Any]:
        total_memories = self.conn.execute("SELECT COUNT(*) FROM memory_items").fetchone()[0]
        active_memories = self.conn.execute(
            "SELECT COUNT(*) FROM memory_items WHERE active = 1"
        ).fetchone()[0]
        sessions = self.conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        artifacts = self.conn.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0]
        db_path = str(self.db_path)
        size_bytes = Path(db_path).stat().st_size if Path(db_path).exists() else 0

        vector_rows = self.conn.execute("SELECT COUNT(*) FROM memory_vectors").fetchone()
        vector_count = vector_rows[0] if vector_rows else 0
        vector_coverage = 0.0
        if active_memories:
            vector_coverage = min(1.0, float(vector_count) / float(active_memories))

        tags_filled = self.conn.execute(
            "SELECT COUNT(*) FROM memory_items WHERE active = 1 AND TRIM(tags_text) != ''"
        ).fetchone()[0]
        tags_coverage = 0.0
        if active_memories:
            tags_coverage = min(1.0, float(tags_filled) / float(active_memories))

        raw_events = self.conn.execute("SELECT COUNT(*) FROM raw_events").fetchone()[0]

        usage_rows = self.conn.execute(
            """
            SELECT event, COUNT(*) as count, SUM(tokens_read) as tokens_read,
                   SUM(tokens_written) as tokens_written, SUM(tokens_saved) as tokens_saved
            FROM usage_events
            GROUP BY event
            ORDER BY count DESC
            """
        ).fetchall()
        usage = {
            "events": [dict(row) for row in usage_rows],
            "totals": {
                "events": sum(row["count"] for row in usage_rows),
                "tokens_read": sum(row["tokens_read"] or 0 for row in usage_rows),
                "tokens_written": sum(row["tokens_written"] or 0 for row in usage_rows),
                "tokens_saved": sum(row["tokens_saved"] or 0 for row in usage_rows),
                "work_investment_tokens": self.work_investment_tokens(),
                "work_investment_tokens_sum": self.work_investment_tokens_sum(),
            },
        }

        return {
            "database": {
                "path": db_path,
                "size_bytes": size_bytes,
                "sessions": sessions,
                "memory_items": total_memories,
                "active_memory_items": active_memories,
                "artifacts": artifacts,
                "vector_rows": vector_count,
                "vector_coverage": vector_coverage,
                "tags_filled": tags_filled,
                "tags_coverage": tags_coverage,
                "raw_events": raw_events,
            },
            "usage": usage,
        }
