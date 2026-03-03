from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
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
        consumed.add("source")
    elif hook_event == "UserPromptSubmit":
        text = str(payload.get("prompt") or "").strip()
        if not text:
            return None
        event_type = "prompt"
        event_payload = {"text": text}
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
        consumed.update({"tool_name", "tool_input", "error", "is_interrupt"})
    elif hook_event == "Stop":
        assistant_text = str(payload.get("last_assistant_message") or "").strip()
        if not assistant_text:
            return None
        event_type = "assistant"
        event_payload = {"text": assistant_text}
        consumed.update({"stop_hook_active", "last_assistant_message"})
    else:
        event_type = "session_end"
        event_payload = {"reason": payload.get("reason")}
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
            json.dumps(event_payload, sort_keys=True, default=str).encode("utf-8")
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
