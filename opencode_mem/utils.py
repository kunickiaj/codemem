from __future__ import annotations

import re
import subprocess
from pathlib import Path

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


def run_command(cmd: list[str], cwd: str | None = None) -> str:
    try:
        out = subprocess.check_output(cmd, cwd=cwd, stderr=subprocess.STDOUT, text=True)
        return out.strip()
    except subprocess.CalledProcessError as exc:
        return exc.output.strip()
    except FileNotFoundError:
        return ""


def detect_git_info(cwd: str) -> dict[str, str | None]:
    repo_root = run_command(["git", "rev-parse", "--show-toplevel"], cwd=cwd) or None
    branch = run_command(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=cwd) or None
    remote = run_command(["git", "config", "--get", "remote.origin.url"], cwd=cwd) or None
    status = run_command(["git", "status", "--short"], cwd=cwd)
    diff_summary = run_command(["git", "diff", "--stat"], cwd=cwd)
    # Filter out lockfile noise from diff summary
    if diff_summary:
        diff_summary = filter_lockfiles_from_diff(diff_summary)
    recent_files = run_command(["git", "diff", "--name-only", "HEAD"], cwd=cwd)
    # Filter out lockfiles from recent files
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


LOCKFILE_PATTERNS = [
    "uv.lock",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "Gemfile.lock",
    "poetry.lock",
    "Pipfile.lock",
]


def filter_lockfiles_from_diff(diff_output: str) -> str:
    """Filter lockfile changes from git diff --stat output"""
    lines = []
    for line in diff_output.splitlines():
        # Skip lines that mention lockfiles
        if not any(pattern in line for pattern in LOCKFILE_PATTERNS):
            lines.append(line)
    return "\n".join(lines)


def filter_lockfiles_from_list(files_output: str) -> str:
    """Filter lockfiles from file list"""
    lines = []
    for line in files_output.splitlines():
        # Skip lockfiles
        if not any(pattern in line for pattern in LOCKFILE_PATTERNS):
            lines.append(line)
    return "\n".join(lines)


def resolve_project(cwd: str, override: str | None = None) -> str | None:
    if override is not None:
        override = override.strip()
        return override or None

    repo_root = detect_git_info(cwd).get("repo_root")
    # Check if repo_root is a valid path (not a git error message)
    if repo_root and not repo_root.startswith("fatal:") and Path(repo_root).is_dir():
        main_repo = _resolve_worktree_parent(cwd)
        if main_repo:
            repo_root = main_repo
        return Path(repo_root).name

    return Path(cwd).resolve().name


def _resolve_worktree_parent(cwd: str) -> str | None:
    """If cwd is a git worktree, return the main repo root. Otherwise return None."""
    try:
        # Get the common git dir (shared across worktrees)
        common_dir = subprocess.check_output(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=cwd,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        # Get the current git dir
        git_dir = subprocess.check_output(
            ["git", "rev-parse", "--git-dir"],
            cwd=cwd,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        # If they differ, we're in a worktree
        common_path = Path(common_dir).resolve()
        git_path = Path(git_dir).resolve()
        if common_path != git_path:
            # common_dir is typically <main-repo>/.git
            # So the main repo root is its parent
            if common_path.name == ".git":
                return str(common_path.parent)
            # Handle bare repos or unusual layouts
            return str(common_path)
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        pass
    return None


def find_agent_notes(cwd: str) -> dict[str, str]:
    notes: dict[str, str] = {}
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
