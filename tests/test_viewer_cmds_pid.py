from __future__ import annotations

from types import SimpleNamespace
from typing import Any


def test_serve_background_ignores_stale_pid_file(monkeypatch: Any) -> None:
    # If the PID file points at a running process but the port is not listening,
    # the viewer should treat the PID file as stale and proceed to start.
    from codemem.commands import viewer_cmds

    calls: dict[str, Any] = {"popen": 0, "cleared": 0}

    monkeypatch.setattr(viewer_cmds, "_read_pid", lambda *_: 123)
    monkeypatch.setattr(viewer_cmds, "_pid_running", lambda *_: True)
    monkeypatch.setattr(viewer_cmds, "_port_open", lambda *_: False)
    monkeypatch.setattr(
        viewer_cmds, "_clear_pid", lambda *_: calls.__setitem__("cleared", calls["cleared"] + 1)
    )

    def fake_popen(*args: Any, **kwargs: Any) -> Any:
        calls["popen"] += 1
        return SimpleNamespace(pid=999)

    monkeypatch.setattr(viewer_cmds.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(viewer_cmds, "_write_pid", lambda *_: None)

    viewer_cmds.serve(
        db_path=None,
        host="127.0.0.1",
        port=38889,
        background=True,
        stop=False,
        restart=False,
    )

    assert calls["cleared"] == 1
    assert calls["popen"] == 1
