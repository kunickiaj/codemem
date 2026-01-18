from __future__ import annotations

import datetime as dt
import difflib
import hashlib
import math
import re
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
        cur = self.conn.execute(
            """
            INSERT INTO sessions(started_at, cwd, project, git_remote, git_branch, user, tool_version, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
            ),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def end_session(self, session_id: int, metadata: dict[str, Any] | None = None) -> None:
        ended_at = dt.datetime.now(dt.UTC).isoformat()
        metadata_text = None if metadata is None else db.to_json(metadata)
        self.conn.execute(
            "UPDATE sessions SET ended_at = ?, metadata_json = COALESCE(?, metadata_json) WHERE id = ?",
            (ended_at, metadata_text, session_id),
        )
        self.conn.commit()

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
        return int(cur.lastrowid)

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
        cur = self.conn.execute(
            """
            INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
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
            ),
        )
        self.conn.commit()
        memory_id = int(cur.lastrowid)
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
        tags_text = ""
        metadata_payload = dict(metadata or {})
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
                prompt_number
            )
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            ),
        )
        self.conn.commit()
        memory_id = int(cur.lastrowid)
        self._store_vectors(memory_id, title, narrative)
        return memory_id

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
        cur = self.conn.execute(
            """
            INSERT INTO user_prompts(session_id, project, prompt_text, prompt_number, created_at, created_at_epoch, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                project,
                prompt_text,
                prompt_number,
                created_at,
                created_at_epoch,
                db.to_json(metadata),
            ),
        )
        self.conn.commit()
        return int(cur.lastrowid)

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
                metadata_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            ),
        )
        self.conn.commit()
        return int(cur.lastrowid)

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
        self, results: list[MemoryResult | dict[str, Any]], days: int
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
        params: list[Any] = [query_embedding]
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
        params.append(limit)
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
    ) -> dict[str, Any]:
        fallback_used = False
        merge_results = False
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
        if token_budget:
            running = 0
            trimmed = []
            for m in matches:
                body_text = m.body_text if isinstance(m, MemoryResult) else m.get("body_text", "")
                est = self.estimate_tokens(body_text)
                if running + est > token_budget and trimmed:
                    break
                running += est
                trimmed.append(m)
            matches = trimmed

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
            if isinstance(discovery_tokens, (int, float)) and discovery_tokens > 0:
                return int(discovery_tokens)
            title = item.title if isinstance(item, MemoryResult) else item.get("title", "")
            body = item.body_text if isinstance(item, MemoryResult) else item.get("body_text", "")
            return self.estimate_tokens(f"{title} {body}".strip())

        formatted = [
            {
                "id": m.id if isinstance(m, MemoryResult) else m.get("id"),
                "kind": m.kind if isinstance(m, MemoryResult) else m.get("kind"),
                "title": m.title if isinstance(m, MemoryResult) else m.get("title"),
                "body": m.body_text if isinstance(m, MemoryResult) else m.get("body_text"),
                "confidence": m.confidence if isinstance(m, MemoryResult) else m.get("confidence"),
                "tags": m.tags_text if isinstance(m, MemoryResult) else m.get("tags_text"),
            }
            for m in matches
        ]
        text_parts = [f"[{m['id']}] ({m['kind']}) {m['title']} - {m['body']}" for m in formatted]
        pack_text = "\n".join(text_parts)
        pack_tokens = self.estimate_tokens(pack_text)
        work_tokens = sum(estimate_work_tokens(m) for m in matches)
        tokens_saved = max(0, work_tokens - pack_tokens)
        semantic_hits = 0
        if merge_results:
            semantic_ids = {
                item.get("id") for item in self._semantic_search(context, limit, filters)
            }
            for item in formatted:
                if item.get("id") in semantic_ids:
                    semantic_hits += 1

        self.record_usage(
            "pack",
            tokens_read=pack_tokens,
            tokens_saved=tokens_saved,
            metadata={
                "limit": limit,
                "items": len(formatted),
                "token_budget": token_budget,
                "project": (filters or {}).get("project"),
                "fallback": "recent" if fallback_used else None,
                "work_tokens": work_tokens,
                "semantic_candidates": semantic_candidates,
                "semantic_hits": semantic_hits,
            },
        )
        return {
            "context": context,
            "items": formatted,
            "pack_text": pack_text,
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
        return int(cur.lastrowid)

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

    def recent_pack_events(self, limit: int = 10) -> list[dict[str, Any]]:
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

        usage_rows = self.conn.execute(
            """
            SELECT event, COUNT(*) as count, SUM(tokens_read) as tokens_read,
                   SUM(tokens_saved) as tokens_saved
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
            },
            "usage": usage,
        }
