from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import typer
from rich import print

from opencode_mem.config import read_config_file, write_config_file
from opencode_mem.db import DEFAULT_DB_PATH
from opencode_mem.store import MemoryStore
from opencode_mem.utils import resolve_project


def store_from_path(db_path: str | None) -> MemoryStore:
    return MemoryStore(db_path or DEFAULT_DB_PATH)


def read_config_or_exit() -> dict[str, Any]:
    try:
        return read_config_file()
    except ValueError as exc:
        print(f"[red]Invalid config file: {exc}[/red]")
        raise typer.Exit(code=1) from exc


def write_config_or_exit(data: dict[str, Any]) -> None:
    try:
        write_config_file(data)
    except OSError as exc:
        print(f"[red]Failed to write config: {exc}[/red]")
        raise typer.Exit(code=1) from exc


def resolve_project_for_cli(cwd: str, project: str | None, *, all_projects: bool) -> str | None:
    if all_projects:
        return None
    if project:
        return project
    env_project = os.environ.get("OPENCODE_MEM_PROJECT")
    if env_project:
        return env_project
    return resolve_project(cwd)


def format_bytes(size: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{int(size)} B"


def format_tokens(count: int) -> str:
    return f"{count:,}"


def strip_json_comments(text: str) -> str:
    lines: list[str] = []
    for line in text.splitlines():
        result: list[str] = []
        in_string = False
        escape_next = False
        i = 0
        while i < len(line):
            char = line[i]
            if escape_next:
                result.append(char)
                escape_next = False
                i += 1
                continue
            if char == "\\" and in_string:
                result.append(char)
                escape_next = True
                i += 1
                continue
            if char == '"':
                in_string = not in_string
                result.append(char)
                i += 1
                continue
            if not in_string and char == "/" and i + 1 < len(line) and line[i + 1] == "/":
                break
            result.append(char)
            i += 1
        lines.append("".join(result))
    return "\n".join(lines)


def load_json_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    raw = path.read_text()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return json.loads(strip_json_comments(raw))


def write_json_file(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
