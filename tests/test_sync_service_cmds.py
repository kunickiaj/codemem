from __future__ import annotations

from pathlib import Path

from codemem.commands import sync_service_cmds


class _Result:
    def __init__(self, returncode: int) -> None:
        self.returncode = returncode


def test_install_autostart_quiet_linux_returns_false_on_subprocess_failure(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(sync_service_cmds.sys, "platform", "linux")
    monkeypatch.setattr(sync_service_cmds.Path, "home", lambda: tmp_path)

    calls = {"count": 0}

    def fake_run(command, capture_output, text, check):
        calls["count"] += 1
        if calls["count"] == 2:
            return _Result(1)
        return _Result(0)

    monkeypatch.setattr(sync_service_cmds.subprocess, "run", fake_run)

    assert sync_service_cmds.install_autostart_quiet(user=True) is False


def test_install_autostart_quiet_linux_returns_true_when_commands_succeed(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(sync_service_cmds.sys, "platform", "linux")
    monkeypatch.setattr(sync_service_cmds.Path, "home", lambda: tmp_path)
    monkeypatch.setattr(
        sync_service_cmds.subprocess,
        "run",
        lambda command, capture_output, text, check: _Result(0),
    )

    assert sync_service_cmds.install_autostart_quiet(user=True) is True
