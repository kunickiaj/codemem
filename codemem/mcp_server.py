from __future__ import annotations

import atexit
import os
import threading
import weakref
from pathlib import Path
from typing import Any

try:
    from mcp.server.fastmcp import FastMCP
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "mcp package is required for the MCP server. Install with `uv pip install -e .`"
    ) from exc

from .config import load_config
from .db import DEFAULT_DB_PATH
from .memory_kinds import ALLOWED_MEMORY_KINDS, validate_memory_kind
from .store import MemoryStore
from .utils import resolve_project

SQLITE_INT64_MIN = -(2**63)
SQLITE_INT64_MAX = (2**63) - 1


def build_store(*, check_same_thread: bool = True) -> MemoryStore:
    db_path = os.environ.get("CODEMEM_DB", str(DEFAULT_DB_PATH))
    return MemoryStore(Path(db_path), check_same_thread=check_same_thread)


def build_server() -> FastMCP:
    mcp = FastMCP("codemem")
    default_project = os.environ.get("CODEMEM_PROJECT") or resolve_project(os.getcwd())
    thread_local = threading.local()
    store_lock = threading.Lock()
    store_pool: weakref.WeakSet[MemoryStore] = weakref.WeakSet()

    def get_store() -> MemoryStore:
        store = getattr(thread_local, "store", None)
        if store is None:
            store = build_store()
            thread_local.store = store
            with store_lock:
                store_pool.add(store)
        return store

    def close_all_stores() -> None:
        with store_lock:
            stores = list(store_pool)
        for store in stores:
            try:
                store.close()
            except Exception:
                continue

    atexit.register(close_all_stores)

    def with_store(handler):
        return handler(get_store())

    def _dedupe_ordered_ids(ids: list[Any]) -> tuple[list[int], list[str]]:
        deduped: list[int] = []
        seen: set[int] = set()
        invalid: list[str] = []
        for raw_id in ids:
            if isinstance(raw_id, (bool, float)):
                invalid.append(str(raw_id))
                continue
            try:
                memory_id = int(raw_id)
            except (TypeError, ValueError, OverflowError):
                invalid.append(str(raw_id))
                continue
            if not isinstance(raw_id, int) and not (isinstance(raw_id, str) and raw_id.isdigit()):
                invalid.append(str(raw_id))
                continue
            if memory_id < SQLITE_INT64_MIN or memory_id > SQLITE_INT64_MAX:
                invalid.append(str(raw_id))
                continue
            if memory_id <= 0:
                invalid.append(str(raw_id))
                continue
            if memory_id in seen:
                continue
            deduped.append(memory_id)
            seen.add(memory_id)
        return deduped, invalid

    def _project_matches_scope(scope_project: str, item_project: str | None) -> bool:
        if item_project is None:
            return False
        scope_value = scope_project.strip().replace("\\", "/")
        if not scope_value:
            return True
        if "/" in scope_value:
            scope_value = Path(scope_value).name
        normalized_item = item_project.replace("\\", "/")
        return normalized_item == scope_value or normalized_item.endswith(f"/{scope_value}")

    @mcp.tool()
    def memory_search_index(
        query: str,
        limit: int = 8,
        kind: str | None = None,
        project: str | None = None,
    ) -> dict[str, Any]:
        def handler(store: MemoryStore) -> dict[str, Any]:
            filters: dict[str, Any] = {}
            if kind:
                filters["kind"] = kind
            resolved_project = project or default_project
            if resolved_project:
                filters["project"] = resolved_project
            items = store.search_index(query, limit=limit, filters=filters or None)
            return {"items": items}

        return with_store(handler)

    @mcp.tool()
    def memory_timeline(
        query: str | None = None,
        memory_id: int | None = None,
        depth_before: int = 3,
        depth_after: int = 3,
        project: str | None = None,
    ) -> dict[str, Any]:
        def handler(store: MemoryStore) -> dict[str, Any]:
            filters: dict[str, Any] = {}
            resolved_project = project or default_project
            if resolved_project:
                filters["project"] = resolved_project
            items = store.timeline(
                query=query,
                memory_id=memory_id,
                depth_before=depth_before,
                depth_after=depth_after,
                filters=filters or None,
            )
            return {"items": items}

        return with_store(handler)

    @mcp.tool()
    def memory_expand(
        ids: list[Any],
        depth_before: int = 3,
        depth_after: int = 3,
        include_observations: bool = False,
        project: str | None = None,
    ) -> dict[str, Any]:
        def handler(store: MemoryStore) -> dict[str, Any]:
            resolved_project = project or default_project
            filters = {"project": resolved_project} if resolved_project else None
            ordered_ids, invalid_ids = _dedupe_ordered_ids(ids)

            errors: list[dict[str, Any]] = []
            if invalid_ids:
                errors.append(
                    {
                        "code": "INVALID_ARGUMENT",
                        "field": "ids",
                        "message": "some ids are not valid integers",
                        "ids": invalid_ids,
                    }
                )

            missing_not_found: list[int] = []
            missing_project_mismatch: list[int] = []
            anchors: list[dict[str, Any]] = []
            timeline_items: list[dict[str, Any]] = []
            timeline_seen: set[int] = set()

            session_projects: dict[int, str | None] = {}

            for memory_id in ordered_ids:
                item = store.get(memory_id)
                if not item or not item.get("active", 1):
                    missing_not_found.append(memory_id)
                    continue

                session_id = int(item.get("session_id") or 0)
                item_project = session_projects.get(session_id)
                if session_id and session_id not in session_projects:
                    row = store.conn.execute(
                        "SELECT project FROM sessions WHERE id = ?",
                        (session_id,),
                    ).fetchone()
                    item_project = row["project"] if row else None
                    session_projects[session_id] = item_project

                if resolved_project and not _project_matches_scope(resolved_project, item_project):
                    missing_project_mismatch.append(memory_id)
                    continue

                anchors.append(item)
                expanded = store.timeline(
                    memory_id=memory_id,
                    depth_before=depth_before,
                    depth_after=depth_after,
                    filters=filters,
                )
                for expanded_item in expanded:
                    expanded_id = int(expanded_item.get("id") or 0)
                    if expanded_id <= 0 or expanded_id in timeline_seen:
                        continue
                    timeline_seen.add(expanded_id)
                    timeline_items.append(expanded_item)

            if missing_not_found:
                errors.append(
                    {
                        "code": "NOT_FOUND",
                        "field": "ids",
                        "message": "some requested ids were not found",
                        "ids": missing_not_found,
                    }
                )
            if missing_project_mismatch:
                errors.append(
                    {
                        "code": "PROJECT_MISMATCH",
                        "field": "project",
                        "message": "some requested ids are outside the requested project scope",
                        "ids": missing_project_mismatch,
                    }
                )

            missing_not_found_set = set(missing_not_found)
            missing_project_mismatch_set = set(missing_project_mismatch)
            missing_ids = [
                memory_id
                for memory_id in ordered_ids
                if memory_id in missing_not_found_set or memory_id in missing_project_mismatch_set
            ]

            observations: list[dict[str, Any]] = []
            if include_observations:
                observation_ids: list[int] = []
                observation_seen: set[int] = set()
                for item in anchors + timeline_items:
                    item_id = int(item.get("id") or 0)
                    if item_id <= 0 or item_id in observation_seen:
                        continue
                    observation_seen.add(item_id)
                    observation_ids.append(item_id)
                observations_by_id = {
                    int(item.get("id") or 0): item for item in store.get_many(observation_ids)
                }
                observations = [
                    observations_by_id[item_id]
                    for item_id in observation_ids
                    if item_id in observations_by_id
                ]

            return {
                "anchors": anchors,
                "timeline": timeline_items,
                "observations": observations,
                "missing_ids": missing_ids,
                "errors": errors,
                "metadata": {
                    "project": resolved_project,
                    "requested_ids_count": len(ordered_ids),
                    "returned_anchor_count": len(anchors),
                    "timeline_count": len(timeline_items),
                    "include_observations": include_observations,
                },
            }

        return with_store(handler)

    @mcp.tool()
    def memory_get_observations(ids: list[int]) -> dict[str, Any]:
        def handler(store: MemoryStore) -> dict[str, Any]:
            items = store.get_many(ids)
            return {"items": items}

        return with_store(handler)

    @mcp.tool()
    def memory_search(
        query: str,
        limit: int = 5,
        kind: str | None = None,
        project: str | None = None,
    ) -> dict[str, Any]:
        def handler(store: MemoryStore) -> dict[str, Any]:
            filters: dict[str, Any] = {}
            if kind:
                filters["kind"] = kind
            resolved_project = project or default_project
            if resolved_project:
                filters["project"] = resolved_project
            matches = store.search(query, limit=limit, filters=filters or None)
            return {
                "items": [
                    {
                        "id": m.id,
                        "title": m.title,
                        "kind": m.kind,
                        "body": m.body_text,
                        "confidence": m.confidence,
                        "score": m.score,
                        "session_id": m.session_id,
                        "metadata": m.metadata,
                    }
                    for m in matches
                ]
            }

        return with_store(handler)

    @mcp.tool()
    def memory_get(memory_id: int) -> dict[str, Any]:
        def handler(store: MemoryStore) -> dict[str, Any]:
            item = store.get(memory_id)
            if not item:
                return {"error": "not_found"}
            return item

        return with_store(handler)

    @mcp.tool()
    def memory_recent(
        limit: int = 8, kind: str | None = None, project: str | None = None
    ) -> dict[str, Any]:
        def handler(store: MemoryStore) -> dict[str, Any]:
            filters: dict[str, Any] = {}
            if kind:
                filters["kind"] = kind
            resolved_project = project or default_project
            if resolved_project:
                filters["project"] = resolved_project
            items = store.recent(limit=limit, filters=filters or None)
            return {"items": items}

        return with_store(handler)

    @mcp.tool()
    def memory_pack(
        context: str, limit: int | None = None, project: str | None = None
    ) -> dict[str, Any]:
        def handler(store: MemoryStore) -> dict[str, Any]:
            resolved_project = project or default_project
            filters = {"project": resolved_project} if resolved_project else None
            config = load_config()
            return store.build_memory_pack(
                context=context,
                limit=limit or config.pack_observation_limit,
                filters=filters,
            )

        return with_store(handler)

    @mcp.tool()
    def memory_remember(
        kind: str,
        title: str,
        body: str,
        confidence: float = 0.5,
        project: str | None = None,
    ) -> dict[str, Any]:
        def handler(store: MemoryStore) -> dict[str, Any]:
            resolved_project = project or default_project
            kind_normalized = validate_memory_kind(kind)
            # Use client cwd if we could, but for now we default to server's cwd
            # Ideally client should pass cwd too, but project is the critical bit.
            session_id = store.start_session(
                cwd=os.getcwd(),
                project=resolved_project,
                git_remote=None,
                git_branch=None,
                user=os.environ.get("USER", "unknown"),
                tool_version="mcp",
                metadata={"mcp": True},
            )
            mem_id = store.remember(
                session_id,
                kind=kind_normalized,
                title=title,
                body_text=body,
                confidence=confidence,
            )
            store.end_session(session_id, metadata={"mcp": True})
            return {"id": mem_id}

        return with_store(handler)

    @mcp.tool()
    def memory_forget(memory_id: int) -> dict[str, Any]:
        def handler(store: MemoryStore) -> dict[str, Any]:
            store.forget(memory_id)
            return {"status": "ok"}

        return with_store(handler)

    @mcp.tool()
    def memory_schema() -> dict[str, Any]:
        return {
            "kinds": [
                *ALLOWED_MEMORY_KINDS,
            ],
            "fields": {
                "title": "short text",
                "body": "long text",
                "subtitle": "short text",
                "facts": "list<string>",
                "narrative": "long text",
                "concepts": "list<string>",
                "files_read": "list<string>",
                "files_modified": "list<string>",
                "prompt_number": "int",
            },
            "filters": ["kind", "session_id", "since", "project"],
        }

    @mcp.tool()
    def memory_learn() -> dict[str, Any]:
        return {
            "intro": "Use this tool when you're new to codemem or unsure when to recall/persist.",
            "client_hint": "If you are unfamiliar with codemem, call memory.learn first.",
            "recall": {
                "when": [
                    "Start of a task or when the user references prior work.",
                    "When you need background context, decisions, or recent changes.",
                ],
                "how": [
                    "Use memory.search_index to get compact candidates.",
                    "Use memory.timeline to expand around a promising memory.",
                    "Use memory.get_observations for full details only when needed.",
                    "Use memory.pack for quick one-shot context blocks.",
                    "Use the project filter unless the user requests cross-project context.",
                ],
                "examples": [
                    'memory.search_index("billing cache bug", limit=5)',
                    "memory.timeline(memory_id=123)",
                    "memory.get_observations([123, 456])",
                ],
            },
            "persistence": {
                "when": [
                    "Milestones (task done, key decision, new facts learned).",
                    "Notable regressions or follow-ups that should be remembered.",
                ],
                "how": [
                    "Use memory.remember with kind decision/observation/note.",
                    "Keep titles short and bodies high-signal.",
                    "ALWAYS pass the project parameter if known.",
                ],
                "examples": [
                    'memory.remember(kind="decision", title="Switch to async cache", body="...why...", project="my-service")',
                    'memory.remember(kind="observation", title="Fixed retry loop", body="...impact...", project="my-service")',
                ],
            },
            "forget": {
                "when": [
                    "Accidental or sensitive data stored in memory items.",
                    "Obsolete or incorrect items that should no longer surface.",
                ],
                "how": [
                    "Call memory.forget(id) to mark the item inactive.",
                    "Prefer forgetting over overwriting to preserve auditability.",
                ],
                "examples": ["memory.forget(123)"],
            },
            "prompt_hint": "At task start: call memory.search_index; during work: memory.timeline + memory.get_observations; at milestones: memory.remember.",
            "recommended_system_prompt": (
                "Trigger policy (1-liner): If the user references prior work or starts a task, "
                "immediately call memory.search_index; then use memory.timeline + memory.get_observations; "
                "at milestones, call memory.remember; use memory.forget for incorrect/sensitive items.\n\n"
                "System prompt:\n"
                "You have access to codemem MCP tools. If unfamiliar, call memory.learn first.\n\n"
                "Recall:\n"
                "- Start of any task: call memory.search_index with a concise task query.\n"
                '- If prior work is referenced ("as before", "last time", "we already did…", "regression"), '
                "call memory.search_index or memory.timeline.\n"
                "- Use memory.get_observations only after filtering IDs.\n"
                "- Prefer project-scoped queries unless the user asks for cross-project.\n\n"
                "Persistence:\n"
                "- On milestones (task done, key decision, new facts learned), call memory.remember.\n"
                "- Use kind=decision for tradeoffs, kind=observation for outcomes, kind=note for small useful facts.\n"
                "- Keep titles short and bodies high-signal.\n"
                "- ALWAYS pass the project parameter if known.\n\n"
                "Safety:\n"
                "- Use memory.forget(id) for incorrect or sensitive items.\n\n"
                "Examples:\n"
                '- memory.search_index("billing cache bug")\n'
                "- memory.timeline(memory_id=123)\n"
                "- memory.get_observations([123, 456])\n"
                '- memory.remember(kind="decision", title="Use async cache", body="Chose async cache to avoid lock contention in X.", project="my-service")\n'
                '- memory.remember(kind="observation", title="Fixed retry loop", body="Root cause was Y; added guard in Z.", project="my-service")\n'
                "- memory.forget(123)\n"
            ),
        }

    return mcp


def run() -> None:
    server = build_server()
    server.run()


if __name__ == "__main__":
    run()
