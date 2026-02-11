from __future__ import annotations

import datetime as dt
from typing import Any


def compute_cursor(created_at: str, op_id: str) -> str:
    return f"{created_at}|{op_id}"


def parse_cursor(cursor: str | None) -> tuple[str, str] | None:
    if not cursor:
        return None
    if "|" not in cursor:
        return None
    created_at, op_id = cursor.split("|", 1)
    if not created_at or not op_id:
        return None
    return created_at, op_id


def parse_iso8601(value: str) -> dt.datetime | None:
    raw = value.strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed.astimezone(dt.UTC)


def project_basename(value: str) -> str:
    normalized = value.replace("\\", "/").rstrip("/")
    if not normalized:
        return ""
    return normalized.split("/")[-1]


def project_column_clause(column_expr: str, project: str) -> tuple[str, list[Any]]:
    project = project.strip()
    if not project:
        return "", []
    value = project
    if "/" in project or "\\" in project:
        base = project_basename(project)
        if not base:
            return "", []
        value = base
    return (
        f"({column_expr} = ? OR {column_expr} LIKE ? OR {column_expr} LIKE ?)",
        [value, f"%/{value}", f"%\\{value}"],
    )


def project_clause(project: str) -> tuple[str, list[Any]]:
    return project_column_clause("sessions.project", project)
