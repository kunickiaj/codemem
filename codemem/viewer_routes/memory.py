from __future__ import annotations

from typing import Any, Protocol
from urllib.parse import parse_qs

from ..config import load_config
from ..db import from_json
from ..store import MemoryStore


class _ViewerHandler(Protocol):
    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None: ...


def _attach_session_fields(store: MemoryStore, items: list[dict[str, Any]]) -> None:
    session_ids: list[int] = []
    seen: set[int] = set()
    for item in items:
        value = item.get("session_id")
        if value is None:
            continue
        try:
            sid = int(value)
        except (TypeError, ValueError):
            continue
        if sid in seen:
            continue
        seen.add(sid)
        session_ids.append(sid)

    if not session_ids:
        return

    placeholders = ",".join("?" for _ in session_ids)
    rows = store.conn.execute(
        f"SELECT id, project, cwd FROM sessions WHERE id IN ({placeholders})",
        session_ids,
    ).fetchall()
    by_session: dict[int, dict[str, str]] = {}
    for row in rows:
        try:
            sid = int(row["id"])
        except (TypeError, ValueError):
            continue
        project_raw = row["project"] or ""
        project = store._project_basename(project_raw.strip()) if project_raw else ""
        cwd = row["cwd"] or ""
        by_session[sid] = {"project": project, "cwd": cwd}

    for item in items:
        value = item.get("session_id")
        if value is None:
            continue
        try:
            sid = int(value)
        except (TypeError, ValueError):
            continue
        fields = by_session.get(sid)
        if not fields:
            continue
        item.setdefault("project", fields.get("project") or "")
        item.setdefault("cwd", fields.get("cwd") or "")


def handle_get(handler: _ViewerHandler, store: MemoryStore, path: str, query: str) -> bool:
    # Compatibility endpoints used by the bundled web UI.
    if path == "/api/memories":
        path = "/api/observations"

    if path == "/api/sessions":
        params = parse_qs(query)
        limit = int(params.get("limit", ["20"])[0])
        sessions = store.all_sessions()[:limit]
        for item in sessions:
            item["metadata_json"] = from_json(item.get("metadata_json"))
        handler._send_json({"items": sessions})
        return True

    if path == "/api/projects":
        sessions = store.all_sessions()
        projects = sorted(
            {
                store._project_basename(p.strip())
                for s in sessions
                if (p := s.get("project"))
                and isinstance(p, str)
                and p.strip()
                and not p.strip().lower().startswith("fatal:")
                and store._project_basename(p.strip())
            }
        )
        handler._send_json({"projects": projects})
        return True

    if path == "/api/observations":
        params = parse_qs(query)
        limit = int(params.get("limit", ["20"])[0])
        project = params.get("project", [None])[0]
        kinds = [
            "bugfix",
            "change",
            "decision",
            "discovery",
            "exploration",
            "feature",
            "refactor",
        ]
        obs_filters = {"project": project} if project else None
        items = store.recent_by_kinds(limit=limit, kinds=kinds, filters=obs_filters)
        _attach_session_fields(store, items)
        handler._send_json({"items": items})
        return True

    if path == "/api/summaries":
        params = parse_qs(query)
        limit = int(params.get("limit", ["50"])[0])
        project = params.get("project", [None])[0]
        filters: dict[str, Any] = {"kind": "session_summary"}
        if project:
            filters["project"] = project
        items = store.recent(limit=limit, filters=filters)
        _attach_session_fields(store, items)
        handler._send_json({"items": items})
        return True

    if path == "/api/session":
        params = parse_qs(query)
        project = params.get("project", [None])[0]

        prompts = store.conn.execute(
            "SELECT COUNT(*) AS total FROM user_prompts WHERE (? IS NULL OR project = ?)",
            (project, project),
        ).fetchone()["total"]
        artifacts = store.conn.execute(
            """
            SELECT COUNT(*) AS total
            FROM artifacts
            JOIN sessions ON sessions.id = artifacts.session_id
            WHERE (? IS NULL OR sessions.project = ?)
            """,
            (project, project),
        ).fetchone()["total"]
        memories = store.conn.execute(
            """
            SELECT COUNT(*) AS total
            FROM memory_items
            JOIN sessions ON sessions.id = memory_items.session_id
            WHERE (? IS NULL OR sessions.project = ?)
            """,
            (project, project),
        ).fetchone()["total"]
        observations = store.conn.execute(
            """
            SELECT COUNT(*) AS total
            FROM memory_items
            JOIN sessions ON sessions.id = memory_items.session_id
            WHERE kind != 'session_summary'
              AND (? IS NULL OR sessions.project = ?)
            """,
            (project, project),
        ).fetchone()["total"]
        total = int(prompts or 0) + int(artifacts or 0) + int(memories or 0)

        handler._send_json(
            {
                "total": total,
                "memories": int(memories or 0),
                "artifacts": int(artifacts or 0),
                "prompts": int(prompts or 0),
                "observations": int(observations or 0),
            }
        )
        return True

    if path == "/api/pack":
        params = parse_qs(query)
        context = params.get("context", [""])[0]
        if not context:
            handler._send_json({"error": "context required"}, status=400)
            return True
        config = load_config()
        try:
            limit = int(params.get("limit", [str(config.pack_observation_limit)])[0])
        except ValueError:
            handler._send_json({"error": "limit must be int"}, status=400)
            return True
        token_budget = params.get("token_budget", [None])[0]
        if token_budget in (None, ""):
            token_budget_value = None
        else:
            try:
                token_budget_value = int(token_budget)
            except ValueError:
                handler._send_json({"error": "token_budget must be int"}, status=400)
                return True
        project = params.get("project", [None])[0]
        pack_filters = {"project": project} if project else None
        pack = store.build_memory_pack(
            context=context,
            limit=limit,
            token_budget=token_budget_value,
            filters=pack_filters,
        )
        handler._send_json(pack)
        return True

    if path == "/api/memory":
        params = parse_qs(query)
        limit = int(params.get("limit", ["20"])[0])
        kind = params.get("kind", [None])[0]
        project = params.get("project", [None])[0]
        filters: dict[str, Any] = {}
        if kind:
            filters["kind"] = kind
        if project:
            filters["project"] = project
        items = store.recent(limit=limit, filters=filters if filters else None)
        _attach_session_fields(store, items)
        handler._send_json({"items": items})
        return True

    if path == "/api/artifacts":
        params = parse_qs(query)
        session_id = params.get("session_id", [None])[0]
        if not session_id:
            handler._send_json({"error": "session_id required"}, status=400)
            return True
        items = store.session_artifacts(int(session_id))
        handler._send_json({"items": items})
        return True

    return False
