from __future__ import annotations

import errno
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


def test_serve_stop_uses_port_pid_when_port_probe_fails(monkeypatch: Any) -> None:
    from codemem.commands import viewer_cmds

    calls: dict[str, Any] = {"kill": 0, "cleared": 0, "running_checks": 0}

    monkeypatch.setattr(viewer_cmds, "_read_pid", lambda *_: None)
    monkeypatch.setattr(viewer_cmds, "_port_open", lambda *_: False)
    monkeypatch.setattr(viewer_cmds, "_pid_for_port", lambda *_: 321)

    def fake_pid_running(*_args: Any, **_kwargs: Any) -> bool:
        calls["running_checks"] += 1
        return calls["running_checks"] == 1

    monkeypatch.setattr(viewer_cmds, "_pid_running", fake_pid_running)
    monkeypatch.setattr(
        viewer_cmds, "_clear_pid", lambda *_: calls.__setitem__("cleared", calls["cleared"] + 1)
    )
    monkeypatch.setattr(viewer_cmds.time, "sleep", lambda *_: None)

    def fake_kill(pid: int, _sig: int) -> None:
        assert pid == 321
        calls["kill"] += 1

    monkeypatch.setattr(viewer_cmds.os, "kill", fake_kill)

    viewer_cmds.serve(
        db_path=None,
        host="127.0.0.1",
        port=38888,
        background=False,
        stop=True,
        restart=False,
    )

    assert calls["kill"] == 1
    assert calls["cleared"] == 1


def test_serve_foreground_handles_eaddrinuse(monkeypatch: Any) -> None:
    from codemem.commands import viewer_cmds

    calls: dict[str, int] = {"start": 0, "port_pid": 0}

    monkeypatch.setattr(viewer_cmds, "_port_open", lambda *_: False)

    def fake_pid_for_port(*_args: Any, **_kwargs: Any) -> int | None:
        calls["port_pid"] += 1
        if calls["port_pid"] == 1:
            return None
        return 456

    monkeypatch.setattr(viewer_cmds, "_pid_for_port", fake_pid_for_port)

    def fake_start_viewer(*_args: Any, **_kwargs: Any) -> None:
        calls["start"] += 1
        raise OSError(errno.EADDRINUSE, "Address already in use")

    monkeypatch.setattr(viewer_cmds, "start_viewer", fake_start_viewer)

    viewer_cmds.serve(
        db_path=None,
        host="127.0.0.1",
        port=38888,
        background=False,
        stop=False,
        restart=False,
    )

    assert calls["start"] == 1
