from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from codemem import sync_runtime


def test_stop_pidfile_does_not_kill_unrelated_process(monkeypatch, tmp_path: Path) -> None:
    pid_path = tmp_path / "sync.pid"
    pid_path.write_text("123\n")
    monkeypatch.setenv("CODEMEM_SYNC_PID", str(pid_path))
    monkeypatch.setattr(sync_runtime, "_pid_running", lambda pid: True)
    monkeypatch.setattr(
        sync_runtime, "_pid_command_status", lambda pid: ("python -m http.server", "ok")
    )

    def _unexpected_kill(pid: int, sig: int) -> None:
        raise AssertionError("stop_pidfile should not signal unrelated processes")

    monkeypatch.setattr(sync_runtime.os, "kill", _unexpected_kill)

    result = sync_runtime.stop_pidfile_with_reason()
    assert result.stopped is False
    assert result.reason == "pid_unverified"
    assert result.pid == 123
    assert pid_path.exists()


def test_stop_pidfile_kills_verified_sync_daemon(monkeypatch, tmp_path: Path) -> None:
    pid_path = tmp_path / "sync.pid"
    pid_path.write_text("456\n")
    monkeypatch.setenv("CODEMEM_SYNC_PID", str(pid_path))
    monkeypatch.setattr(
        sync_runtime, "_pid_command_status", lambda pid: ("codemem sync daemon", "ok")
    )

    checks = iter([True, False])
    monkeypatch.setattr(sync_runtime, "_pid_running", lambda pid: next(checks, False))
    monkeypatch.setattr(sync_runtime.time, "sleep", lambda _n: None)

    sent: list[tuple[int, int]] = []
    monkeypatch.setattr(sync_runtime.os, "kill", lambda pid, sig: sent.append((pid, sig)))

    result = sync_runtime.stop_pidfile_with_reason()
    assert result.stopped is True
    assert result.reason == "stopped"
    assert result.pid == 456
    assert sent == [(456, signal.SIGTERM)]
    assert not pid_path.exists()


def test_effective_status_ignores_pidfile_for_non_sync_process(monkeypatch, tmp_path: Path) -> None:
    pid_path = tmp_path / "sync.pid"
    pid_path.write_text("321\n")
    monkeypatch.setenv("CODEMEM_SYNC_PID", str(pid_path))
    monkeypatch.setattr(sync_runtime.sys, "platform", "win32")
    monkeypatch.setattr(sync_runtime, "_port_open", lambda host, port: False)
    monkeypatch.setattr(sync_runtime, "_pid_running", lambda pid: True)
    monkeypatch.setattr(
        sync_runtime, "_pid_command_status", lambda pid: ("python -m http.server", "ok")
    )

    status = sync_runtime.effective_status("127.0.0.1", 7337)

    assert status.running is False
    assert status.mechanism == "pidfile"
    assert status.detail == "pid running but not codemem sync daemon"
    assert status.pid == 321


def test_effective_status_reports_unverified_when_ps_missing(monkeypatch, tmp_path: Path) -> None:
    pid_path = tmp_path / "sync.pid"
    pid_path.write_text("987\n")
    monkeypatch.setenv("CODEMEM_SYNC_PID", str(pid_path))
    monkeypatch.setattr(sync_runtime.sys, "platform", "win32")
    monkeypatch.setattr(sync_runtime, "_port_open", lambda host, port: False)
    monkeypatch.setattr(sync_runtime, "_pid_running", lambda pid: True)
    monkeypatch.setattr(sync_runtime, "_pid_command_status", lambda pid: (None, "ps_unavailable"))

    status = sync_runtime.effective_status("127.0.0.1", 7337)

    assert status.running is False
    assert status.mechanism == "pidfile"
    assert status.detail == "pid running but unverified (ps unavailable)"
    assert status.pid == 987


def test_effective_status_keeps_port_running_when_pid_unverified(
    monkeypatch, tmp_path: Path
) -> None:
    pid_path = tmp_path / "sync.pid"
    pid_path.write_text("777\n")
    monkeypatch.setenv("CODEMEM_SYNC_PID", str(pid_path))
    monkeypatch.setattr(sync_runtime.sys, "platform", "win32")
    monkeypatch.setattr(sync_runtime, "_pid_running", lambda pid: True)
    monkeypatch.setattr(sync_runtime, "_pid_command_status", lambda pid: (None, "ps_unavailable"))
    monkeypatch.setattr(sync_runtime, "_port_open", lambda host, port: True)

    status = sync_runtime.effective_status("127.0.0.1", 7337)

    assert status.running is True
    assert status.mechanism == "port"
    assert "pid running but unverified (ps unavailable)" in status.detail
    assert status.pid == 777


def test_stop_pidfile_returns_ps_unavailable_reason(monkeypatch, tmp_path: Path) -> None:
    pid_path = tmp_path / "sync.pid"
    pid_path.write_text("654\n")
    monkeypatch.setenv("CODEMEM_SYNC_PID", str(pid_path))
    monkeypatch.setattr(sync_runtime, "_pid_running", lambda pid: True)
    monkeypatch.setattr(sync_runtime, "_pid_command_status", lambda pid: (None, "ps_unavailable"))
    monkeypatch.setattr(
        sync_runtime.os,
        "kill",
        lambda pid, sig: (_ for _ in ()).throw(AssertionError("should not signal unverified pid")),
    )

    result = sync_runtime.stop_pidfile_with_reason()

    assert result.stopped is False
    assert result.reason == "ps_unavailable"
    assert result.pid == 654


