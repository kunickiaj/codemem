from __future__ import annotations

from pathlib import Path

import typer

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


def test_install_autostart_quiet_linux_returns_false_when_subprocess_missing(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(sync_service_cmds.sys, "platform", "linux")
    monkeypatch.setattr(sync_service_cmds.Path, "home", lambda: tmp_path)

    def _missing_bin(*_args, **_kwargs):
        raise OSError("systemctl missing")

    monkeypatch.setattr(sync_service_cmds.subprocess, "run", _missing_bin)

    assert sync_service_cmds.install_autostart_quiet(user=True) is False


def test_sync_service_start_cmd_falls_back_when_service_action_reports_success(
    capsys, monkeypatch
) -> None:
    cfg = type(
        "Cfg",
        (),
        {
            "sync_enabled": True,
            "sync_host": "127.0.0.1",
            "sync_port": 7337,
            "sync_interval_s": 30,
        },
    )()
    statuses = iter(
        [
            type(
                "S",
                (),
                {"running": False, "mechanism": "service", "detail": "inactive", "pid": None},
            )(),
            type(
                "S",
                (),
                {"running": False, "mechanism": "none", "detail": "unsupported", "pid": None},
            )(),
        ]
    )
    monkeypatch.setattr(sync_service_cmds, "run_service_action_quiet", lambda *_a, **_k: True)

    sync_service_cmds.sync_service_start_cmd(
        load_config=lambda: cfg,
        effective_status=lambda *_a, **_k: next(statuses),
        spawn_daemon=lambda **_k: 4242,
        user=True,
        system=False,
    )

    out = capsys.readouterr().out
    assert "Started sync daemon (pid 4242)" in out


def test_sync_service_stop_cmd_reports_already_stopped_when_service_fails(
    capsys, monkeypatch
) -> None:
    cfg = type("Cfg", (), {"sync_host": "127.0.0.1", "sync_port": 7337})()

    def _raise_exit(*_args, **_kwargs):
        raise typer.Exit(code=1)

    monkeypatch.setattr(sync_service_cmds, "run_service_action", _raise_exit)

    sync_service_cmds.sync_service_stop_cmd(
        load_config=lambda: cfg,
        effective_status=lambda *_a, **_k: type(
            "S", (), {"running": False, "mechanism": "service", "detail": "inactive", "pid": None}
        )(),
        stop_pidfile_with_reason=lambda: type(
            "R", (), {"stopped": False, "reason": "pid_not_running", "pid": 123}
        )(),
        user=True,
        system=False,
    )

    out = capsys.readouterr().out
    assert "Sync already stopped" in out
