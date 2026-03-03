from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

import typer
from rich import print

from codemem.claude_hooks import MAPPABLE_CLAUDE_HOOK_EVENTS, map_claude_hook_payload
from codemem.db import DEFAULT_DB_PATH
from codemem.raw_event_flush import flush_raw_events
from codemem.store import MemoryStore

ALLOWED_HOOK_EVENTS = frozenset(
    hook_event for hook_event in MAPPABLE_CLAUDE_HOOK_EVENTS if hook_event != "PreToolUse"
)


def _env_truthy(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _adapter_stream_id(*, source: str, session_id: str, cwd: str | None) -> str:
    _ = cwd
    return f"{source}:{session_id}"


def _hook_stream_id(hook_payload: dict[str, Any]) -> str | None:
    session_id = str(hook_payload.get("session_id") or "").strip()
    if not session_id:
        return None
    return _adapter_stream_id(
        source="claude",
        session_id=session_id,
        cwd=hook_payload.get("cwd") if isinstance(hook_payload.get("cwd"), str) else None,
    )


def _iso_to_wall_ms(ts: str | None) -> int:
    if isinstance(ts, str) and ts.strip():
        try:
            parsed = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=dt.UTC)
            return int(parsed.timestamp() * 1000)
        except ValueError:
            pass
    return int(dt.datetime.now(dt.UTC).timestamp() * 1000)


def _queue_adapter_event(hook_payload: dict[str, Any], *, store: Any) -> tuple[str, bool] | None:
    adapter_event = map_claude_hook_payload(hook_payload)
    if adapter_event is None:
        return None
    source = str(adapter_event.get("source") or "claude")
    session_id = str(adapter_event.get("session_id") or "").strip()
    if not session_id:
        return None
    stream_id = _adapter_stream_id(
        source=source,
        session_id=session_id,
        cwd=hook_payload.get("cwd") if isinstance(hook_payload.get("cwd"), str) else None,
    )
    ts = str(adapter_event.get("ts") or "")
    payload = {
        "type": "claude.hook",
        "timestamp": ts,
        "_adapter": adapter_event,
    }
    inserted = store.record_raw_event(
        opencode_session_id=stream_id,
        event_id=str(adapter_event.get("event_id") or ""),
        event_type="claude.hook",
        payload=payload,
        ts_wall_ms=_iso_to_wall_ms(ts),
    )
    store.update_raw_event_session_meta(
        opencode_session_id=stream_id,
        cwd=hook_payload.get("cwd") if isinstance(hook_payload.get("cwd"), str) else None,
        project=hook_payload.get("project")
        if isinstance(hook_payload.get("project"), str)
        else None,
        started_at=ts if str(hook_payload.get("hook_event_name") or "") == "SessionStart" else None,
        last_seen_ts_wall_ms=_iso_to_wall_ms(ts),
    )
    return stream_id, inserted


def _should_flush(hook_event_name: str) -> bool:
    if hook_event_name not in {"Stop", "SessionEnd"}:
        return False
    return _env_truthy("CODEMEM_CLAUDE_HOOK_FLUSH", True)


def _strip_json_comments(text: str) -> str:
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


