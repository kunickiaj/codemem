from __future__ import annotations

import subprocess
from collections.abc import Sequence

LOCKFILE_PATTERNS: list[str] = [
    "uv.lock",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "Gemfile.lock",
    "poetry.lock",
    "Pipfile.lock",
]


def run_command(cmd: Sequence[str], cwd: str | None = None) -> str:
    try:
        out = subprocess.check_output(cmd, cwd=cwd, stderr=subprocess.STDOUT, text=True)
        return out.strip()
    except subprocess.CalledProcessError as exc:
        return exc.output.strip()
    except FileNotFoundError:
        return ""


def filter_lockfiles_from_diff(diff_output: str) -> str:
    lines = []
    for line in diff_output.splitlines():
        if not any(pattern in line for pattern in LOCKFILE_PATTERNS):
            lines.append(line)
    return "\n".join(lines)


def filter_lockfiles_from_list(files_output: str) -> str:
    lines = []
    for line in files_output.splitlines():
        if not any(pattern in line for pattern in LOCKFILE_PATTERNS):
            lines.append(line)
    return "\n".join(lines)


def detect_git_info(cwd: str) -> dict[str, str | None]:
    repo_root = run_command(["git", "rev-parse", "--show-toplevel"], cwd=cwd) or None
    branch = run_command(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=cwd) or None
    remote = run_command(["git", "config", "--get", "remote.origin.url"], cwd=cwd) or None
    status = run_command(["git", "status", "--short"], cwd=cwd)
    diff_summary = run_command(["git", "diff", "--stat"], cwd=cwd)
    if diff_summary:
        diff_summary = filter_lockfiles_from_diff(diff_summary)
    recent_files = run_command(["git", "diff", "--name-only", "HEAD"], cwd=cwd)
    if recent_files:
        recent_files = filter_lockfiles_from_list(recent_files)
    return {
        "repo_root": repo_root,
        "branch": branch,
        "remote": remote,
        "status": status,
        "diff": diff_summary,
        "recent_files": recent_files,
    }


def resolve_worktree_parent(cwd: str) -> str | None:
    """If cwd is a git worktree, return the main repo root. Otherwise return None."""

    try:
        common_dir = subprocess.check_output(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=cwd,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        git_dir = subprocess.check_output(
            ["git", "rev-parse", "--git-dir"],
            cwd=cwd,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        if common_dir == git_dir:
            return None
        from pathlib import Path

        common_path = Path(common_dir).resolve()
        if common_path.name == ".git":
            return str(common_path.parent)
        return str(common_path)
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None
