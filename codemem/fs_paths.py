from __future__ import annotations

from pathlib import Path


def ensure_path(path: str | Path) -> Path:
    resolved = Path(path).expanduser()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    return resolved


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
