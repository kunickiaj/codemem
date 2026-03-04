from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path, PureWindowsPath
from typing import Any

MAPPABLE_CLAUDE_HOOK_EVENTS = {
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "SessionEnd",
}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _normalize_iso_ts(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.isoformat().replace("+00:00", "Z")


def _stable_event_id(*parts: str) -> str:
    joined = "|".join(parts)
    digest = hashlib.sha256(joined.encode("utf-8")).hexdigest()[:24]
    return f"cld_evt_{digest}"


def _extract_meta(payload: dict[str, Any], consumed_keys: set[str]) -> dict[str, Any]:
    unknown = {k: v for k, v in payload.items() if k not in consumed_keys}
    return unknown


def _coerce_session_id(payload: dict[str, Any]) -> str | None:
    raw = payload.get("session_id")
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    return value or None


def _normalize_project_label(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    if "/" in cleaned or "\\" in cleaned:
        looks_windows = "\\" in cleaned or (
            len(cleaned) >= 2 and cleaned[1] == ":" and cleaned[0].isalpha()
        )
        if looks_windows:
            return PureWindowsPath(cleaned).name or None
        return Path(cleaned).name or None
    return cleaned


def _infer_project_from_cwd(cwd: str | None) -> str | None:
    if not isinstance(cwd, str):
        return None
    text = cwd.strip()
    if not text:
        return None
    try:
        path = Path(text).expanduser()
    except Exception:
        return None
    try:
        if not path.is_dir():
            return None
    except OSError:
        return None

    current = path
    while True:
        git_marker = current / ".git"
        try:
            if git_marker.exists():
                return _normalize_project_label(current.name)
        except OSError:
            break
        parent = current.parent
        if parent == current:
            break
        current = parent

    return _normalize_project_label(path.name)


def _resolve_hook_project(*, cwd: str | None, payload_project: Any) -> str | None:
    env_project = _normalize_project_label(os.environ.get("CODEMEM_PROJECT"))
    if env_project:
        return env_project

    payload_label = _normalize_project_label(payload_project)
    cwd_label = _infer_project_from_cwd(cwd)

    if cwd_label:
        if payload_label and payload_label == cwd_label:
            return payload_label
        return cwd_label

    if payload_label:
        return payload_label

    return None


def _iso_to_wall_ms(value: str) -> int:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return int(parsed.timestamp() * 1000)


def _normalize_usage(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None

    def _to_int(key: str) -> int:
        try:
            return int(value.get(key) or 0)
        except (TypeError, ValueError):
            return 0

    normalized = {
        "input_tokens": _to_int("input_tokens"),
        "output_tokens": _to_int("output_tokens"),
        "cache_creation_input_tokens": _to_int("cache_creation_input_tokens"),
        "cache_read_input_tokens": _to_int("cache_read_input_tokens"),
    }
    if sum(normalized.values()) <= 0:
        return None
    return normalized


def _text_from_content(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            text = _text_from_content(item)
            if text:
                parts.append(text)
        return "\n".join(parts).strip()
    if isinstance(value, dict):
        text = value.get("text")
        if isinstance(text, str):
            return text.strip()
        return _text_from_content(value.get("content"))
    return ""


def _extract_from_transcript(transcript_path: Any) -> tuple[str | None, dict[str, int] | None]:
    if not isinstance(transcript_path, str):
        return None, None
    path = Path(transcript_path).expanduser()
    if not path.exists() or not path.is_file():
        return None, None

    assistant_text: str | None = None
    assistant_usage: dict[str, int] | None = None
    try:
        with path.open("r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(record, dict):
                    continue

                candidates: list[dict[str, Any]] = [record]
                message = record.get("message")
                if isinstance(message, dict):
                    candidates.append(message)

                role = ""
                content_value: Any = None
                usage_value: Any = None
                for candidate in candidates:
                    if not role:
                        role_raw = candidate.get("role")
                        if isinstance(role_raw, str):
                            role = role_raw.strip().lower()
                        elif candidate.get("type") == "assistant":
                            role = "assistant"
                    if content_value is None:
                        for field in ("content", "text"):
                            if field in candidate:
                                content_value = candidate.get(field)
                                break
                    if usage_value is None:
                        for field in ("usage", "token_usage", "tokenUsage"):
                            if field in candidate:
                                usage_value = candidate.get(field)
                                break

                if role != "assistant":
                    continue
                text = _text_from_content(content_value)
                if not text:
                    continue
                assistant_text = text
                assistant_usage = _normalize_usage(usage_value)
    except OSError:
        return None, None

    return assistant_text, assistant_usage


def map_claude_hook_payload(payload: dict[str, Any]) -> dict[str, Any] | None:
    hook_event = str(payload.get("hook_event_name") or "").strip()
    if hook_event not in MAPPABLE_CLAUDE_HOOK_EVENTS:
        return None

    session_id = _coerce_session_id(payload)
    if not session_id:
        return None

    raw_ts = payload.get("ts") or payload.get("timestamp")
    normalized_raw_ts = _normalize_iso_ts(raw_ts)
    ts = normalized_raw_ts or _now_iso()
    tool_use_id = str(payload.get("tool_use_id") or "").strip()
    event_type: str
    event_payload: dict[str, Any]
    event_id_payload: dict[str, Any]
    consumed: set[str] = {
        "hook_event_name",
        "session_id",
        "cwd",
        "ts",
        "timestamp",
        "transcript_path",
        "permission_mode",
        "tool_use_id",
    }

    if hook_event == "SessionStart":
        event_type = "session_start"
        event_payload = {"source": payload.get("source")}
        event_id_payload = dict(event_payload)
        consumed.add("source")
    elif hook_event == "UserPromptSubmit":
        text = str(payload.get("prompt") or "").strip()
        if not text:
            return None
        event_type = "prompt"
        event_payload = {"text": text}
        event_id_payload = dict(event_payload)
        consumed.add("prompt")
    elif hook_event == "PreToolUse":
        tool_name = str(payload.get("tool_name") or "").strip()
        if not tool_name:
            return None
        tool_input = payload.get("tool_input")
        if not isinstance(tool_input, dict):
            tool_input = {}
        event_type = "tool_call"
        event_payload = {
            "tool_name": tool_name,
            "tool_input": tool_input,
        }
        event_id_payload = dict(event_payload)
        consumed.update({"tool_name", "tool_input"})
    elif hook_event == "PostToolUse":
        tool_name = str(payload.get("tool_name") or "").strip()
        if not tool_name:
            return None
        tool_input = payload.get("tool_input")
        if not isinstance(tool_input, dict):
            tool_input = {}
        tool_response = payload.get("tool_response")
        event_type = "tool_result"
        event_payload = {
            "tool_name": tool_name,
            "status": "ok",
            "tool_input": tool_input,
            "tool_output": tool_response,
            "tool_error": None,
        }
        event_id_payload = dict(event_payload)
        consumed.update({"tool_name", "tool_input", "tool_response"})
    elif hook_event == "PostToolUseFailure":
        tool_name = str(payload.get("tool_name") or "").strip()
        if not tool_name:
            return None
        tool_input = payload.get("tool_input")
        if not isinstance(tool_input, dict):
            tool_input = {}
        error = payload.get("error")
        event_type = "tool_result"
        event_payload = {
            "tool_name": tool_name,
            "status": "error",
            "tool_input": tool_input,
            "tool_output": None,
            "error": error,
        }
        event_id_payload = dict(event_payload)
        consumed.update({"tool_name", "tool_input", "error", "is_interrupt"})
    elif hook_event == "Stop":
        raw_assistant_text = str(payload.get("last_assistant_message") or "").strip()
        raw_usage = _normalize_usage(payload.get("usage"))
        assistant_text = raw_assistant_text
        usage = raw_usage
        if not assistant_text or usage is None:
            transcript_text, transcript_usage = _extract_from_transcript(
                payload.get("transcript_path")
            )
            if not assistant_text and transcript_text:
                assistant_text = transcript_text
            if usage is None and transcript_usage is not None:
                usage = transcript_usage
        if not assistant_text:
            return None
        event_type = "assistant"
        event_payload = {"text": assistant_text}
        if usage is not None:
            event_payload["usage"] = usage
        event_id_payload = {"text": raw_assistant_text}
        if raw_usage is not None:
            event_id_payload["usage"] = raw_usage
        if not raw_assistant_text and raw_usage is None:
            transcript_path = payload.get("transcript_path")
            if isinstance(transcript_path, str) and transcript_path.strip():
                event_id_payload["transcript_path"] = transcript_path.strip()
        consumed.update({"stop_hook_active", "last_assistant_message", "usage"})
    else:
        event_type = "session_end"
        event_payload = {"reason": payload.get("reason")}
        event_id_payload = dict(event_payload)
        consumed.add("reason")

    meta: dict[str, Any] = {
        "hook_event_name": hook_event,
        "ordering_confidence": "low",
    }
    if tool_use_id:
        meta["tool_use_id"] = tool_use_id
    if normalized_raw_ts is None:
        meta["ts_normalized"] = "generated"

    unknown = _extract_meta(payload, consumed)
    if unknown:
        meta["hook_fields"] = unknown

    event_id_ts_seed = normalized_raw_ts or ts

    event_id = _stable_event_id(
        session_id,
        hook_event,
        event_id_ts_seed,
        tool_use_id,
        hashlib.sha256(
            json.dumps(event_id_payload, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest(),
    )

    return {
        "schema_version": "1.0",
        "source": "claude",
        "session_id": session_id,
        "event_id": event_id,
        "event_type": event_type,
        "ts": ts,
        "ordering_confidence": "low",
        "cwd": payload.get("cwd"),
        "payload": event_payload,
        "meta": meta,
    }


def build_ingest_payload_from_hook(hook_payload: dict[str, Any]) -> dict[str, Any] | None:
    adapter_event = map_claude_hook_payload(hook_payload)
    if adapter_event is None:
        return None

    session_id = str(adapter_event["session_id"])
    return {
        "cwd": hook_payload.get("cwd"),
        "events": [
            {
                "type": "claude.hook",
                "timestamp": adapter_event["ts"],
                "_adapter": adapter_event,
            }
        ],
        "session_context": {
            "source": "claude",
            "stream_id": session_id,
            "opencode_session_id": session_id,
        },
    }


def build_raw_event_envelope_from_hook(hook_payload: dict[str, Any]) -> dict[str, Any] | None:
    adapter_event = map_claude_hook_payload(hook_payload)
    if adapter_event is None:
        return None

    session_id = str(adapter_event.get("session_id") or "").strip()
    if not session_id:
        return None

    ts = str(adapter_event.get("ts") or "").strip()
    if not ts:
        return None

    source = str(adapter_event.get("source") or "claude")
    hook_event_name = str(hook_payload.get("hook_event_name") or "")
    cwd = hook_payload.get("cwd") if isinstance(hook_payload.get("cwd"), str) else None
    project = _resolve_hook_project(cwd=cwd, payload_project=hook_payload.get("project"))

    return {
        "opencode_session_id": session_id,
        "source": source,
        "event_id": str(adapter_event.get("event_id") or ""),
        "event_type": "claude.hook",
        "payload": {
            "type": "claude.hook",
            "timestamp": ts,
            "_adapter": adapter_event,
        },
        "ts_wall_ms": _iso_to_wall_ms(ts),
        "cwd": cwd,
        "project": project,
        "started_at": ts if hook_event_name == "SessionStart" else None,
    }
