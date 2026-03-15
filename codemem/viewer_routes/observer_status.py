from __future__ import annotations

from typing import Any, Protocol

from .. import plugin_ingest as _plugin_ingest
from ..observer import probe_available_credentials
from ..viewer_raw_events import RAW_EVENT_SWEEPER


class _ViewerHandler(Protocol):
    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None: ...


class _Store(Protocol):
    def raw_event_backlog_totals(self) -> dict[str, int]: ...

    def latest_raw_event_flush_failure(
        self, *, source: str | None = None
    ) -> dict[str, Any] | None: ...


def _build_failure_impact(
    latest_failure: dict[str, Any] | None,
    queue_totals: dict[str, int],
    auth_backoff: dict[str, Any],
) -> str | None:
    if latest_failure is None:
        return None
    pending = int(queue_totals.get("pending") or 0)
    sessions = int(queue_totals.get("sessions") or 0)
    if bool(auth_backoff.get("active")):
        remaining = int(auth_backoff.get("remaining_s") or 0)
        return f"Queue retries paused for ~{remaining}s after an observer auth failure."
    if pending > 0:
        return f"{pending} queued raw events across {sessions} session(s) are waiting on a successful flush."
    return "Failed flush batches are pending retry."


def handle_get(handler: _ViewerHandler, store: _Store, path: str) -> bool:
    if path != "/api/observer-status":
        return False

    available = probe_available_credentials()
    active: dict[str, Any] | None = None
    observer = _plugin_ingest.OBSERVER
    if observer is not None:
        active = observer.get_status()
    latest_failure = store.latest_raw_event_flush_failure()
    queue_totals = store.raw_event_backlog_totals()
    auth_backoff = RAW_EVENT_SWEEPER.auth_backoff_status()
    if latest_failure is not None:
        latest_failure = dict(latest_failure)
        latest_failure["impact"] = _build_failure_impact(latest_failure, queue_totals, auth_backoff)

    handler._send_json(
        {
            "active": active,
            "available_credentials": available,
            "latest_failure": latest_failure,
            "queue": {
                **queue_totals,
                "auth_backoff_active": bool(auth_backoff.get("active")),
                "auth_backoff_remaining_s": int(auth_backoff.get("remaining_s") or 0),
            },
        }
    )
    return True
