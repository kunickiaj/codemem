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


def _attach_ownership_fields(store: MemoryStore, items: list[dict[str, Any]]) -> None:
    for item in items:
        item["owned_by_self"] = store.memory_owned_by_self(item)


def _apply_scope_filter(
    store: MemoryStore, filters: dict[str, Any] | None, scope: str | None
) -> tuple[dict[str, Any], bool]:
    normalized = str(scope or "all").strip().lower()
    if normalized not in {"all", "mine", "theirs", "shared"}:
        return {}, False
    scoped = dict(filters or {})
    if normalized == "mine":
        scoped["ownership_scope"] = "mine"
    elif normalized == "theirs":
        scoped["ownership_scope"] = "theirs"
    elif normalized == "shared":
        scoped["include_visibility"] = ["shared"]
    return scoped, True


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
        try:
            limit = max(1, int(params.get("limit", ["20"])[0]))
            offset = max(0, int(params.get("offset", ["0"])[0]))
        except ValueError:
            handler._send_json({"error": "limit and offset must be int"}, status=400)
            return True
        project = params.get("project", [None])[0]
        scope = params.get("scope", ["all"])[0]
        kinds = [
            "bugfix",
            "change",
            "decision",
            "discovery",
            "exploration",
            "feature",
            "refactor",
        ]
        obs_filters, valid_scope = _apply_scope_filter(
            store, {"project": project} if project else None, scope
        )
        if not valid_scope:
            handler._send_json({"error": "invalid_scope"}, status=400)
            return True
        items = store.recent_by_kinds(
            limit=limit + 1, kinds=kinds, filters=obs_filters, offset=offset
        )
        has_more = len(items) > limit
        if has_more:
            items = items[:limit]
        _attach_session_fields(store, items)
        _attach_ownership_fields(store, items)
        handler._send_json(
            {
                "items": items,
                "pagination": {
                    "limit": limit,
                    "offset": offset,
                    "next_offset": offset + len(items) if has_more else None,
                    "has_more": has_more,
                },
            }
        )
        return True

    if path == "/api/summaries":
        params = parse_qs(query)
        try:
            limit = max(1, int(params.get("limit", ["50"])[0]))
            offset = max(0, int(params.get("offset", ["0"])[0]))
        except ValueError:
            handler._send_json({"error": "limit and offset must be int"}, status=400)
            return True
        project = params.get("project", [None])[0]
        scope = params.get("scope", ["all"])[0]
        filters: dict[str, Any] = {"kind": "session_summary"}
        if project:
            filters["project"] = project
        scoped_filters, valid_scope = _apply_scope_filter(store, filters, scope)
        if not valid_scope:
            handler._send_json({"error": "invalid_scope"}, status=400)
            return True
        items = store.recent(limit=limit + 1, filters=scoped_filters, offset=offset)
        has_more = len(items) > limit
        if has_more:
            items = items[:limit]
        _attach_session_fields(store, items)
        _attach_ownership_fields(store, items)
        handler._send_json(
            {
                "items": items,
                "pagination": {
                    "limit": limit,
                    "offset": offset,
                    "next_offset": offset + len(items) if has_more else None,
                    "has_more": has_more,
                },
            }
        )
        return True

    if path == "/api/session":
        params = parse_qs(query)
        project = params.get("project", [None])[0]

        if project:
            prompts = store.conn.execute(
                "SELECT COUNT(*) AS total FROM user_prompts WHERE project = ?",
                (project,),
            ).fetchone()["total"]
            artifacts = store.conn.execute(
                """
                SELECT COUNT(*) AS total
                FROM artifacts
                JOIN sessions ON sessions.id = artifacts.session_id
                WHERE sessions.project = ?
                """,
                (project,),
            ).fetchone()["total"]
            memories = store.conn.execute(
                """
                SELECT COUNT(*) AS total
                FROM memory_items
                JOIN sessions ON sessions.id = memory_items.session_id
                WHERE sessions.project = ?
                """,
                (project,),
            ).fetchone()["total"]
            observations = store.conn.execute(
                """
                SELECT COUNT(*) AS total
                FROM memory_items
                JOIN sessions ON sessions.id = memory_items.session_id
                WHERE kind != 'session_summary'
                  AND sessions.project = ?
                """,
                (project,),
            ).fetchone()["total"]
        else:
            prompts = store.conn.execute("SELECT COUNT(*) AS total FROM user_prompts").fetchone()[
                "total"
            ]
            artifacts = store.conn.execute("SELECT COUNT(*) AS total FROM artifacts").fetchone()[
                "total"
            ]
            memories = store.conn.execute("SELECT COUNT(*) AS total FROM memory_items").fetchone()[
                "total"
            ]
            observations = store.conn.execute(
                "SELECT COUNT(*) AS total FROM memory_items WHERE kind != 'session_summary'"
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
        scope = params.get("scope", ["all"])[0]
        pack_filters, valid_scope = _apply_scope_filter(
            store, {"project": project} if project else None, scope
        )
        if not valid_scope:
            handler._send_json({"error": "invalid_scope"}, status=400)
            return True
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
        scope = params.get("scope", ["all"])[0]
        filters: dict[str, Any] = {}
        if kind:
            filters["kind"] = kind
        if project:
            filters["project"] = project
        scoped_filters, valid_scope = _apply_scope_filter(
            store, filters if filters else None, scope
        )
        if not valid_scope:
            handler._send_json({"error": "invalid_scope"}, status=400)
            return True
        items = store.recent(limit=limit, filters=scoped_filters)
        _attach_session_fields(store, items)
        _attach_ownership_fields(store, items)
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


def handle_post(
    handler: _ViewerHandler, store: MemoryStore, path: str, payload: dict[str, Any] | None
) -> bool:
    if path != "/api/memories/visibility":
        return False
    if payload is None:
        handler._send_json({"error": "invalid json"}, status=400)
        return True
    memory_id = payload.get("memory_id")
    visibility = payload.get("visibility")
    try:
        resolved_memory_id = int(memory_id)
    except (TypeError, ValueError):
        handler._send_json({"error": "memory_id must be int"}, status=400)
        return True
    if not isinstance(visibility, str) or visibility.strip() not in {"private", "shared"}:
        handler._send_json({"error": "visibility must be private or shared"}, status=400)
        return True
    try:
        item = store.update_memory_visibility(
            resolved_memory_id,
            visibility=visibility.strip(),
        )
    except ValueError as exc:
        handler._send_json({"error": str(exc)}, status=400)
        return True
    except LookupError:
        handler._send_json({"error": "memory not found"}, status=404)
        return True
    except PermissionError:
        handler._send_json({"error": "memory not owned by self"}, status=403)
        return True
    item["owned_by_self"] = store.memory_owned_by_self(item)
    handler._send_json({"item": item})
    return True
