from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Dict, Optional

REDACTION_PATTERNS = [
    re.compile(r"api[_-]?key\s*[:=]\s*['\"]?[A-Za-z0-9_-]{20,}", re.IGNORECASE),
    re.compile(r"sk-[A-Za-z0-9]{10,}", re.IGNORECASE),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}", re.IGNORECASE),
]

ANSI_ESCAPE_RE = re.compile(
    r"""
    \x1B
    (?:
        [@-Z\\-_]
      | \[ [0-?]* [ -/]* [@-~]
      | \] [^\x1B]* (?:\x1B\\\\|\x07)
      | P  [0-?]* [ -/]* [\x20-\x7E]* (?:\x1B\\\\|\x07)
    )
    """,
    re.VERBOSE,
)


def redact(text: str) -> str:
    redacted = text
    for pattern in REDACTION_PATTERNS:
        redacted = pattern.sub("[REDACTED]", redacted)
    return redacted


def strip_ansi(text: str) -> str:
    return ANSI_ESCAPE_RE.sub("", text)


def run_command(cmd: list[str], cwd: Optional[str] = None) -> str:
    try:
        out = subprocess.check_output(cmd, cwd=cwd, stderr=subprocess.STDOUT, text=True)
        return out.strip()
    except subprocess.CalledProcessError as exc:
        return exc.output.strip()
    except FileNotFoundError:
        return ""


def detect_git_info(cwd: str) -> Dict[str, Optional[str]]:
    repo_root = run_command(["git", "rev-parse", "--show-toplevel"], cwd=cwd) or None
    branch = run_command(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=cwd) or None
    remote = (
        run_command(["git", "config", "--get", "remote.origin.url"], cwd=cwd) or None
    )
    status = run_command(["git", "status", "--short"], cwd=cwd)
    diff_summary = run_command(["git", "diff", "--stat"], cwd=cwd)
    recent_files = run_command(["git", "diff", "--name-only", "HEAD"], cwd=cwd)
    return {
        "repo_root": repo_root,
        "branch": branch,
        "remote": remote,
        "status": status,
        "diff": diff_summary,
        "recent_files": recent_files,
    }


def resolve_project(cwd: str, override: Optional[str] = None) -> Optional[str]:
    if override:
        return override
    repo_root = detect_git_info(cwd).get("repo_root")
    if repo_root:
        return repo_root
    return None


def find_agent_notes(cwd: str) -> Dict[str, str]:
    notes: Dict[str, str] = {}
    try:
        for path in Path(cwd).rglob("AGENTS.md"):
            try:
                notes[str(path)] = path.read_text()
            except OSError:
                continue
    except Exception:
        return notes
    return notes


def ensure_path(path: str | Path) -> Path:
    resolved = Path(path).expanduser()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    return resolved
