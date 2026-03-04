from __future__ import annotations

import json

from codemem.commands.raw_events_cmds import claude_integration_status_cmd


class _FakeStore:
    def __init__(self, items: list[dict[str, object]]) -> None:
        self._items = items

    def raw_event_backlog(
        self,
        *,
        limit: int = 25,
        source: str | None = None,
    ) -> list[dict[str, object]]:
        items = self._items
        if source is not None:
            items = [item for item in items if item.get("source") == source]
        return items[:limit]

    def raw_event_batch_status_counts(self, stream_id: str, *, source: str) -> dict[str, int]:
        _ = source
        if stream_id == "sess-fail":
            return {"started": 0, "running": 0, "error": 1, "completed": 0}
        return {"started": 0, "running": 0, "error": 0, "completed": 0}

    def raw_event_queue_status_counts(self, stream_id: str, *, source: str) -> dict[str, int]:
        _ = source
        if stream_id == "sess-run":
            return {"pending": 0, "claimed": 1, "failed": 0, "completed": 0}
        if stream_id == "sess-fail":
            return {"pending": 0, "claimed": 0, "failed": 1, "completed": 0}
        return {"pending": 0, "claimed": 0, "failed": 0, "completed": 0}


def test_claude_integration_status_cmd_reports_red_on_failed_streams(capsys) -> None:
    store = _FakeStore(
        [
            {"source": "claude", "stream_id": "sess-run", "pending": 3, "project": "alpha"},
            {"source": "claude", "stream_id": "sess-fail", "pending": 4, "project": "alpha"},
            {"source": "opencode", "stream_id": "sess-oc", "pending": 9, "project": "beta"},
        ]
    )

    claude_integration_status_cmd(
        store,  # type: ignore[arg-type]
        limit=100,
        observer_runtime="claude_sidecar",
        claude_command=["claude"],
        sweeper_interval_s=30,
    )

    out = capsys.readouterr().out.strip()
    payload = json.loads(out)
    assert payload["health"] == "red"
    assert payload["claude_streams"] == 2
    assert payload["pending_events"] == 7
    assert payload["running_streams"] == 1
    assert payload["errored_streams"] == 1
    assert payload["queue_failed"] == 1
    assert payload["observer_runtime"] == "claude_sidecar"


def test_claude_integration_status_cmd_reports_green_when_idle(capsys) -> None:
    store = _FakeStore([])

    claude_integration_status_cmd(
        store,  # type: ignore[arg-type]
        limit=100,
        observer_runtime="api_http",
        claude_command=["claude"],
        sweeper_interval_s=30,
    )

    out = capsys.readouterr().out.strip()
    payload = json.loads(out)
    assert payload["health"] == "green"
    assert payload["claude_streams"] == 0
    assert payload["pending_events"] == 0


def test_claude_integration_status_cmd_limits_claude_streams_only(capsys) -> None:
    store = _FakeStore(
        [
            {"source": "opencode", "stream_id": "sess-oc", "pending": 99, "project": "beta"},
            {"source": "claude", "stream_id": "sess-cld", "pending": 2, "project": "alpha"},
        ]
    )

    claude_integration_status_cmd(
        store,  # type: ignore[arg-type]
        limit=1,
        observer_runtime="api_http",
        claude_command=["claude"],
        sweeper_interval_s=30,
    )

    out = capsys.readouterr().out.strip()
    payload = json.loads(out)
    assert payload["claude_streams"] == 1
    assert payload["pending_events"] == 2
