from __future__ import annotations

from typing import Any, Protocol
from urllib.parse import parse_qs

from ..store import MemoryStore


class _ViewerHandler(Protocol):
    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None: ...


def handle_get(handler: _ViewerHandler, store: MemoryStore, path: str, query: str) -> bool:
    if path == "/api/stats":
        handler._send_json(store.stats())
        return True

    if path == "/api/usage":
        params = parse_qs(query)
        project_filter = params.get("project", [None])[0]
        events_global = store.usage_summary()
        totals_global = store.usage_totals()
        events_filtered = None
        totals_filtered = None
        if project_filter:
            events_filtered = store.usage_summary(project_filter)
            totals_filtered = store.usage_totals(project_filter)
        recent_packs = store.recent_pack_events(limit=10, project=project_filter)
        handler._send_json(
            {
                "project": project_filter,
                "events": events_filtered if project_filter else events_global,
                "totals": totals_filtered if project_filter else totals_global,
                "events_global": events_global,
                "totals_global": totals_global,
                "events_filtered": events_filtered,
                "totals_filtered": totals_filtered,
                "recent_packs": recent_packs,
            }
        )
        return True

    return False