def test_pid_command_missing_ps_returns_none(monkeypatch) -> None:
    def _missing_ps(*_args, **_kwargs):
        raise FileNotFoundError

    monkeypatch.setattr(sync_runtime.subprocess, "run", _missing_ps)

    assert sync_runtime._pid_command(123) is None


def test_is_sync_daemon_command_accepts_direct_and_wrapped_invocations() -> None:
    assert sync_runtime._is_sync_daemon_command("codemem sync daemon --host 0.0.0.0")
    assert sync_runtime._is_sync_daemon_command("/opt/bin/codemem sync daemon --interval-s 120")
    assert sync_runtime._is_sync_daemon_command("opencode-mem sync daemon --port 7337")
    assert sync_runtime._is_sync_daemon_command(
        "uv run --directory /repo codemem sync daemon --host 0.0.0.0"
    )
    assert sync_runtime._is_sync_daemon_command(
        "uvx --from git+https://github.com/kunickiaj/codemem.git codemem sync daemon"
    )
    assert sync_runtime._is_sync_daemon_command("python -m codemem sync daemon")
    assert sync_runtime._is_sync_daemon_command(
        "codemem sync daemon --db-path /home/o'connor/.codemem/mem.sqlite"
    )


def test_is_sync_daemon_command_accepts_windows_and_configured_binary(monkeypatch) -> None:
    assert sync_runtime._is_sync_daemon_command(r"C:\\Tools\\codemem.exe sync daemon")
    monkeypatch.setenv("CODEMEM_SYNC_BIN", "/custom/bin/codemem-local")
    assert sync_runtime._is_sync_daemon_command(
        "/custom/bin/codemem-local sync daemon --interval-s 90"
    )


def test_is_sync_daemon_command_rejects_non_daemon_or_broad_matches() -> None:
    assert not sync_runtime._is_sync_daemon_command("codemem sync status")
    assert not sync_runtime._is_sync_daemon_command("python -m codemem sync status")
    assert not sync_runtime._is_sync_daemon_command("sync-and-daemon-helper --sync --daemon")
    assert not sync_runtime._is_sync_daemon_command("echo sync daemon")
    assert not sync_runtime._is_sync_daemon_command("bash -lc 'echo codemem sync daemon'")


def _wait_until(predicate, timeout_s: float = 3.0, interval_s: float = 0.05) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval_s)
    return predicate()


@pytest.mark.skipif(sys.platform.startswith("win"), reason="requires ps command semantics")
def test_stop_pidfile_integration_stops_owned_process(tmp_path: Path) -> None:
    pid_path = tmp_path / "sync.pid"
    db_path = tmp_path / "mem.sqlite"
    config_path = tmp_path / "config.json"
    port = 0
    config_path.write_text(
        json.dumps(
            {
                "sync_enabled": True,
                "sync_host": "127.0.0.1",
                "sync_port": port,
                "sync_interval_s": 30,
            }
        )
        + "\n",
        encoding="utf-8",
    )

    env = os.environ.copy()
    env["CODEMEM_CONFIG"] = str(config_path)
    env["CODEMEM_DB"] = str(db_path)

    daemon_cmd = [
        sys.executable,
        "-m",
        "codemem.cli",
        "sync",
        "daemon",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--interval-s",
        "30",
        "--db-path",
        str(db_path),
    ]
    launcher = (
        "import subprocess, sys; "
        "p = subprocess.Popen(sys.argv[1:], start_new_session=True, "
        "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
        "print(p.pid)"
    )
    daemon_pid = int(
        subprocess.check_output(
            [sys.executable, "-c", launcher, *daemon_cmd],
            env=env,
            text=True,
        ).strip()
    )
    assert _wait_until(lambda: sync_runtime._pid_running(daemon_pid))
    pid_path.write_text(f"{daemon_pid}\n", encoding="utf-8")

    previous_pid_env = os.environ.get("CODEMEM_SYNC_PID")
    os.environ["CODEMEM_SYNC_PID"] = str(pid_path)
    try:
        assert sync_runtime._pid_running(daemon_pid)
        result = sync_runtime.stop_pidfile_with_reason()
        assert result.stopped is True
        assert result.reason == "stopped"
        assert result.pid == daemon_pid
        assert pid_path.exists() is False
    finally:
        if sync_runtime._pid_running(daemon_pid):
            os.kill(daemon_pid, signal.SIGTERM)
            _wait_until(lambda: not sync_runtime._pid_running(daemon_pid), timeout_s=2.0)
        if previous_pid_env is None:
            os.environ.pop("CODEMEM_SYNC_PID", None)
        else:
            os.environ["CODEMEM_SYNC_PID"] = previous_pid_env


@pytest.mark.skipif(sys.platform.startswith("win"), reason="requires ps command semantics")
def test_stop_pidfile_integration_refuses_unrelated_process(tmp_path: Path) -> None:
    pid_path = tmp_path / "sync.pid"

    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", "0"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    pid_path.write_text(f"{proc.pid}\n", encoding="utf-8")

    previous_pid_env = os.environ.get("CODEMEM_SYNC_PID")
    os.environ["CODEMEM_SYNC_PID"] = str(pid_path)
    try:
        result = sync_runtime.stop_pidfile_with_reason()
        assert result.stopped is False
        assert result.reason == "pid_unverified"
        assert result.pid == proc.pid
        assert proc.poll() is None
        assert pid_path.exists() is True
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=2)
        if previous_pid_env is None:
            os.environ.pop("CODEMEM_SYNC_PID", None)
        else:
            os.environ["CODEMEM_SYNC_PID"] = previous_pid_env
