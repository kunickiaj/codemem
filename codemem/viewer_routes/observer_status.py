from __future__ import annotations

from typing import Any, Protocol

from .. import plugin_ingest as _plugin_ingest
from ..observer import probe_available_credentials


class _ViewerHandler(Protocol):
    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None: ...


def handle_get(handler: _ViewerHandler, path: str) -> bool:
    if path != "/api/observer-status":
        return False

    available = probe_available_credentials()
    active: dict[str, Any] | None = None
    observer = _plugin_ingest.OBSERVER
    if observer is not None:
        active = observer.get_status()

    handler._send_json(
        {
            "active": active,
            "available_credentials": available,
        }
    )
    return True
