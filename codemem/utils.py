from __future__ import annotations

from pathlib import Path

from .fs_paths import ensure_path, find_agent_notes  # noqa: F401
from .git_info import (  # noqa: F401
    LOCKFILE_PATTERNS,  # noqa: F401
    detect_git_info,
    filter_lockfiles_from_diff,
    filter_lockfiles_from_list,
    resolve_worktree_parent,
    run_command,
)
from .redaction import ANSI_ESCAPE_RE, REDACTION_PATTERNS, redact, strip_ansi  # noqa: F401


def resolve_project(cwd: str, override: str | None = None) -> str | None:
    if override is not None:
        override = override.strip()
        return override or None

    repo_root = detect_git_info(cwd).get("repo_root")
    # Check if repo_root is a valid path (not a git error message)
    if repo_root and not repo_root.startswith("fatal:") and Path(repo_root).is_dir():
        main_repo = resolve_worktree_parent(cwd)
        if main_repo:
            repo_root = main_repo
        return Path(repo_root).name

    return Path(cwd).resolve().name
