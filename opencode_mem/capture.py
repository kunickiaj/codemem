from __future__ import annotations

import datetime as dt
import errno
import json
import os
import pty
import select
import subprocess
import sys
import termios
import tty
import warnings
from pathlib import Path
from typing import Any

from .utils import detect_git_info, find_agent_notes, redact, strip_ansi

DEFAULT_MAX_TRANSCRIPT_BYTES = 200_000
TRUNCATION_NOTICE = "\n[opencode-mem] transcript truncated\n"


def _max_transcript_bytes() -> int:
    raw = os.environ.get("OPENCODE_MEM_MAX_TRANSCRIPT_BYTES", "")
    if raw:
        try:
            value = int(raw)
        except ValueError:
            warnings.warn(
                "OPENCODE_MEM_MAX_TRANSCRIPT_BYTES must be an integer; using default.",
                RuntimeWarning,
                stacklevel=2,
            )
            value = DEFAULT_MAX_TRANSCRIPT_BYTES
    else:
        value = DEFAULT_MAX_TRANSCRIPT_BYTES
    if value < 0:
        warnings.warn(
            "OPENCODE_MEM_MAX_TRANSCRIPT_BYTES < 0 disables transcript capture.",
            RuntimeWarning,
            stacklevel=2,
        )
        value = 0
    return value


class CommandResult:
    def __init__(self, returncode: int, transcript: str):
        self.returncode = returncode
        self.transcript = transcript


def capture_pre_context(cwd: str) -> dict[str, str]:
    git_info = detect_git_info(cwd)
    project = git_info.get("repo_root")
    agents = find_agent_notes(cwd)
    return {
        "cwd": cwd,
        "project": project or "",
        "git_branch": git_info.get("branch") or "",
        "git_remote": git_info.get("remote") or "",
        "git_status": git_info.get("status") or "",
        "git_diff": git_info.get("diff") or "",
        "recent_files": git_info.get("recent_files") or "",
        "agents": json.dumps(agents, ensure_ascii=False) if agents else "",
    }


def capture_post_context(cwd: str) -> dict[str, str]:
    git_info = detect_git_info(cwd)
    return {
        "git_status": git_info.get("status") or "",
        "git_diff": git_info.get("diff") or "",
        "recent_files": git_info.get("recent_files") or "",
    }


def run_command_with_capture(cmd: list[str], cwd: str | None = None) -> CommandResult:
    try:
        if sys.platform != "win32":
            master_fd, slave_fd = pty.openpty()
            process = subprocess.Popen(
                cmd,
                cwd=cwd,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
            )
            os.close(slave_fd)
            transcript_parts: list[str] = []
            max_bytes = _max_transcript_bytes()
            captured_bytes = 0
            truncated = False
            stdin_fd = sys.stdin.fileno()
            old_tty_settings = None
            if sys.stdin.isatty():
                old_tty_settings = termios.tcgetattr(stdin_fd)
                tty.setraw(stdin_fd)
            try:
                while True:
                    read_fds = [master_fd]
                    if sys.stdin.isatty():
                        read_fds.append(stdin_fd)
                    ready, _, _ = select.select(read_fds, [], [])
                    if master_fd in ready:
                        try:
                            chunk = os.read(master_fd, 1024)
                        except OSError as exc:
                            if exc.errno == errno.EIO:
                                break
                            raise
                        if not chunk:
                            break
                        if hasattr(sys.stdout, "buffer"):
                            sys.stdout.buffer.write(chunk)
                            sys.stdout.buffer.flush()
                        else:
                            sys.stdout.write(chunk.decode(errors="replace"))
                            sys.stdout.flush()
                        if max_bytes > 0 and captured_bytes < max_bytes:
                            remaining = max_bytes - captured_bytes
                            if len(chunk) > remaining:
                                transcript_parts.append(chunk[:remaining].decode(errors="replace"))
                                captured_bytes = max_bytes
                                truncated = True
                            else:
                                transcript_parts.append(chunk.decode(errors="replace"))
                                captured_bytes += len(chunk)
                        else:
                            if max_bytes <= 0 or captured_bytes >= max_bytes:
                                truncated = True
                    if sys.stdin.isatty() and stdin_fd in ready:
                        data = os.read(stdin_fd, 1024)
                        if data:
                            os.write(master_fd, data)
                process.wait()
            finally:
                if old_tty_settings is not None:
                    termios.tcsetattr(stdin_fd, termios.TCSADRAIN, old_tty_settings)
                os.close(master_fd)
            if truncated:
                transcript_parts.append(TRUNCATION_NOTICE)
            transcript = strip_ansi(redact("".join(transcript_parts)))
            return CommandResult(process.returncode, transcript)
        process = subprocess.Popen(
            cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        )
    except FileNotFoundError:
        message = f"opencode-mem: command not found: {cmd[0]}\n"
        sys.stderr.write(message)
        transcript = strip_ansi(redact(message))
        return CommandResult(returncode=127, transcript=transcript)
    transcript_parts = []
    max_bytes = _max_transcript_bytes()
    captured_bytes = 0
    truncated = False
    assert process.stdout is not None
    for line in process.stdout:
        sys.stdout.write(line)
        if max_bytes > 0 and captured_bytes < max_bytes:
            remaining = max_bytes - captured_bytes
            line_bytes = line.encode("utf-8")
            if len(line_bytes) > remaining:
                transcript_parts.append(line_bytes[:remaining].decode("utf-8", errors="replace"))
                captured_bytes = max_bytes
                truncated = True
            else:
                transcript_parts.append(line)
                captured_bytes += len(line_bytes)
        else:
            if max_bytes <= 0 or captured_bytes >= max_bytes:
                truncated = True
    process.wait()
    if truncated:
        transcript_parts.append(TRUNCATION_NOTICE)
    transcript = strip_ansi(redact("".join(transcript_parts)))
    return CommandResult(process.returncode, transcript)


def build_artifact_bundle(
    pre: dict[str, str],
    post: dict[str, str],
    transcript: str,
    session_path: Path | None = None,
    session_meta: dict[str, Any] | None = None,
) -> list[tuple[str, str, str | None]]:
    now = dt.datetime.now(dt.UTC).isoformat()
    artifacts: list[tuple[str, str, str | None]] = [
        ("pre_context", json.dumps(pre, ensure_ascii=False), None),
        ("post_context", json.dumps(post, ensure_ascii=False), None),
        ("transcript", transcript, None),
    ]
    if session_path:
        artifacts.append(("session_path", str(session_path), str(session_path)))
    if session_meta:
        artifacts.append(("session_meta", json.dumps(session_meta, ensure_ascii=False), None))
    agents_payload = pre.get("agents")
    if agents_payload:
        try:
            agents = json.loads(agents_payload)
        except json.JSONDecodeError:
            agents = {}
        if isinstance(agents, dict):
            for path, body in agents.items():
                artifacts.append(("agent_note", str(body), str(path)))
    artifacts.append(("timestamp", now, None))
    return artifacts
