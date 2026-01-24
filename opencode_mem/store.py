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
from typing import Any, cast

from . import db
from .semantic import chunk_text, embed_texts, get_embedding_client, hash_text
from .summarizer import Summary, is_low_signal_observation


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

                cur = self.conn.execute(
                    "SELECT 1 FROM raw_events WHERE opencode_session_id = ? AND event_id = ?",
                    (opencode_session_id, event_id),
                ).fetchone()
                if cur is not None:
                    skipped += 1
                    continue

                row = self.conn.execute(
                    """
                    UPDATE raw_event_sessions
                    SET last_received_event_seq = last_received_event_seq + 1,
                        updated_at = ?
                    WHERE opencode_session_id = ?
                    RETURNING last_received_event_seq
                    """,
                    (now, opencode_session_id),
                ).fetchone()
                if row is None:
                    raise RuntimeError("Failed to allocate raw event seq")
                event_seq = int(row["last_received_event_seq"])

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
                            event_id,
                            event_seq,
                            event_type,
                            ts_wall_ms,
                            ts_mono_ms,
                            db.to_json(payload),
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
        counts = {"started": 0, "completed": 0, "error": 0}
        for row in rows:
            status = str(row["status"] or "")
            if status in counts:
                counts[status] = int(row["n"])
        return counts

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
            UPDATE raw_event_flush_batches
            SET status = 'error', updated_at = ?
            WHERE status = 'started' AND updated_at < ?
            LIMIT ?
            """,
            (now, older_than_iso, limit),
        )
        self.conn.commit()
        return int(cur.rowcount or 0)

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
        created_at = dt.datetime.now(dt.UTC).isoformat()
        tags_text = " ".join(sorted(set(tags or [])))
        import_key = None
        if metadata and metadata.get("import_key"):
            import_key = metadata.get("import_key")
        if metadata and metadata.get("flush_batch"):
            meta_text = db.to_json(metadata)
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
                import_key
            )
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
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
                db.to_json(metadata),
                import_key,
            ),
        )
        self.conn.commit()
        lastrowid = cur.lastrowid
        if lastrowid is None:
            raise RuntimeError("Failed to create memory item")
        memory_id = int(lastrowid)
        self._store_vectors(memory_id, title, body_text)
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
        created_at = dt.datetime.now(dt.UTC).isoformat()
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
        import_key = None
        if metadata_payload.get("import_key"):
            import_key = metadata_payload.get("import_key")
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
                import_key
            )
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                import_key,
            ),
        )
        self.conn.commit()
        lastrowid = cur.lastrowid
        if lastrowid is None:
            raise RuntimeError("Failed to create observation")
        memory_id = int(lastrowid)
        self._store_vectors(memory_id, title, narrative)
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
        self.conn.execute(
            "UPDATE memory_items SET active = 0, updated_at = ? WHERE id = ?",
            (dt.datetime.now(dt.UTC).isoformat(), memory_id),
        )
        self.conn.commit()

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

    def _project_clause(self, project: str) -> tuple[str, list[Any]]:
        project = project.strip()
        if not project:
            return "", []
        if "/" in project or "\\" in project:
            return "sessions.project = ?", [project]
        return (
            "(sessions.project = ? OR sessions.project LIKE ? OR sessions.project LIKE ?)",
            [project, f"%/{project}", f"%\\{project}"],
        )

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
                    if tokens > 0:
                        return tokens
                except (TypeError, ValueError):
                    pass
            title = item.title if isinstance(item, MemoryResult) else item.get("title", "")
            body = item.body_text if isinstance(item, MemoryResult) else item.get("body_text", "")
            return self.estimate_tokens(f"{title} {body}".strip())

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
        work_tokens = sum(estimate_work_tokens(m) for m in final_items)
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
        tokens_saved = max(0, work_tokens - pack_tokens)
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
        if work_tokens > 0:
            compression_ratio = float(pack_tokens) / float(work_tokens)
            overhead_tokens = int(pack_tokens) - int(work_tokens)

        avoided_work_ratio = None
        if avoided_tokens_total > 0:
            avoided_work_ratio = float(avoided_tokens_total) / float(pack_tokens or 1)

        metrics = {
            "limit": limit,
            "items": len(formatted),
            "token_budget": token_budget,
            "project": (filters or {}).get("project"),
            "fallback": "recent" if fallback_used else None,
            "work_tokens": work_tokens,
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

    def usage_summary(self) -> list[dict[str, Any]]:
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

    def recent_pack_events(
        self, limit: int = 10, project: str | None = None
    ) -> list[dict[str, Any]]:
        if project:
            rows = self.conn.execute(
                """
                SELECT id, session_id, event, tokens_read, tokens_written, tokens_saved,
                       created_at, metadata_json
                FROM usage_events
                WHERE event = 'pack'
                  AND json_extract(metadata_json, '$.project') = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (project, limit),
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
