from __future__ import annotations

import signal
from pathlib import Path

from codemem import sync_runtime


def test_stop_pidfile_does_not_kill_unrelated_process(monkeypatch, tmp_path: Path) -> None:
    pid_path = tmp_path / "sync.pid"
    pid_path.write_text("123\n")
    monkeypatch.setenv("CODEMEM_SYNC_PID", str(pid_path))
    monkeypatch.setattr(sync_runtime, "_pid_running", lambda pid: True)
    monkeypatch.setattr(sync_runtime, "_pid_is_sync_daemon", lambda pid: False)

    def _unexpected_kill(pid: int, sig: int) -> None:
        raise AssertionError("stop_pidfile should not signal unrelated processes")

    monkeypatch.setattr(sync_runtime.os, "kill", _unexpected_kill)

    assert sync_runtime.stop_pidfile() is False
    assert not pid_path.exists()


def test_stop_pidfile_kills_verified_sync_daemon(monkeypatch, tmp_path: Path) -> None:
    pid_path = tmp_path / "sync.pid"
    pid_path.write_text("456\n")
    monkeypatch.setenv("CODEMEM_SYNC_PID", str(pid_path))
    monkeypatch.setattr(sync_runtime, "_pid_is_sync_daemon", lambda pid: True)

    checks = iter([True, False])
    monkeypatch.setattr(sync_runtime, "_pid_running", lambda pid: next(checks, False))
    monkeypatch.setattr(sync_runtime.time, "sleep", lambda _n: None)

    sent: list[tuple[int, int]] = []
    monkeypatch.setattr(sync_runtime.os, "kill", lambda pid, sig: sent.append((pid, sig)))

    assert sync_runtime.stop_pidfile() is True
    assert sent == [(456, signal.SIGTERM)]
    assert not pid_path.exists()


def test_effective_status_ignores_pidfile_for_non_sync_process(monkeypatch, tmp_path: Path) -> None:
    pid_path = tmp_path / "sync.pid"
    pid_path.write_text("321\n")
    monkeypatch.setenv("CODEMEM_SYNC_PID", str(pid_path))
    monkeypatch.setattr(sync_runtime.sys, "platform", "win32")
    monkeypatch.setattr(sync_runtime, "_port_open", lambda host, port: False)
    monkeypatch.setattr(sync_runtime, "_pid_running", lambda pid: True)
    monkeypatch.setattr(sync_runtime, "_pid_is_sync_daemon", lambda pid: False)

    status = sync_runtime.effective_status("127.0.0.1", 7337)

    assert status.running is False
    assert status.mechanism == "none"
    assert status.detail == "unsupported"


def test_pid_command_missing_ps_returns_none(monkeypatch) -> None:
    def _missing_ps(*_args, **_kwargs):
        raise FileNotFoundError

    monkeypatch.setattr(sync_runtime.subprocess, "run", _missing_ps)

    assert sync_runtime._pid_command(123) is None
