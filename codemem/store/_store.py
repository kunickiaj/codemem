from __future__ import annotations

import datetime as dt
import hashlib
import math
import os
import sqlite3
import zlib
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any
from uuid import uuid4

from .. import db
from ..config import load_config
from ..memory_kinds import validate_memory_kind
from ..summarizer import Summary
from . import maintenance as store_maintenance
from . import raw_events as store_raw_events
from . import replication as store_replication
from . import search as store_search  # noqa: E402
from . import tags as store_tags
from . import usage as store_usage
from . import utils as store_utils
from . import vectors as store_vectors
from .types import MemoryResult, ReplicationClock, ReplicationOp


class MemoryStore:
    RECALL_RECENCY_DAYS = 180
    TASK_RECENCY_DAYS = 365
    FUZZY_CANDIDATE_LIMIT = 200
    FUZZY_MIN_SCORE = 0.18
    SEMANTIC_CANDIDATE_LIMIT = 200
    ARTIFACT_COMPRESSION_MIN_BYTES = 4096
    ARTIFACT_COMPRESSION_ENCODING = "zlib+utf8"
    LEGACY_SYNC_ACTOR_DISPLAY_NAME = "Legacy synced peer"
    LEGACY_SHARED_WORKSPACE_ID = "shared:legacy"
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

    @staticmethod
    def _safe_json_list(value: str | None) -> list[str]:
        return store_maintenance._safe_json_list(value)

    def __init__(
        self,
        db_path: Path | str = db.DEFAULT_DB_PATH,
        *,
        check_same_thread: bool = True,
    ):
        self.db_path = Path(db_path).expanduser()
        self.conn = db.connect(self.db_path, check_same_thread=check_same_thread)
        db.initialize_schema(self.conn)
        self.device_id = os.getenv("CODEMEM_DEVICE_ID", "")
        if not self.device_id:
            row = self.conn.execute("SELECT device_id FROM sync_device LIMIT 1").fetchone()
            self.device_id = str(row["device_id"]) if row else "local"

        cfg = load_config()
        self.actor_id = self._resolve_actor_id(cfg.actor_id)
        self.actor_display_name = self._resolve_actor_display_name(cfg.actor_display_name)
        self._pack_exact_dedupe_enabled = bool(cfg.pack_exact_dedupe_enabled)
        self._hybrid_retrieval_enabled = bool(cfg.hybrid_retrieval_enabled)
        self._hybrid_retrieval_shadow_log = bool(cfg.hybrid_retrieval_shadow_log)
        self._hybrid_retrieval_shadow_sample_rate = float(cfg.hybrid_retrieval_shadow_sample_rate)
        self._sync_projects_include = [
            p.strip() for p in cfg.sync_projects_include if p and p.strip()
        ]
        self._sync_projects_exclude = [
            p.strip() for p in cfg.sync_projects_exclude if p and p.strip()
        ]
        self._ensure_local_actor_record()
        self._sync_peer_actor_compatibility_state()
        self._backfill_identity_provenance()
        self._migrate_project_first_sharing_defaults()
        self._reconcile_claimed_same_actor_legacy_memories()

    def _resolve_actor_id(self, configured_actor_id: str | None) -> str:
        value = str(configured_actor_id or "").strip()
        if value:
            return value
        device_id = str(self.device_id or "").strip() or "local"
        return f"local:{device_id}"

    def _resolve_actor_display_name(self, configured_display_name: str | None) -> str:
        value = str(configured_display_name or "").strip()
        if value:
            return value
        user = str(os.getenv("USER") or os.getenv("USERNAME") or "").strip()
        return user or self.actor_id

    @staticmethod
    def _clean_optional_str(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        cleaned = value.strip()
        return cleaned or None

    def _default_workspace_id(self, *, actor_id: str, workspace_kind: str) -> str:
        if workspace_kind == "shared":
            return "shared:default"
        return f"personal:{actor_id}"

    def _upsert_actor_record(
        self,
        *,
        actor_id: str,
        display_name: str,
        is_local: bool,
    ) -> None:
        now = dt.datetime.now(dt.UTC).isoformat()
        if is_local:
            self.conn.execute("UPDATE actors SET is_local = 0 WHERE actor_id != ?", (actor_id,))
            self.conn.execute(
                """
                INSERT INTO actors(
                    actor_id,
                    display_name,
                    is_local,
                    status,
                    merged_into_actor_id,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, 1, 'active', NULL, ?, ?)
                ON CONFLICT(actor_id) DO UPDATE SET
                    display_name = excluded.display_name,
                    is_local = 1,
                    status = 'active',
                    merged_into_actor_id = NULL,
                    updated_at = excluded.updated_at
                """,
                (actor_id, display_name, now, now),
            )
            return
        self.conn.execute(
            """
            INSERT INTO actors(
                actor_id,
                display_name,
                is_local,
                status,
                merged_into_actor_id,
                created_at,
                updated_at
            )
            VALUES (?, ?, 0, 'active', NULL, ?, ?)
            ON CONFLICT(actor_id) DO UPDATE SET
                display_name = excluded.display_name,
                updated_at = excluded.updated_at
            """,
            (actor_id, display_name, now, now),
        )

    def _ensure_local_actor_record(self) -> None:
        self._upsert_actor_record(
            actor_id=self.actor_id,
            display_name=self.actor_display_name,
            is_local=True,
        )
        if self.conn.in_transaction:
            self.conn.commit()

    def _sync_peer_actor_compatibility_state(self) -> None:
        self.conn.execute(
            """
            UPDATE sync_peers
            SET actor_id = ?
            WHERE claimed_local_actor = 1
              AND (actor_id IS NULL OR TRIM(actor_id) = '')
            """,
            (self.actor_id,),
        )
        self.conn.execute(
            "UPDATE sync_peers SET claimed_local_actor = 1 WHERE actor_id = ?",
            (self.actor_id,),
        )
        self.conn.execute(
            """
            UPDATE sync_peers
            SET claimed_local_actor = 0
            WHERE actor_id IS NOT NULL
              AND TRIM(actor_id) != ''
              AND actor_id != ?
            """,
            (self.actor_id,),
        )
        if self.conn.in_transaction:
            self.conn.commit()

    def get_actor(self, actor_id: str) -> dict[str, Any] | None:
        cleaned = self._clean_optional_str(actor_id)
        if not cleaned:
            return None
        row = self.conn.execute(
            """
            SELECT actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
            FROM actors
            WHERE actor_id = ?
            """,
            (cleaned,),
        ).fetchone()
        if row is None:
            return None
        return {
            "actor_id": str(row["actor_id"]),
            "display_name": str(row["display_name"]),
            "is_local": bool(row["is_local"]),
            "status": str(row["status"]),
            "merged_into_actor_id": row["merged_into_actor_id"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def resolve_actor(self, actor_id: str) -> dict[str, Any] | None:
        cleaned_actor_id = self._clean_optional_str(actor_id)
        if not cleaned_actor_id:
            return None
        seen: set[str] = set()
        current_actor_id = cleaned_actor_id
        while current_actor_id and current_actor_id not in seen:
            seen.add(current_actor_id)
            actor = self.get_actor(current_actor_id)
            if actor is None:
                return None
            merged_into_actor_id = self._clean_optional_str(actor.get("merged_into_actor_id"))
            if actor["status"] != "merged" or not merged_into_actor_id:
                return actor
            current_actor_id = merged_into_actor_id
        raise ValueError("actor merge redirect cycle")

    def list_actors(self, *, include_merged: bool = False) -> list[dict[str, Any]]:
        where = "" if include_merged else "WHERE status = 'active'"
        rows = self.conn.execute(
            f"""
            SELECT actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
            FROM actors
            {where}
            ORDER BY is_local DESC, display_name COLLATE NOCASE ASC, actor_id ASC
            """
        ).fetchall()
        return [
            {
                "actor_id": str(row["actor_id"]),
                "display_name": str(row["display_name"]),
                "is_local": bool(row["is_local"]),
                "status": str(row["status"]),
                "merged_into_actor_id": row["merged_into_actor_id"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]

    def create_actor(self, *, display_name: str, actor_id: str | None = None) -> dict[str, Any]:
        cleaned_name = self._clean_optional_str(display_name)
        if not cleaned_name:
            raise ValueError("display_name required")
        cleaned_actor_id = self._clean_optional_str(actor_id)
        if cleaned_actor_id == self.actor_id:
            self._ensure_local_actor_record()
            actor = self.get_actor(self.actor_id)
            if actor is None:
                raise ValueError("local actor missing")
            return actor
        if cleaned_actor_id is None:
            cleaned_actor_id = f"actor:{uuid4()}"
        self._upsert_actor_record(
            actor_id=cleaned_actor_id,
            display_name=cleaned_name,
            is_local=False,
        )
        if self.conn.in_transaction:
            self.conn.commit()
        actor = self.get_actor(cleaned_actor_id)
        if actor is None:
            raise ValueError("actor create failed")
        return actor

    def rename_actor(self, actor_id: str, *, display_name: str) -> dict[str, Any]:
        cleaned_actor_id = self._clean_optional_str(actor_id)
        cleaned_name = self._clean_optional_str(display_name)
        if not cleaned_actor_id:
            raise ValueError("actor_id required")
        if not cleaned_name:
            raise ValueError("display_name required")
        actor = self.get_actor(cleaned_actor_id)
        if actor is None:
            raise LookupError("actor not found")
        if actor["is_local"]:
            raise ValueError("local actor rename not supported")
        if actor["status"] != "active":
            raise ValueError("merged actor rename not supported")
        self._upsert_actor_record(
            actor_id=cleaned_actor_id,
            display_name=cleaned_name,
            is_local=bool(actor["is_local"]),
        )
        if self.conn.in_transaction:
            self.conn.commit()
        renamed = self.get_actor(cleaned_actor_id)
        if renamed is None:
            raise LookupError("actor not found")
        return renamed

    def peer_actor_assignment(self, peer_device_id: str) -> dict[str, Any] | None:
        cleaned_peer_id = self._clean_optional_str(peer_device_id)
        if not cleaned_peer_id:
            return None
        row = self.conn.execute(
            """
            SELECT p.peer_device_id, p.actor_id, p.claimed_local_actor, a.display_name AS actor_display_name
            FROM sync_peers AS p
            LEFT JOIN actors AS a ON a.actor_id = p.actor_id
            WHERE p.peer_device_id = ?
            """,
            (cleaned_peer_id,),
        ).fetchone()
        if row is None:
            return None
        actor_id = self._clean_optional_str(row["actor_id"])
        return {
            "peer_device_id": str(row["peer_device_id"]),
            "actor_id": actor_id,
            "actor_display_name": row["actor_display_name"],
            "claimed_local_actor": bool(row["claimed_local_actor"]),
        }

    def assigned_actor_for_peer(self, peer_device_id: str) -> dict[str, Any] | None:
        assignment = self.peer_actor_assignment(peer_device_id)
        actor_id = self._clean_optional_str(assignment.get("actor_id")) if assignment else None
        if not actor_id:
            return None
        return self.resolve_actor(actor_id)

    def assign_peer_actor(self, peer_device_id: str, *, actor_id: str | None) -> dict[str, Any]:
        cleaned_peer_id = self._clean_optional_str(peer_device_id)
        if not cleaned_peer_id:
            raise ValueError("peer_device_id required")
        row = self.conn.execute(
            "SELECT 1 FROM sync_peers WHERE peer_device_id = ?",
            (cleaned_peer_id,),
        ).fetchone()
        if row is None:
            raise LookupError("peer not found")
        cleaned_actor_id = self._clean_optional_str(actor_id)
        claimed_local_actor = False
        if cleaned_actor_id is not None:
            actor = self.resolve_actor(cleaned_actor_id)
            if actor is None:
                raise LookupError("actor not found")
            cleaned_actor_id = str(actor["actor_id"])
            claimed_local_actor = cleaned_actor_id == self.actor_id
        self.conn.execute(
            """
            UPDATE sync_peers
            SET actor_id = ?,
                claimed_local_actor = ?
            WHERE peer_device_id = ?
            """,
            (cleaned_actor_id, 1 if claimed_local_actor else 0, cleaned_peer_id),
        )
        if self.conn.in_transaction:
            self.conn.commit()
        if cleaned_actor_id is not None:
            self.reconcile_peer_actor_legacy_memories(cleaned_peer_id)
        assignment = self.peer_actor_assignment(cleaned_peer_id)
        if assignment is None:
            raise LookupError("peer not found")
        return assignment

    def merge_actor(self, *, primary_actor_id: str, secondary_actor_id: str) -> dict[str, Any]:
        cleaned_primary_actor_id = self._clean_optional_str(primary_actor_id)
        cleaned_secondary_actor_id = self._clean_optional_str(secondary_actor_id)
        if not cleaned_primary_actor_id:
            raise ValueError("primary_actor_id required")
        if not cleaned_secondary_actor_id:
            raise ValueError("secondary_actor_id required")
        if cleaned_primary_actor_id == cleaned_secondary_actor_id:
            raise ValueError("cannot merge actor into itself")

        primary_actor = self.resolve_actor(cleaned_primary_actor_id)
        secondary_actor = self.get_actor(cleaned_secondary_actor_id)
        if primary_actor is None:
            raise LookupError("primary actor not found")
        if secondary_actor is None:
            raise LookupError("secondary actor not found")
        if secondary_actor["is_local"]:
            raise ValueError("local actor cannot be merged into another actor")
        if secondary_actor["status"] != "active":
            raise ValueError("secondary actor already merged")

        resolved_primary_actor_id = str(primary_actor["actor_id"])
        if resolved_primary_actor_id == cleaned_secondary_actor_id:
            raise ValueError("secondary actor already redirects to primary actor")

        now = self._now_iso()
        claimed_local_actor = 1 if resolved_primary_actor_id == self.actor_id else 0
        peer_update = self.conn.execute(
            """
            UPDATE sync_peers
            SET actor_id = ?,
                claimed_local_actor = ?
            WHERE actor_id = ?
            """,
            (resolved_primary_actor_id, claimed_local_actor, cleaned_secondary_actor_id),
        )
        self.conn.execute(
            """
            UPDATE actors
            SET status = 'merged',
                merged_into_actor_id = ?,
                updated_at = ?
            WHERE actor_id = ?
            """,
            (resolved_primary_actor_id, now, cleaned_secondary_actor_id),
        )
        if self.conn.in_transaction:
            self.conn.commit()

        reassigned_peer_count = int(peer_update.rowcount or 0)
        if reassigned_peer_count:
            rows = self.conn.execute(
                "SELECT peer_device_id FROM sync_peers WHERE actor_id = ? ORDER BY peer_device_id",
                (resolved_primary_actor_id,),
            ).fetchall()
            for row in rows:
                peer_device_id = self._clean_optional_str(row["peer_device_id"])
                if peer_device_id:
                    self.reconcile_peer_actor_legacy_memories(peer_device_id)

        primary = self.get_actor(resolved_primary_actor_id)
        secondary = self.get_actor(cleaned_secondary_actor_id)
        if primary is None or secondary is None:
            raise LookupError("actor not found")
        return {
            "primary_actor": primary,
            "secondary_actor": secondary,
            "reassigned_peer_count": reassigned_peer_count,
        }

    def _resolve_memory_provenance(
        self, metadata: dict[str, Any] | None = None
    ) -> dict[str, str | None]:
        metadata = dict(metadata or {})
        actor_id = self._clean_optional_str(metadata.get("actor_id")) or self.actor_id
        actor_display_name = (
            self._clean_optional_str(metadata.get("actor_display_name")) or self.actor_display_name
        )
        explicit_workspace_kind = self._clean_optional_str(metadata.get("workspace_kind"))
        explicit_workspace_id = self._clean_optional_str(metadata.get("workspace_id"))
        visibility = self._clean_optional_str(metadata.get("visibility"))
        if visibility is None:
            if explicit_workspace_kind == "shared" or (
                explicit_workspace_id is not None and explicit_workspace_id.startswith("shared:")
            ):
                visibility = "shared"
            else:
                visibility = "shared"
        if visibility not in {"private", "shared"}:
            visibility = "shared"
        workspace_kind = explicit_workspace_kind or "shared"
        if workspace_kind not in {"personal", "shared"}:
            workspace_kind = "shared" if visibility == "shared" else "personal"
        elif visibility == "shared":
            workspace_kind = "shared"
        elif visibility == "private":
            workspace_kind = "personal"
        workspace_id = explicit_workspace_id or self._default_workspace_id(
            actor_id=actor_id,
            workspace_kind=workspace_kind,
        )
        origin_device_id = (
            self._clean_optional_str(metadata.get("origin_device_id")) or self.device_id
        )
        origin_source = self._clean_optional_str(
            metadata.get("origin_source")
        ) or self._clean_optional_str(metadata.get("source"))
        trust_state = self._clean_optional_str(metadata.get("trust_state")) or "trusted"
        return {
            "actor_id": actor_id,
            "actor_display_name": actor_display_name,
            "visibility": visibility,
            "workspace_id": workspace_id,
            "workspace_kind": workspace_kind,
            "origin_device_id": origin_device_id,
            "origin_source": origin_source,
            "trust_state": trust_state,
        }

    def _derive_legacy_row_provenance(self, row: dict[str, Any]) -> dict[str, str | None]:
        metadata = self._normalize_metadata(row.get("metadata_json"))
        source = self._clean_optional_str(metadata.get("source"))
        clock_device_id = self._clean_optional_str(metadata.get("clock_device_id"))
        is_sync = source == "sync"
        is_local = not is_sync and clock_device_id in {None, "local", self.device_id}
        if is_local:
            return self._resolve_memory_provenance(metadata)
        origin_device_id = clock_device_id or "unknown"
        assigned_actor = self.assigned_actor_for_peer(origin_device_id)
        if assigned_actor is not None:
            assigned_actor_id = str(assigned_actor["actor_id"])
            assigned_display_name = str(assigned_actor["display_name"])
            if assigned_actor_id == self.actor_id:
                return {
                    "actor_id": self.actor_id,
                    "actor_display_name": self.actor_display_name,
                    "visibility": "private",
                    "workspace_id": self._default_workspace_id(
                        actor_id=self.actor_id,
                        workspace_kind="personal",
                    ),
                    "workspace_kind": "personal",
                    "origin_device_id": origin_device_id,
                    "origin_source": self._clean_optional_str(metadata.get("origin_source"))
                    or source
                    or "sync",
                    "trust_state": self._clean_optional_str(metadata.get("trust_state"))
                    or "trusted",
                }
            return {
                "actor_id": assigned_actor_id,
                "actor_display_name": assigned_display_name,
                "visibility": self._clean_optional_str(metadata.get("visibility")) or "shared",
                "workspace_id": self._clean_optional_str(metadata.get("workspace_id"))
                or self._default_workspace_id(
                    actor_id=assigned_actor_id,
                    workspace_kind="shared",
                ),
                "workspace_kind": "shared",
                "origin_device_id": origin_device_id,
                "origin_source": self._clean_optional_str(metadata.get("origin_source"))
                or source
                or "sync",
                "trust_state": self._clean_optional_str(metadata.get("trust_state")) or "trusted",
            }
        actor_id = (
            self._clean_optional_str(metadata.get("actor_id")) or f"legacy-sync:{origin_device_id}"
        )
        actor_display_name = (
            self._clean_optional_str(metadata.get("actor_display_name"))
            or self.LEGACY_SYNC_ACTOR_DISPLAY_NAME
        )
        return {
            "actor_id": actor_id,
            "actor_display_name": actor_display_name,
            "visibility": self._clean_optional_str(metadata.get("visibility")) or "shared",
            "workspace_id": self._clean_optional_str(metadata.get("workspace_id"))
            or self.LEGACY_SHARED_WORKSPACE_ID,
            "workspace_kind": self._clean_optional_str(metadata.get("workspace_kind")) or "shared",
            "origin_device_id": origin_device_id,
            "origin_source": self._clean_optional_str(metadata.get("origin_source"))
            or source
            or "sync",
            "trust_state": self._clean_optional_str(metadata.get("trust_state"))
            or "legacy_unknown",
        }

    def _backfill_identity_provenance(self) -> None:
        rows = self.conn.execute(
            """
            SELECT id, metadata_json, actor_id, actor_display_name, workspace_id, workspace_kind,
                   visibility, origin_device_id, origin_source, trust_state
            FROM memory_items
            WHERE actor_id IS NULL
               OR actor_display_name IS NULL
               OR visibility IS NULL
               OR workspace_id IS NULL
               OR workspace_kind IS NULL
               OR origin_device_id IS NULL
               OR trust_state IS NULL
            """
        ).fetchall()
        if not rows:
            return
        for row in rows:
            row_data = dict(row)
            provenance = self._derive_legacy_row_provenance(row_data)
            self.conn.execute(
                """
                UPDATE memory_items
                SET actor_id = COALESCE(actor_id, ?),
                    actor_display_name = COALESCE(actor_display_name, ?),
                    visibility = COALESCE(visibility, ?),
                    workspace_id = COALESCE(workspace_id, ?),
                    workspace_kind = COALESCE(workspace_kind, ?),
                    origin_device_id = COALESCE(origin_device_id, ?),
                    origin_source = COALESCE(origin_source, ?),
                    trust_state = COALESCE(trust_state, ?)
                WHERE id = ?
                """,
                (
                    provenance["actor_id"],
                    provenance["actor_display_name"],
                    provenance["visibility"],
                    provenance["workspace_id"],
                    provenance["workspace_kind"],
                    provenance["origin_device_id"],
                    provenance["origin_source"],
                    provenance["trust_state"],
                    int(row_data["id"]),
                ),
            )
        self.conn.commit()

    def _migrate_project_first_sharing_defaults(self) -> None:
        rows = self.conn.execute(
            """
            SELECT id, metadata_json, rev
            FROM memory_items
            WHERE active = 1
              AND actor_id = ?
              AND visibility = 'private'
              AND workspace_kind = 'personal'
            ORDER BY id ASC
            """,
            (self.actor_id,),
        ).fetchall()
        migrated_ids: list[int] = []
        for row in rows:
            metadata = self._normalize_metadata(row["metadata_json"])
            if "visibility" in metadata:
                continue
            now = self._now_iso()
            rev = int(row["rev"] or 0) + 1
            memory_id = int(row["id"])
            self.conn.execute(
                """
                UPDATE memory_items
                SET visibility = 'shared',
                    workspace_kind = 'shared',
                    workspace_id = ?,
                    updated_at = ?,
                    rev = ?
                WHERE id = ?
                """,
                (
                    self._default_workspace_id(actor_id=self.actor_id, workspace_kind="shared"),
                    now,
                    rev,
                    memory_id,
                ),
            )
            migrated_ids.append(memory_id)
        if not migrated_ids:
            return
        self.conn.commit()
        for memory_id in migrated_ids:
            self._record_memory_item_op(memory_id, "upsert")

    def _reconcile_claimed_same_actor_legacy_memories(self) -> None:
        claimed_peers = self.same_actor_peer_ids()
        if not claimed_peers:
            return
        personal_workspace_id = self._default_workspace_id(
            actor_id=self.actor_id,
            workspace_kind="personal",
        )
        placeholders = ",".join("?" for _ in claimed_peers)
        self.conn.execute(
            f"""
            UPDATE memory_items
            SET actor_id = ?,
                actor_display_name = ?,
                visibility = 'private',
                workspace_id = ?,
                workspace_kind = 'personal',
                trust_state = 'trusted'
            WHERE origin_device_id IN ({placeholders})
              AND (
                    (
                        actor_id IS NULL
                     OR TRIM(actor_id) = ''
                     OR actor_id LIKE 'legacy-sync:%'
                     OR actor_id = ?
                    )
                AND (
                        actor_id IS NULL
                     OR TRIM(actor_id) = ''
                     OR actor_id LIKE 'legacy-sync:%'
                     OR actor_display_name = ?
                     OR workspace_id = ?
                     OR trust_state = 'legacy_unknown'
                    )
                )
            """,
            [
                self.actor_id,
                self.actor_display_name,
                personal_workspace_id,
                *claimed_peers,
                self.actor_id,
                self.LEGACY_SYNC_ACTOR_DISPLAY_NAME,
                self.LEGACY_SHARED_WORKSPACE_ID,
            ],
        )
        if self.conn.in_transaction:
            self.conn.commit()

    def reconcile_peer_actor_legacy_memories(self, peer_device_id: str) -> int:
        assignment = self.peer_actor_assignment(peer_device_id)
        actor_id = self._clean_optional_str(assignment.get("actor_id")) if assignment else None
        if not assignment or not actor_id:
            return 0
        actor = self.get_actor(actor_id)
        if actor is None:
            return 0
        cleaned_peer_id = str(assignment["peer_device_id"])
        if actor_id == self.actor_id:
            self.reconcile_claimed_same_actor_legacy_memories(cleaned_peer_id)
            row = self.conn.execute(
                "SELECT COUNT(1) AS total FROM memory_items WHERE origin_device_id = ? AND actor_id = ?",
                (cleaned_peer_id, self.actor_id),
            ).fetchone()
            return int(row["total"] or 0) if row else 0
        cursor = self.conn.execute(
            """
            UPDATE memory_items
            SET actor_id = ?,
                actor_display_name = ?,
                visibility = CASE WHEN visibility = 'shared' THEN visibility ELSE 'shared' END,
                workspace_id = CASE
                    WHEN workspace_id IS NULL OR TRIM(workspace_id) = '' OR workspace_id = ? THEN ?
                    ELSE workspace_id
                END,
                workspace_kind = CASE WHEN workspace_kind = 'shared' THEN workspace_kind ELSE 'shared' END,
                trust_state = 'trusted'
            WHERE origin_device_id = ?
              AND (
                    (
                        actor_id IS NULL
                     OR TRIM(actor_id) = ''
                     OR actor_id LIKE 'legacy-sync:%'
                     OR actor_id = ?
                    )
                AND (
                        actor_id IS NULL
                     OR TRIM(actor_id) = ''
                     OR actor_id LIKE 'legacy-sync:%'
                     OR actor_display_name = ?
                     OR workspace_id = ?
                     OR trust_state = 'legacy_unknown'
                    )
              )
            """,
            (
                actor_id,
                str(actor["display_name"]),
                self.LEGACY_SHARED_WORKSPACE_ID,
                self._default_workspace_id(actor_id=actor_id, workspace_kind="shared"),
                cleaned_peer_id,
                actor_id,
                self.LEGACY_SYNC_ACTOR_DISPLAY_NAME,
                self.LEGACY_SHARED_WORKSPACE_ID,
            ),
        )
        if self.conn.in_transaction:
            self.conn.commit()
        return int(cursor.rowcount or 0)

    def reconcile_claimed_same_actor_legacy_memories(self, peer_device_id: str) -> None:
        peer_id = self._clean_optional_str(peer_device_id)
        if not peer_id:
            return
        row = self.conn.execute(
            "SELECT claimed_local_actor FROM sync_peers WHERE peer_device_id = ?",
            (peer_id,),
        ).fetchone()
        if not row or not row["claimed_local_actor"]:
            return
        self._reconcile_claimed_same_actor_legacy_memories()

    def claimable_legacy_device_ids(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT origin_device_id, COUNT(*) AS memory_count, MAX(created_at) AS last_seen_at
            FROM memory_items
            WHERE origin_device_id IS NOT NULL
              AND origin_device_id != ''
              AND origin_device_id != 'unknown'
              AND (
                    (
                        actor_id IS NULL
                     OR TRIM(actor_id) = ''
                     OR actor_id LIKE 'legacy-sync:%'
                    )
                AND (
                        actor_id IS NULL
                     OR TRIM(actor_id) = ''
                     OR actor_id LIKE 'legacy-sync:%'
                     OR actor_display_name = ?
                     OR workspace_id = ?
                     OR trust_state = 'legacy_unknown'
                    )
                )
              AND origin_device_id != ?
              AND origin_device_id NOT IN (
                    SELECT peer_device_id FROM sync_peers WHERE peer_device_id IS NOT NULL
              )
            GROUP BY origin_device_id
            ORDER BY last_seen_at DESC, origin_device_id ASC
            """,
            (self.LEGACY_SYNC_ACTOR_DISPLAY_NAME, self.LEGACY_SHARED_WORKSPACE_ID, self.device_id),
        ).fetchall()
        return [
            {
                "origin_device_id": str(row["origin_device_id"]),
                "memory_count": int(row["memory_count"] or 0),
                "last_seen_at": row["last_seen_at"],
            }
            for row in rows
            if row["origin_device_id"]
        ]

    def claim_legacy_device_id_as_self(self, origin_device_id: str) -> int:
        device_id = self._clean_optional_str(origin_device_id)
        if not device_id or device_id in {"unknown", self.device_id}:
            return 0
        personal_workspace_id = self._default_workspace_id(
            actor_id=self.actor_id,
            workspace_kind="personal",
        )
        cursor = self.conn.execute(
            """
            UPDATE memory_items
            SET actor_id = ?,
                actor_display_name = ?,
                visibility = 'private',
                workspace_id = ?,
                workspace_kind = 'personal',
                trust_state = 'trusted'
            WHERE origin_device_id = ?
              AND origin_device_id NOT IN (
                    SELECT peer_device_id FROM sync_peers WHERE peer_device_id IS NOT NULL
              )
              AND (
                    (
                        actor_id IS NULL
                     OR TRIM(actor_id) = ''
                     OR actor_id LIKE 'legacy-sync:%'
                     OR actor_id = ?
                    )
                AND (
                        actor_id IS NULL
                     OR TRIM(actor_id) = ''
                     OR actor_id LIKE 'legacy-sync:%'
                     OR actor_display_name = ?
                     OR workspace_id = ?
                     OR trust_state = 'legacy_unknown'
                    )
                )
            """,
            (
                self.actor_id,
                self.actor_display_name,
                personal_workspace_id,
                device_id,
                self.actor_id,
                self.LEGACY_SYNC_ACTOR_DISPLAY_NAME,
                self.LEGACY_SHARED_WORKSPACE_ID,
            ),
        )
        if self.conn.in_transaction:
            self.conn.commit()
        return int(cursor.rowcount or 0)

    def same_actor_peer_ids(self) -> list[str]:
        rows = self.conn.execute(
            """
            SELECT peer_device_id
            FROM sync_peers
            WHERE claimed_local_actor = 1 OR actor_id = ?
            ORDER BY peer_device_id
            """,
            (self.actor_id,),
        ).fetchall()
        return [str(row["peer_device_id"]) for row in rows if row["peer_device_id"]]

    def claimed_same_actor_legacy_actor_ids(self) -> list[str]:
        return [f"legacy-sync:{peer_id}" for peer_id in self.same_actor_peer_ids()]

    def memory_owned_by_self(self, item: dict[str, Any] | MemoryResult) -> bool:
        claimed_peers = set(self.same_actor_peer_ids())
        legacy_actor_ids = set(self.claimed_same_actor_legacy_actor_ids())
        if isinstance(item, MemoryResult):
            actor_id = self._clean_optional_str(item.metadata.get("actor_id"))
            origin_device_id = self._clean_optional_str(item.metadata.get("origin_device_id"))
        else:
            actor_id = self._clean_optional_str(item.get("actor_id"))
            origin_device_id = self._clean_optional_str(item.get("origin_device_id"))
        if actor_id == self.actor_id:
            return True
        if origin_device_id and origin_device_id in claimed_peers:
            return True
        return bool(actor_id and actor_id in legacy_actor_ids)

    def _effective_sync_project_filters(
        self, *, peer_device_id: str | None = None
    ) -> tuple[list[str], list[str]]:
        return store_replication._effective_sync_project_filters(
            self, peer_device_id=peer_device_id
        )

    def _sync_project_allowed(
        self, project: str | None, *, peer_device_id: str | None = None
    ) -> bool:
        return store_replication._sync_project_allowed(self, project, peer_device_id=peer_device_id)

    def sharing_review_summary(self, *, project: str | None = None) -> list[dict[str, Any]]:
        selected_project = self._clean_optional_str(project)
        claimed_peers = self.same_actor_peer_ids()
        legacy_actor_ids = self.claimed_same_actor_legacy_actor_ids()
        ownership_clauses = ["memory_items.actor_id = ?"]
        params: list[Any] = [self.actor_id]
        if claimed_peers:
            placeholders = ", ".join("?" for _ in claimed_peers)
            ownership_clauses.append(f"memory_items.origin_device_id IN ({placeholders})")
            params.extend(claimed_peers)
        if legacy_actor_ids:
            placeholders = ", ".join("?" for _ in legacy_actor_ids)
            ownership_clauses.append(f"memory_items.actor_id IN ({placeholders})")
            params.extend(legacy_actor_ids)
        rows = self.conn.execute(
            f"""
            SELECT sync_peers.peer_device_id, sync_peers.name, sync_peers.actor_id,
                   sessions.project AS project, memory_items.visibility AS visibility,
                   COUNT(*) AS total
            FROM sync_peers
            JOIN memory_items ON memory_items.active = 1
            JOIN sessions ON sessions.id = memory_items.session_id
            WHERE sync_peers.actor_id IS NOT NULL
              AND TRIM(sync_peers.actor_id) != ''
              AND sync_peers.actor_id != ?
              AND ({" OR ".join(ownership_clauses)})
            GROUP BY sync_peers.peer_device_id, sync_peers.name, sync_peers.actor_id, sessions.project, memory_items.visibility
            ORDER BY sync_peers.name, sync_peers.peer_device_id
            """,
            [self.actor_id, *params],
        ).fetchall()
        by_peer: dict[str, dict[str, Any]] = {}
        for row in rows:
            peer_device_id = str(row["peer_device_id"])
            actor = self.resolve_actor(str(row["actor_id"] or ""))
            if actor is None or actor["is_local"]:
                continue
            project_name = self._clean_optional_str(row["project"])
            if selected_project:
                project_basename = self._project_basename(project_name) if project_name else ""
                selected_basename = self._project_basename(selected_project)
                if project_name != selected_project and project_basename != selected_basename:
                    continue
            if not self._sync_project_allowed(project_name, peer_device_id=peer_device_id):
                continue
            item = by_peer.setdefault(
                peer_device_id,
                {
                    "peer_device_id": peer_device_id,
                    "peer_name": self._clean_optional_str(row["name"]) or peer_device_id,
                    "actor_id": actor["actor_id"],
                    "actor_display_name": actor["display_name"],
                    "project": selected_project,
                    "scope_label": selected_project or "All allowed projects",
                    "shareable_count": 0,
                    "private_count": 0,
                },
            )
            total = int(row["total"] or 0)
            if str(row["visibility"] or "") == "private":
                item["private_count"] += total
            else:
                item["shareable_count"] += total
        results = list(by_peer.values())
        for item in results:
            item["total_count"] = item["shareable_count"] + item["private_count"]
        return sorted(
            results, key=lambda item: (str(item["peer_name"]).lower(), item["peer_device_id"])
        )

    def count_replication_ops_missing_project(self) -> int:
        return store_replication.count_replication_ops_missing_project(self)

    def filter_replication_ops_for_sync(
        self, ops: Sequence[ReplicationOp], *, peer_device_id: str | None = None
    ) -> tuple[list[ReplicationOp], str | None]:
        return store_replication.filter_replication_ops_for_sync(
            self, ops, peer_device_id=peer_device_id
        )

    def filter_replication_ops_for_sync_with_status(
        self, ops: Sequence[ReplicationOp], *, peer_device_id: str | None = None
    ) -> tuple[list[ReplicationOp], str | None, dict[str, Any] | None]:
        return store_replication.filter_replication_ops_for_sync_with_status(
            self, ops, peer_device_id=peer_device_id
        )

    def migrate_legacy_import_keys(self, *, limit: int = 2000) -> int:
        return store_replication.migrate_legacy_import_keys(self, limit=limit)

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
        return store_replication._legacy_import_key_suffix(import_key)

    def _canonical_legacy_import_key(
        self,
        import_key: str,
        *,
        clock_device_id: str,
        local_device_id: str,
        memory_id: int,
    ) -> str | None:
        return store_replication._canonical_legacy_import_key(
            import_key,
            clock_device_id=clock_device_id,
            local_device_id=local_device_id,
            memory_id=memory_id,
        )

    def _legacy_import_key_aliases(self, import_key: str, *, clock_device_id: str) -> list[str]:
        return store_replication._legacy_import_key_aliases(
            import_key, clock_device_id=clock_device_id
        )

    def _record_replication_delete_for_key(
        self, *, import_key: str, payload: dict[str, Any]
    ) -> None:
        store_replication._record_replication_delete_for_key(
            self, import_key=import_key, payload=payload
        )

    def repair_legacy_import_keys(
        self,
        *,
        limit: int = 10000,
        dry_run: bool = False,
    ) -> dict[str, int]:
        return store_replication.repair_legacy_import_keys(self, limit=limit, dry_run=dry_run)

    @staticmethod
    def _now_iso() -> str:
        return dt.datetime.now(dt.UTC).isoformat()

    @staticmethod
    def compute_cursor(created_at: str, op_id: str) -> str:
        return store_utils.compute_cursor(created_at, op_id)

    @staticmethod
    def _parse_cursor(cursor: str | None) -> tuple[str, str] | None:
        return store_utils.parse_cursor(cursor)

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
        return store_replication._clock_tuple(rev, updated_at, device_id)

    @staticmethod
    def _is_newer_clock(candidate: tuple[int, str, str], existing: tuple[int, str, str]) -> bool:
        return store_replication._is_newer_clock(candidate, existing)

    def _memory_item_clock(self, row: dict[str, Any]) -> tuple[int, str, str]:
        return store_replication._memory_item_clock(self, row)

    def _memory_item_payload(self, row: dict[str, Any]) -> dict[str, Any]:
        return store_replication._memory_item_payload(self, row)

    def _clock_from_payload(self, payload: dict[str, Any]) -> ReplicationClock:
        return store_replication._clock_from_payload(self, payload)

    def _record_memory_item_op(self, memory_id: int, op_type: str) -> None:
        store_replication._record_memory_item_op(self, memory_id, op_type)

    def backfill_replication_ops(self, *, limit: int = 200) -> int:
        return store_replication.backfill_replication_ops(self, limit=limit)

    def backfill_discovery_tokens(self, *, limit_sessions: int = 50) -> int:
        return store_maintenance.backfill_discovery_tokens(self, limit_sessions=limit_sessions)

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

    def _ensure_session_for_replication(
        self, session_id: int | None, started_at: str | None, *, project: str | None = None
    ) -> int | None:
        return store_replication._ensure_session_for_replication(
            self, session_id, started_at, project=project
        )

    def _replication_op_exists(self, op_id: str) -> bool:
        return store_replication._replication_op_exists(self, op_id)

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
        store_replication.record_replication_op(
            self,
            op_id=op_id,
            entity_type=entity_type,
            entity_id=entity_id,
            op_type=op_type,
            payload=payload,
            clock=clock,
            device_id=device_id,
            created_at=created_at,
        )

    def load_replication_ops_since(
        self, cursor: str | None, limit: int = 100, *, device_id: str | None = None
    ) -> tuple[list[ReplicationOp], str | None]:
        return store_replication.load_replication_ops_since(
            self, cursor, limit, device_id=device_id
        )

    def max_replication_cursor(self, *, device_id: str | None = None) -> str | None:
        return store_replication.max_replication_cursor(self, device_id=device_id)

    def normalize_outbound_cursor(self, cursor: str | None, *, device_id: str) -> str | None:
        return store_replication.normalize_outbound_cursor(self, cursor, device_id=device_id)

    def _parse_iso8601(self, value: str) -> dt.datetime | None:
        return store_utils.parse_iso8601(value)

    def _legacy_import_key_device_id(self, key: str) -> str | None:
        return store_replication._legacy_import_key_device_id(key)

    def _sanitize_inbound_replication_op(
        self,
        op: ReplicationOp,
        *,
        source_device_id: str | None,
        received_at: dt.datetime | None,
    ) -> ReplicationOp:
        return store_replication._sanitize_inbound_replication_op(
            self, op, source_device_id=source_device_id, received_at=received_at
        )

    def apply_replication_ops(
        self,
        ops: list[ReplicationOp],
        *,
        source_device_id: str | None = None,
        received_at: str | None = None,
    ) -> dict[str, int]:
        return store_replication.apply_replication_ops(
            self, ops, source_device_id=source_device_id, received_at=received_at
        )

    def _apply_memory_item_upsert(self, op: ReplicationOp) -> str:
        return store_replication._apply_memory_item_upsert(self, op)

    def _apply_memory_item_delete(self, op: ReplicationOp) -> str:
        return store_replication._apply_memory_item_delete(self, op)

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
        return self.get_or_create_stream_session(
            source="opencode",
            stream_id=opencode_session_id,
            cwd=cwd,
            project=project,
            metadata=metadata,
        )

    def get_or_create_stream_session(
        self,
        *,
        source: str,
        stream_id: str,
        cwd: str,
        project: str | None,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        source_norm = source.strip().lower() or "opencode"
        stream_norm = stream_id.strip()
        if not stream_norm:
            raise ValueError("stream_id is required")

        row = self.conn.execute(
            "SELECT session_id FROM opencode_sessions WHERE source = ? AND stream_id = ?",
            (source_norm, stream_norm),
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
            INSERT INTO opencode_sessions(opencode_session_id, source, stream_id, session_id, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source, stream_id) DO UPDATE SET
                opencode_session_id = excluded.opencode_session_id,
                session_id = excluded.session_id
            """,
            (stream_norm, source_norm, stream_norm, session_id, created_at),
        )
        self.conn.commit()
        return session_id

    def get_or_create_raw_event_flush_batch(
        self,
        *,
        opencode_session_id: str,
        source: str = "opencode",
        start_event_seq: int,
        end_event_seq: int,
        extractor_version: str,
    ) -> tuple[int, str]:
        return store_raw_events.get_or_create_raw_event_flush_batch(
            self.conn,
            opencode_session_id=opencode_session_id,
            source=source,
            start_event_seq=start_event_seq,
            end_event_seq=end_event_seq,
            extractor_version=extractor_version,
        )

    def update_raw_event_flush_batch_status(self, batch_id: int, status: str) -> None:
        store_raw_events.update_raw_event_flush_batch_status(self.conn, batch_id, status)

    def record_raw_event(
        self,
        *,
        opencode_session_id: str,
        source: str = "opencode",
        event_id: str,
        event_type: str,
        payload: dict[str, Any],
        ts_wall_ms: int | None = None,
        ts_mono_ms: float | None = None,
    ) -> bool:
        return store_raw_events.record_raw_event(
            self.conn,
            opencode_session_id=opencode_session_id,
            source=source,
            event_id=event_id,
            event_type=event_type,
            payload=payload,
            ts_wall_ms=ts_wall_ms,
            ts_mono_ms=ts_mono_ms,
        )

    def record_raw_events_batch(
        self,
        *,
        opencode_session_id: str,
        source: str = "opencode",
        events: list[dict[str, Any]],
    ) -> dict[str, int]:
        return store_raw_events.record_raw_events_batch(
            self.conn,
            opencode_session_id=opencode_session_id,
            source=source,
            events=events,
        )

    def raw_event_flush_state(self, opencode_session_id: str, *, source: str = "opencode") -> int:
        return store_raw_events.raw_event_flush_state(
            self.conn,
            opencode_session_id,
            source=source,
        )

    def update_raw_event_session_meta(
        self,
        *,
        opencode_session_id: str,
        source: str = "opencode",
        cwd: str | None = None,
        project: str | None = None,
        started_at: str | None = None,
        last_seen_ts_wall_ms: int | None = None,
    ) -> None:
        store_raw_events.update_raw_event_session_meta(
            self.conn,
            opencode_session_id=opencode_session_id,
            source=source,
            cwd=cwd,
            project=project,
            started_at=started_at,
            last_seen_ts_wall_ms=last_seen_ts_wall_ms,
        )

    def raw_event_session_meta(
        self, opencode_session_id: str, *, source: str = "opencode"
    ) -> dict[str, Any]:
        return store_raw_events.raw_event_session_meta(
            self.conn,
            opencode_session_id,
            source=source,
        )

    def update_raw_event_flush_state(
        self,
        opencode_session_id: str,
        last_flushed: int,
        *,
        source: str = "opencode",
    ) -> None:
        store_raw_events.update_raw_event_flush_state(
            self.conn,
            opencode_session_id,
            last_flushed,
            source=source,
        )

    def max_raw_event_seq(self, opencode_session_id: str, *, source: str = "opencode") -> int:
        return store_raw_events.max_raw_event_seq(
            self.conn,
            opencode_session_id,
            source=source,
        )

    def raw_events_since(
        self,
        *,
        opencode_session_id: str,
        source: str = "opencode",
        after_event_seq: int,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        return store_raw_events.raw_events_since(
            self.conn,
            opencode_session_id=opencode_session_id,
            source=source,
            after_event_seq=after_event_seq,
            limit=limit,
        )

    def raw_events_since_by_seq(
        self,
        *,
        opencode_session_id: str,
        source: str = "opencode",
        after_event_seq: int,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        return store_raw_events.raw_events_since_by_seq(
            self.conn,
            opencode_session_id=opencode_session_id,
            source=source,
            after_event_seq=after_event_seq,
            limit=limit,
        )

    def raw_event_sessions_pending_idle_flush(
        self,
        *,
        idle_before_ts_wall_ms: int,
        limit: int = 25,
    ) -> list[dict[str, str]]:
        return store_raw_events.raw_event_sessions_pending_idle_flush(
            self.conn,
            idle_before_ts_wall_ms=idle_before_ts_wall_ms,
            limit=limit,
        )

    def raw_event_sessions_with_pending_queue(self, *, limit: int = 25) -> list[dict[str, str]]:
        return store_raw_events.raw_event_sessions_with_pending_queue(self.conn, limit=limit)

    def purge_raw_events_before(self, cutoff_ts_wall_ms: int) -> int:
        return store_raw_events.purge_raw_events_before(self.conn, cutoff_ts_wall_ms)

    def purge_raw_events(self, max_age_ms: int) -> int:
        return store_raw_events.purge_raw_events(self.conn, max_age_ms)

    def raw_event_backlog(
        self,
        *,
        limit: int = 25,
        source: str | None = None,
    ) -> list[dict[str, Any]]:
        return store_raw_events.raw_event_backlog(self.conn, limit=limit, source=source)

    def raw_event_backlog_totals(self) -> dict[str, int]:
        return store_raw_events.raw_event_backlog_totals(self.conn)

    def raw_event_batch_status_counts(
        self,
        opencode_session_id: str,
        *,
        source: str = "opencode",
    ) -> dict[str, int]:
        return store_raw_events.raw_event_batch_status_counts(
            self.conn,
            opencode_session_id,
            source=source,
        )

    def raw_event_queue_status_counts(
        self,
        opencode_session_id: str,
        *,
        source: str = "opencode",
    ) -> dict[str, int]:
        return store_raw_events.raw_event_queue_status_counts(
            self.conn,
            opencode_session_id,
            source=source,
        )

    def claim_raw_event_flush_batch(self, batch_id: int) -> bool:
        return store_raw_events.claim_raw_event_flush_batch(self.conn, batch_id)

    def raw_event_error_batches(
        self,
        opencode_session_id: str,
        *,
        source: str = "opencode",
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        return store_raw_events.raw_event_error_batches(
            self.conn,
            opencode_session_id,
            source=source,
            limit=limit,
        )

    def raw_event_reliability_metrics(self, *, window_hours: float | None = None) -> dict[str, Any]:
        if window_hours is None:
            return store_raw_events.raw_event_reliability_metrics(self.conn)
        return store_raw_events.raw_event_reliability_metrics_windowed(
            self.conn, window_hours=window_hours
        )

    def mark_stuck_raw_event_batches_as_error(
        self,
        *,
        older_than_iso: str,
        limit: int = 100,
    ) -> int:
        return store_raw_events.mark_stuck_raw_event_batches_as_error(
            self.conn,
            older_than_iso=older_than_iso,
            limit=limit,
        )

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
        content_text_value, content_encoding, content_blob = self._artifact_storage_payload(
            content_text
        )
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
            INSERT INTO artifacts(
                session_id,
                kind,
                path,
                content_text,
                content_hash,
                created_at,
                metadata_json,
                content_encoding,
                content_blob
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                kind,
                path,
                content_text_value,
                content_hash,
                created_at,
                db.to_json(metadata),
                content_encoding,
                content_blob,
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
        user_prompt_id: int | None = None,
    ) -> int:
        kind = validate_memory_kind(kind)
        created_at = self._now_iso()
        tags_text = " ".join(sorted(set(tags or [])))
        metadata_payload = dict(metadata or {})
        metadata_payload.setdefault("clock_device_id", self.device_id)
        provenance = self._resolve_memory_provenance(metadata_payload)
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
                actor_id,
                actor_display_name,
                visibility,
                workspace_id,
                workspace_kind,
                origin_device_id,
                origin_source,
                trust_state,
                user_prompt_id,
                deleted_at,
                rev,
                import_key
            )
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                provenance["actor_id"],
                provenance["actor_display_name"],
                provenance["visibility"],
                provenance["workspace_id"],
                provenance["workspace_kind"],
                provenance["origin_device_id"],
                provenance["origin_source"],
                provenance["trust_state"],
                user_prompt_id,
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
        user_prompt_id: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        kind = validate_memory_kind(kind)
        created_at = self._now_iso()
        tags_text = " ".join(
            store_tags.derive_tags(
                kind=kind,
                title=title,
                concepts=concepts,
                files_read=files_read,
                files_modified=files_modified,
                stopwords=self.STOPWORDS,
            )
        )
        metadata_payload = dict(metadata or {})
        metadata_payload.setdefault("clock_device_id", self.device_id)
        provenance = self._resolve_memory_provenance(metadata_payload)
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
            "user_prompt_id": user_prompt_id,
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
                actor_id,
                actor_display_name,
                visibility,
                workspace_id,
                workspace_kind,
                origin_device_id,
                origin_source,
                trust_state,
                subtitle,
                facts,
                narrative,
                concepts,
                files_read,
                files_modified,
                prompt_number,
                user_prompt_id,
                deleted_at,
                rev,
                import_key
            )
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                provenance["actor_id"],
                provenance["actor_display_name"],
                provenance["visibility"],
                provenance["workspace_id"],
                provenance["workspace_kind"],
                provenance["origin_device_id"],
                provenance["origin_source"],
                provenance["trust_state"],
                subtitle,
                db.to_json(facts or []),
                narrative,
                db.to_json(concepts or []),
                db.to_json(files_read or []),
                db.to_json(files_modified or []),
                prompt_number,
                user_prompt_id,
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
        memory_ids: list[int] | None = None,
    ) -> dict[str, int]:
        return store_maintenance.backfill_tags_text(
            self,
            limit=limit,
            since=since,
            project=project,
            memory_ids=memory_ids,
            active_only=active_only,
            dry_run=dry_run,
        )

    def backfill_vectors(
        self,
        limit: int | None = None,
        since: str | None = None,
        project: str | None = None,
        active_only: bool = True,
        dry_run: bool = False,
        memory_ids: list[int] | None = None,
    ) -> dict[str, int]:
        return store_vectors.backfill_vectors(
            self,
            limit=limit,
            since=since,
            project=project,
            memory_ids=memory_ids,
            active_only=active_only,
            dry_run=dry_run,
        )

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

    def get_prompt_for_memory(self, memory_id: int) -> dict[str, Any] | None:
        row = self.conn.execute(
            """
            SELECT p.*
            FROM memory_items m
            JOIN user_prompts p ON p.id = m.user_prompt_id
            WHERE m.id = ?
            """,
            (memory_id,),
        ).fetchone()
        if row is None:
            return None
        item = dict(row)
        item["metadata_json"] = db.from_json(item.get("metadata_json"))
        return item

    def get_memories_for_prompt(self, prompt_id: int) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT *
            FROM memory_items
            WHERE user_prompt_id = ? AND active = 1
            ORDER BY created_at ASC, id ASC
            """,
            (prompt_id,),
        ).fetchall()
        items = db.rows_to_dicts(rows)
        for item in items:
            item["metadata_json"] = db.from_json(item.get("metadata_json"))
        return items

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
        return store_maintenance.deactivate_low_signal_observations(
            self, limit=limit, dry_run=dry_run
        )

    def deactivate_low_signal_memories(
        self,
        kinds: Iterable[str] | None = None,
        limit: int | None = None,
        dry_run: bool = False,
    ) -> dict[str, int]:
        return store_maintenance.deactivate_low_signal_memories(
            self,
            kinds=kinds,
            limit=limit,
            dry_run=dry_run,
        )

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

    def update_memory_visibility(self, memory_id: int, *, visibility: str) -> dict[str, Any]:
        cleaned_visibility = self._clean_optional_str(visibility)
        if cleaned_visibility not in {"private", "shared"}:
            raise ValueError("visibility must be private or shared")
        row = self.conn.execute(
            "SELECT * FROM memory_items WHERE id = ? AND active = 1",
            (memory_id,),
        ).fetchone()
        if row is None:
            raise LookupError("memory not found")
        row_data = dict(row)
        if not self.memory_owned_by_self(row_data):
            raise PermissionError("memory not owned by self")
        actor_id = self._clean_optional_str(row_data.get("actor_id")) or self.actor_id
        workspace_kind = "shared" if cleaned_visibility == "shared" else "personal"
        current_workspace_id = self._clean_optional_str(row_data.get("workspace_id"))
        if (
            cleaned_visibility == "shared"
            and current_workspace_id
            and current_workspace_id.startswith("shared:")
        ):
            workspace_id = current_workspace_id
        else:
            workspace_id = self._default_workspace_id(
                actor_id=actor_id,
                workspace_kind=workspace_kind,
            )
        metadata = self._normalize_metadata(row_data.get("metadata_json"))
        metadata["visibility"] = cleaned_visibility
        metadata["workspace_kind"] = workspace_kind
        metadata["workspace_id"] = workspace_id
        metadata["clock_device_id"] = self.device_id
        now = self._now_iso()
        rev = int(row_data.get("rev") or 0) + 1
        self.conn.execute(
            """
            UPDATE memory_items
            SET visibility = ?,
                workspace_kind = ?,
                workspace_id = ?,
                updated_at = ?,
                metadata_json = ?,
                rev = ?
            WHERE id = ?
            """,
            (
                cleaned_visibility,
                workspace_kind,
                workspace_id,
                now,
                db.to_json(metadata),
                rev,
                memory_id,
            ),
        )
        self.conn.commit()
        self._record_memory_item_op(memory_id, "upsert")
        updated = self.get(memory_id)
        if updated is None:
            raise LookupError("memory not found")
        return updated

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
        self, limit: int = 10, filters: dict[str, Any] | None = None, offset: int = 0
    ) -> list[dict[str, Any]]:
        filters = filters or {}
        params: list[Any] = []
        where = ["memory_items.active = 1"]
        join_sessions = store_search._extend_memory_filter_clauses(
            self,
            filters,
            where_clauses=where,
            params=params,
        )
        where_clause = " AND ".join(where)
        from_clause = "memory_items"
        if join_sessions:
            from_clause = "memory_items JOIN sessions ON sessions.id = memory_items.session_id"
        rows = self.conn.execute(
            (
                f"SELECT memory_items.* FROM {from_clause} "
                f"WHERE {where_clause} ORDER BY created_at DESC LIMIT ? OFFSET ?"
            ),
            (*params, limit, max(offset, 0)),
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
                "offset": offset,
                "results": len(results),
                "kind": filters.get("kind"),
                "project": filters.get("project"),
                "personal_first": store_search._personal_first_enabled(filters),
            },
        )
        return results

    def recent_by_kinds(
        self,
        kinds: Iterable[str],
        limit: int = 10,
        filters: dict[str, Any] | None = None,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        filters = filters or {}
        kinds_list = [str(kind) for kind in kinds if kind]
        if not kinds_list:
            return []
        params: list[Any] = list(kinds_list)
        where = [
            "memory_items.active = 1",
            "memory_items.kind IN ({})".format(", ".join("?" for _ in kinds_list)),
        ]
        join_sessions = store_search._extend_memory_filter_clauses(
            self,
            filters,
            where_clauses=where,
            params=params,
        )
        where_clause = " AND ".join(where)
        from_clause = "memory_items"
        if join_sessions:
            from_clause = "memory_items JOIN sessions ON sessions.id = memory_items.session_id"
        rows = self.conn.execute(
            (
                f"SELECT memory_items.* FROM {from_clause} "
                f"WHERE {where_clause} ORDER BY created_at DESC LIMIT ? OFFSET ?"
            ),
            (*params, limit, max(offset, 0)),
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
                "offset": offset,
                "results": len(results),
                "kinds": kinds_list,
                "project": filters.get("project"),
            },
        )
        return results

    def search_index(
        self, query: str, limit: int = 10, filters: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        return store_search.search_index(self, query, limit=limit, filters=filters)

    def timeline(
        self,
        query: str | None = None,
        memory_id: int | None = None,
        depth_before: int = 3,
        depth_after: int = 3,
        filters: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        return store_search.timeline(
            self,
            query=query,
            memory_id=memory_id,
            depth_before=depth_before,
            depth_after=depth_after,
            filters=filters,
        )

    def explain(
        self,
        *,
        query: str | None = None,
        ids: Sequence[Any] | None = None,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
        include_pack_context: bool = False,
    ) -> dict[str, Any]:
        return store_search.explain(
            self,
            query=query,
            ids=ids,
            limit=limit,
            filters=filters,
            include_pack_context=include_pack_context,
        )

    def _expand_query(self, query: str) -> str:
        return store_search._expand_query(query)

    def _project_column_clause(self, column_expr: str, project: str) -> tuple[str, list[Any]]:
        return store_utils.project_column_clause(column_expr, project)

    def _project_clause(self, project: str) -> tuple[str, list[Any]]:
        return store_utils.project_clause(project)

    @staticmethod
    def _project_basename(value: str) -> str:
        return store_utils.project_basename(value)

    def normalize_projects(self, *, dry_run: bool = True) -> dict[str, Any]:
        return store_maintenance.normalize_projects(self, dry_run=dry_run)

    def rename_project(
        self, old_name: str, new_name: str, *, dry_run: bool = True
    ) -> dict[str, Any]:
        return store_maintenance.rename_project(self, old_name, new_name, dry_run=dry_run)

    def _query_looks_like_tasks(self, query: str) -> bool:
        return store_search._query_looks_like_tasks(query)

    def _query_looks_like_recall(self, query: str) -> bool:
        return store_search._query_looks_like_recall(query)

    def _task_query_hint(self) -> str:
        return store_search._task_query_hint()

    def _recall_query_hint(self) -> str:
        return store_search._recall_query_hint()

    def _task_fallback_recent(
        self, limit: int, filters: dict[str, Any] | None
    ) -> list[dict[str, Any]]:
        return store_search._task_fallback_recent(self, limit, filters)

    def _recall_fallback_recent(
        self, limit: int, filters: dict[str, Any] | None
    ) -> list[dict[str, Any]]:
        return store_search._recall_fallback_recent(self, limit, filters)

    def _created_at_for(self, item: MemoryResult | dict[str, Any]) -> str:
        return store_search._created_at_for(item)

    def _parse_created_at(self, value: str) -> dt.datetime | None:
        return store_search._parse_created_at(value)

    def _recency_score(self, created_at: str) -> float:
        return store_search._recency_score(created_at)

    def _kind_bonus(self, kind: str | None) -> float:
        return store_search._kind_bonus(kind)

    def _filter_recent_results(
        self, results: Sequence[MemoryResult | dict[str, Any]], days: int
    ) -> list[MemoryResult | dict[str, Any]]:
        return store_search._filter_recent_results(results, days)

    def _tokenize_query(self, query: str) -> list[str]:
        return store_search._tokenize_query(query, self.STOPWORDS)

    def _fuzzy_score(self, query_tokens: list[str], query: str, text: str) -> float:
        return store_search._fuzzy_score(query_tokens, query, text)

    def _fuzzy_search(
        self, query: str, limit: int, filters: dict[str, Any] | None
    ) -> list[dict[str, Any]]:
        return store_search._fuzzy_search(self, query, limit, filters)

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
        return store_search._semantic_search(self, query, limit, filters)

    def _store_vectors(self, memory_id: int, title: str, body_text: str) -> None:
        store_vectors._store_vectors(self, memory_id, title, body_text)

    def _prioritize_task_results(
        self, results: list[dict[str, Any]], limit: int
    ) -> list[dict[str, Any]]:
        return store_search._prioritize_task_results(results, limit)

    def _prioritize_recall_results(
        self, results: list[MemoryResult | dict[str, Any]], limit: int
    ) -> list[MemoryResult | dict[str, Any]]:
        return store_search._prioritize_recall_results(results, limit)

    def _rerank_results(
        self,
        results: list[MemoryResult],
        limit: int,
        recency_days: int | None = None,
    ) -> list[MemoryResult]:
        return store_search._rerank_results(results, limit, recency_days=recency_days)

    def _merge_ranked_results(
        self,
        results: Sequence[MemoryResult | dict[str, Any]],
        query: str,
        limit: int,
        filters: dict[str, Any] | None,
    ) -> list[MemoryResult]:
        return store_search._merge_ranked_results(self, results, query, limit, filters)

    def _timeline_around(
        self,
        anchor: MemoryResult | dict[str, Any],
        depth_before: int,
        depth_after: int,
        filters: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        return store_search._timeline_around(self, anchor, depth_before, depth_after, filters)

    def search(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
        log_usage: bool = True,
    ) -> list[MemoryResult]:
        return store_search.search(self, query, limit=limit, filters=filters, log_usage=log_usage)

    def search_with_diagnostics(
        self,
        query: str,
        limit: int = 10,
        filters: dict[str, Any] | None = None,
        log_usage: bool = True,
    ) -> tuple[list[MemoryResult], dict[str, Any]]:
        return store_search.search_with_diagnostics(
            self,
            query,
            limit=limit,
            filters=filters,
            log_usage=log_usage,
        )

    def build_memory_pack(
        self,
        context: str,
        limit: int = 8,
        token_budget: int | None = None,
        filters: dict[str, Any] | None = None,
        log_usage: bool = True,
    ) -> dict[str, Any]:
        from . import packs as store_packs

        return store_packs.build_memory_pack(
            self,
            context,
            limit=limit,
            token_budget=token_budget,
            filters=filters,
            log_usage=log_usage,
        )

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
            item["content_text"] = self._artifact_text_from_row(item)
            item.pop("content_blob", None)
        return results

    def latest_transcript(self, session_id: int) -> str | None:
        row = self.conn.execute(
            """
            SELECT content_text, content_encoding, content_blob FROM artifacts
            WHERE session_id = ? AND kind = 'transcript'
            ORDER BY id DESC LIMIT 1
            """,
            (session_id,),
        ).fetchone()
        if row:
            return self._artifact_text_from_row(row)
        return None

    def compress_artifacts(
        self,
        *,
        min_bytes: int | None = None,
        limit: int | None = None,
        dry_run: bool = False,
    ) -> dict[str, int]:
        threshold = max(1, int(min_bytes or self.ARTIFACT_COMPRESSION_MIN_BYTES))
        query = """
            SELECT id, content_text
            FROM artifacts
            WHERE content_blob IS NULL
              AND content_text IS NOT NULL
              AND LENGTH(CAST(content_text AS BLOB)) >= ?
            ORDER BY id ASC
        """
        params: list[Any] = [threshold]
        if limit is not None:
            query += " LIMIT ?"
            params.append(int(limit))
        rows = self.conn.execute(query, params).fetchall()

        checked = len(rows)
        compressed = 0
        raw_bytes = 0
        compressed_bytes = 0
        updates: list[tuple[None, str, bytes, int]] = []
        for row in rows:
            text = str(row["content_text"] or "")
            raw = text.encode("utf-8")
            blob = zlib.compress(raw, level=6)
            if len(blob) >= len(raw):
                continue
            raw_bytes += len(raw)
            compressed_bytes += len(blob)
            compressed += 1
            if not dry_run:
                updates.append((None, self.ARTIFACT_COMPRESSION_ENCODING, blob, int(row["id"])))
        if updates:
            self.conn.executemany(
                """
                UPDATE artifacts
                SET content_text = ?, content_encoding = ?, content_blob = ?
                WHERE id = ?
                """,
                updates,
            )
            self.conn.commit()
        return {
            "checked": checked,
            "compressed": compressed,
            "raw_bytes": raw_bytes,
            "compressed_bytes": compressed_bytes,
            "saved_bytes": max(0, raw_bytes - compressed_bytes),
            "dry_run": 1 if dry_run else 0,
        }

    def _artifact_storage_payload(
        self, content_text: str
    ) -> tuple[str | None, str | None, bytes | None]:
        raw = content_text.encode("utf-8")
        if len(raw) < self.ARTIFACT_COMPRESSION_MIN_BYTES:
            return content_text, None, None
        blob = zlib.compress(raw, level=6)
        if len(blob) >= len(raw):
            return content_text, None, None
        return None, self.ARTIFACT_COMPRESSION_ENCODING, blob

    def _artifact_text_from_row(self, row: sqlite3.Row | dict[str, Any]) -> str | None:
        content_text = (
            row["content_text"] if isinstance(row, sqlite3.Row) else row.get("content_text")
        )
        if content_text is not None:
            return str(content_text)
        content_encoding = (
            row["content_encoding"] if isinstance(row, sqlite3.Row) else row.get("content_encoding")
        )
        content_blob = (
            row["content_blob"] if isinstance(row, sqlite3.Row) else row.get("content_blob")
        )
        if not content_encoding or content_blob is None:
            return None
        if str(content_encoding) != self.ARTIFACT_COMPRESSION_ENCODING:
            raise ValueError(f"Unsupported artifact content encoding: {content_encoding}")
        try:
            return zlib.decompress(bytes(content_blob)).decode("utf-8")
        except (zlib.error, UnicodeDecodeError) as exc:
            raise ValueError("Failed to decode compressed artifact content") from exc

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
        return store_usage.record_usage(
            self,
            event,
            session_id=session_id,
            tokens_read=tokens_read,
            tokens_written=tokens_written,
            tokens_saved=tokens_saved,
            metadata=metadata,
        )

    def usage_summary(self, project: str | None = None) -> list[dict[str, Any]]:
        return store_usage.usage_summary(self, project=project)

    def usage_totals(self, project: str | None = None) -> dict[str, Any]:
        return store_usage.usage_totals(self, project=project)

    def recent_pack_events(
        self, limit: int = 10, project: str | None = None
    ) -> list[dict[str, Any]]:
        return store_usage.recent_pack_events(self, limit=limit, project=project)

    def latest_pack_per_project(self) -> list[dict[str, Any]]:
        """Return the most recent pack event for each project."""
        return store_usage.latest_pack_per_project(self)

    def stats(self) -> dict[str, Any]:
        return store_usage.stats(self)
