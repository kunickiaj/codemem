from __future__ import annotations

import datetime as dt
import json
from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

from .. import db
from ..summarizer import is_low_signal_observation
from . import tags as store_tags

if TYPE_CHECKING:
    from ._store import MemoryStore


def _safe_json_list(value: str | None) -> list[str]:
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


def _session_discovery_tokens_from_raw_events(store: MemoryStore, opencode_session_id: str) -> int:
    row = store.conn.execute(
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


def _session_discovery_tokens_by_prompt(
    store: MemoryStore, opencode_session_id: str
) -> dict[int, int]:
    rows = store.conn.execute(
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


def _session_discovery_tokens_from_transcript(store: MemoryStore, session_id: int) -> int:
    row = store.conn.execute(
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
    return store.estimate_tokens(text)


def _prompt_length_weights(store: MemoryStore, session_id: int) -> dict[int, int]:
    rows = store.conn.execute(
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


def backfill_discovery_tokens(store: MemoryStore, *, limit_sessions: int = 50) -> int:
    """Backfill discovery_group + discovery_tokens for observer memories.

    Best effort uses raw assistant_usage events when possible; otherwise it falls back to
    session transcript estimates and prompt length weighting.
    """

    target_rows = store.conn.execute(
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

        items = store.conn.execute(
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

        by_prompt = _session_discovery_tokens_by_prompt(store, opencode_session_id)
        session_tokens = _session_discovery_tokens_from_raw_events(store, opencode_session_id)
        source_label = "usage" if session_tokens > 0 else "estimate"
        if session_tokens <= 0:
            session_tokens = _session_discovery_tokens_from_transcript(store, session_id)

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
                weights = _prompt_length_weights(store, session_id)
                allocation = _allocate_tokens_by_weight(
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

        now = store._now_iso()
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
                store.conn.execute(
                    "UPDATE memory_items SET metadata_json = ?, updated_at = ? WHERE id = ?",
                    (db.to_json(meta), now, memory_id),
                )
                updated += 1
        store.conn.commit()

    return updated


def backfill_tags_text(
    store: MemoryStore,
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
        clause, clause_params = store._project_clause(project)
        if clause:
            where_clauses.append(clause)
            params.extend(clause_params)
        join_sessions = True
    where = " AND ".join(where_clauses)
    join_clause = "JOIN sessions ON sessions.id = memory_items.session_id" if join_sessions else ""
    limit_clause = "LIMIT ?" if limit else ""
    if limit:
        params.append(limit)

    rows = store.conn.execute(
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
        concepts = _safe_json_list(row["concepts"])
        files_read = _safe_json_list(row["files_read"])
        files_modified = _safe_json_list(row["files_modified"])
        tags = store_tags.derive_tags(
            kind=kind,
            title=title,
            concepts=concepts,
            files_read=files_read,
            files_modified=files_modified,
            stopwords=store.STOPWORDS,
        )
        tags_text = " ".join(tags)
        if not tags_text:
            skipped += 1
            continue
        if not dry_run:
            store.conn.execute(
                "UPDATE memory_items SET tags_text = ?, updated_at = ? WHERE id = ?",
                (tags_text, now, memory_id),
            )
        updated += 1

    if not dry_run:
        store.conn.commit()
    return {"checked": checked, "updated": updated, "skipped": skipped}


def deactivate_low_signal_observations(
    store: MemoryStore, limit: int | None = None, dry_run: bool = False
) -> dict[str, int]:
    return deactivate_low_signal_memories(
        store, kinds=["observation"], limit=limit, dry_run=dry_run
    )


def deactivate_low_signal_memories(
    store: MemoryStore,
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
    rows = store.conn.execute(
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
        store.conn.execute(
            f"UPDATE memory_items SET active = 0, updated_at = ? WHERE id IN ({placeholders})",
            (now, *chunk),
        )
    store.conn.commit()
    return {"checked": checked, "deactivated": len(ids)}


def normalize_projects(store: MemoryStore, *, dry_run: bool = True) -> dict[str, Any]:
    """Normalize project values in the DB.

    - Rewrites path-like projects ("/Users/.../repo") to their basename ("repo")
      to avoid machine-specific anchoring.
    - Rewrites obvious git error strings ("fatal: ...") to the session cwd basename
      when available.
    - Rewrites project="/" to the session cwd basename when possible.

    This is intended as a one-time cleanup when imports or older versions stored
    inconsistent project identifiers.
    """

    session_rows = store.conn.execute(
        "SELECT id, cwd, project FROM sessions ORDER BY started_at DESC"
    ).fetchall()
    raw_rows = store.conn.execute(
        "SELECT opencode_session_id, cwd, project FROM raw_event_sessions"
    ).fetchall()
    usage_rows = store.conn.execute(
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
                new_value = store._project_basename(cwd.strip())
        elif "/" in proj or "\\" in proj:
            base = store._project_basename(proj)
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
                new_value = store._project_basename(cwd.strip())
        elif "/" in proj or "\\" in proj:
            base = store._project_basename(proj)
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
            base = store._project_basename(proj)
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
        store.conn.execute(
            "UPDATE sessions SET project = ? WHERE id = ?",
            (project, session_id),
        )
    for project, opencode_session_id in raw_updates:
        store.conn.execute(
            "UPDATE raw_event_sessions SET project = ? WHERE opencode_session_id = ?",
            (project, opencode_session_id),
        )
    for metadata_json, usage_id in usage_updates:
        store.conn.execute(
            "UPDATE usage_events SET metadata_json = ? WHERE id = ?",
            (metadata_json, usage_id),
        )
    store.conn.commit()
    return preview


def rename_project(
    store: MemoryStore, old_name: str, new_name: str, *, dry_run: bool = True
) -> dict[str, Any]:
    """Rename a project across sessions, raw_event_sessions, and usage_events.

    Matches both exact project names and path-like values whose basename matches
    (e.g. old_name="product-context" also matches "/Users/.../product-context").
    """

    old_basename = store._project_basename((old_name or "").strip())
    if not old_basename:
        return {"dry_run": dry_run, "error": "empty old_name"}

    new_basename = store._project_basename((new_name or "").strip())
    if not new_basename:
        return {"dry_run": dry_run, "error": "empty new_name"}

    def _escape_like(value: str, *, escape: str = "!") -> str:
        # Escape LIKE wildcards (% _) and the escape char itself.
        return (
            value.replace(escape, escape + escape)
            .replace("%", escape + "%")
            .replace("_", escape + "_")
        )

    escaped_old = _escape_like(old_basename)

    # Match exact name OR any path ending in the old basename (literal)
    session_rows = store.conn.execute(
        """
        SELECT id, project FROM sessions
        WHERE project = ?
           OR project LIKE ? ESCAPE '!'
           OR project LIKE ? ESCAPE '!'
        """,
        (old_basename, f"%/{escaped_old}", f"%\\{escaped_old}"),
    ).fetchall()

    raw_rows = store.conn.execute(
        """
        SELECT opencode_session_id, project FROM raw_event_sessions
        WHERE project = ?
           OR project LIKE ? ESCAPE '!'
           OR project LIKE ? ESCAPE '!'
        """,
        (old_basename, f"%/{escaped_old}", f"%\\{escaped_old}"),
    ).fetchall()

    # Usage events can embed a project filter directly in metadata_json and may have no session_id.
    usage_rows = store.conn.execute("SELECT id, metadata_json FROM usage_events").fetchall()
    usage_updates: list[tuple[str, int]] = []
    for row in usage_rows:
        metadata = db.from_json(row["metadata_json"]) if row["metadata_json"] else {}
        if not isinstance(metadata, dict):
            continue
        project_value = metadata.get("project")
        if not isinstance(project_value, str):
            continue
        proj_base = store._project_basename(project_value.strip())
        if proj_base == old_basename:
            metadata["project"] = new_basename
            usage_updates.append((db.to_json(metadata), int(row["id"])))

    preview = {
        "dry_run": dry_run,
        "old_name": old_basename,
        "new_name": new_basename,
        "sessions_to_update": len(session_rows),
        "raw_event_sessions_to_update": len(raw_rows),
        "usage_events_to_update": len(usage_updates),
    }
    if dry_run:
        return preview

    with store.conn:
        for row in session_rows:
            store.conn.execute(
                "UPDATE sessions SET project = ? WHERE id = ?",
                (new_basename, int(row["id"])),
            )
        for row in raw_rows:
            store.conn.execute(
                "UPDATE raw_event_sessions SET project = ? WHERE opencode_session_id = ?",
                (new_basename, str(row["opencode_session_id"])),
            )
        for metadata_json, usage_id in usage_updates:
            store.conn.execute(
                "UPDATE usage_events SET metadata_json = ? WHERE id = ?",
                (metadata_json, usage_id),
            )
    return preview