def _load_json_or_empty(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    raw = path.read_text()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = json.loads(_strip_json_comments(raw))
    if isinstance(parsed, dict):
        return parsed
    raise ValueError("settings file root must be a JSON object")


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        backup = path.with_suffix(path.suffix + ".bak")
        backup.write_text(path.read_text())
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def _resolve_claude_plugin_source() -> Path:
    cli_dir = Path(__file__).resolve().parents[1]
    packaged = cli_dir / ".claude" / "plugin" / "codemem"
    if packaged.exists():
        return packaged

    repo_copy = cli_dir.parent / ".claude" / "plugin" / "codemem"
    if repo_copy.exists():
        return repo_copy

    raise FileNotFoundError("Claude plugin template not found in package or repository")


def _merge_enabled_plugins(settings: dict[str, Any], plugin_ref: str) -> dict[str, Any]:
    merged = dict(settings)
    raw_enabled = merged.get("enabledPlugins")
    enabled: list[str] = []
    if isinstance(raw_enabled, list):
        enabled = [str(item) for item in raw_enabled if isinstance(item, str)]
    if plugin_ref not in enabled:
        enabled.append(plugin_ref)
    merged["enabledPlugins"] = enabled
    return merged


def _build_install_report(
    *, plugin_dir: Path, settings_path: Path, plugin_ref: str
) -> dict[str, str]:
    return {
        "plugin_dir": str(plugin_dir),
        "settings_path": str(settings_path),
        "enabled_plugin": plugin_ref,
        "hook_entrypoint": "codemem ingest-claude-hook",
    }


def install_claude_integration_cmd(*, force: bool, cwd: Path | None = None) -> dict[str, str]:
    root = cwd or Path.cwd()
    plugin_source = _resolve_claude_plugin_source()
    plugin_dir = root / ".claude" / "plugins" / "codemem"
    plugin_ref = "./plugins/codemem"
    settings_path = root / ".claude" / "settings.json"

    if plugin_dir.exists() and not force:
        print(f"[yellow]Claude plugin already exists at {plugin_dir}[/yellow]")
        print("[dim]Use --force to overwrite plugin template files[/dim]")
    else:
        shutil.copytree(plugin_source, plugin_dir, dirs_exist_ok=True)
        script_path = plugin_dir / "scripts" / "ingest-hook.sh"
        if script_path.exists():
            script_path.chmod(script_path.stat().st_mode | 0o111)

    try:
        settings = _load_json_or_empty(settings_path)
    except Exception as exc:
        print(f"[red]Error: Failed to parse {settings_path}: {exc}[/red]")
        raise typer.Exit(code=1) from exc

    settings = _merge_enabled_plugins(settings, plugin_ref)
    try:
        _write_json(settings_path, settings)
    except Exception as exc:
        print(f"[red]Error: Failed to write {settings_path}: {exc}[/red]")
        raise typer.Exit(code=1) from exc

    report = _build_install_report(
        plugin_dir=plugin_dir,
        settings_path=settings_path,
        plugin_ref=plugin_ref,
    )
    print(f"[green]✓ Claude integration installed in {root / '.claude'}[/green]")
    print(json.dumps(report, indent=2))
    return report


def ingest_claude_hook_cmd() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        return
    try:
        hook_payload = json.loads(raw)
    except json.JSONDecodeError:
        return
    if not isinstance(hook_payload, dict):
        return
    hook_event_name = str(hook_payload.get("hook_event_name") or "").strip()
    if hook_event_name not in ALLOWED_HOOK_EVENTS:
        return
    should_flush = _should_flush(hook_event_name)
    db_path = os.environ.get("CODEMEM_DB") or DEFAULT_DB_PATH
    store = MemoryStore(db_path)
    try:
        queued = _queue_adapter_event(hook_payload, store=store)
        if queued is None:
            if should_flush:
                stream_id = _hook_stream_id(hook_payload)
                if not stream_id:
                    return
                flush_raw_events(
                    store,
                    opencode_session_id=stream_id,
                    cwd=hook_payload.get("cwd")
                    if isinstance(hook_payload.get("cwd"), str)
                    else None,
                    project=hook_payload.get("project")
                    if isinstance(hook_payload.get("project"), str)
                    else None,
                    started_at=None,
                    max_events=None,
                )
            return
        stream_id, _ = queued
        if not should_flush:
            return
        flush_raw_events(
            store,
            opencode_session_id=stream_id,
            cwd=hook_payload.get("cwd") if isinstance(hook_payload.get("cwd"), str) else None,
            project=hook_payload.get("project")
            if isinstance(hook_payload.get("project"), str)
            else None,
            started_at=None,
            max_events=None,
        )
    finally:
        store.close()
