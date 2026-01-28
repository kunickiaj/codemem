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
from .store import MemoryStore
from .utils import resolve_project


def build_store(*, check_same_thread: bool = True) -> MemoryStore:
    db_path = os.environ.get("OPENCODE_MEM_DB", str(DEFAULT_DB_PATH))
    return MemoryStore(Path(db_path), check_same_thread=check_same_thread)


def build_server() -> FastMCP:
    mcp = FastMCP("opencode-mem")
    default_project = os.environ.get("OPENCODE_MEM_PROJECT") or resolve_project(os.getcwd())
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
                kind=kind,
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
                "session_summary",
                "observation",
                "entities",
                "note",
                "decision",
                "discovery",
                "change",
                "feature",
                "bugfix",
                "refactor",
                "exploration",
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
            "intro": "Use this tool when you're new to opencode-mem or unsure when to recall/persist.",
            "client_hint": "If you are unfamiliar with opencode-mem, call memory.learn first.",
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
                "You have access to opencode-mem MCP tools. If unfamiliar, call memory.learn first.\n\n"
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
