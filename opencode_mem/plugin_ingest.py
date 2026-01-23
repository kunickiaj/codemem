from __future__ import annotations

import json
import os
import re
import sys
from collections.abc import Iterable
from dataclasses import asdict
from pathlib import Path
from typing import Any

from . import db
from .capture import (
    TRUNCATION_NOTICE,
    build_artifact_bundle,
    capture_post_context,
    capture_pre_context,
)
from .config import load_config
from .observer import ObserverClient
from .observer_prompts import ObserverContext, ToolEvent
from .store import MemoryStore
from .summarizer import is_low_signal_observation
from .xml_parser import ParsedSummary, has_meaningful_observation

CONFIG: object | None = None
OBSERVER: ObserverClient | None = None

STORE_SUMMARY = True
STORE_TYPED = True

LOW_SIGNAL_TOOLS = {
    "tui",
    "shell",
    "cmd",
    "task",
    "slashcommand",
    "skill",
    "todowrite",
    "askuserquestion",
}


def _is_internal_memory_tool(tool: str) -> bool:
    """Return True for opencode-mem memory retrieval tools.

    These tools surface previously stored memory. Treating their outputs as
    new evidence can create feedback loops and noisy, self-referential memories.
    """

    return tool.startswith("opencode_mem_memory_")


LOW_SIGNAL_OUTPUTS = {
    "wrote file successfully.",
    "wrote file successfully",
    "file written successfully.",
    "read file successfully.",
    "read file successfully",
    "<file>",
    "<image>",
}

TRIVIAL_REQUESTS = {
    "yes",
    "y",
    "ok",
    "okay",
    "approved",
    "approve",
    "looks good",
    "lgtm",
    "ship it",
    "sounds good",
    "sure",
    "go ahead",
    "proceed",
}


def _is_low_signal_output(output: str) -> bool:
    if not output:
        return True
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return True
    for line in lines:
        if line.lower() in LOW_SIGNAL_OUTPUTS:
            continue
        if is_low_signal_observation(line):
            continue
        return False
    return True


def _truncate_text(text: str, max_bytes: int) -> str:
    if max_bytes <= 0:
        return ""
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    truncated = encoded[:max_bytes].decode("utf-8", errors="replace")
    return f"{truncated}{TRUNCATION_NOTICE}"


def _get_observer() -> ObserverClient:
    global OBSERVER
    if OBSERVER is None:
        OBSERVER = ObserverClient()
    return OBSERVER


def _get_config() -> Any:
    global CONFIG
    if CONFIG is None:
        CONFIG = load_config()
    return CONFIG


def _normalize_tool_name(event: dict[str, Any]) -> str:
    tool = str(event.get("tool") or event.get("type") or "tool").lower()
    if "." in tool:
        tool = tool.split(".")[-1]
    if ":" in tool:
        tool = tool.split(":")[-1]
    return tool


def _extract_assistant_messages(events: Iterable[dict[str, Any]]) -> list[str]:
    messages: list[str] = []
    for event in events:
        if event.get("type") != "assistant_message":
            continue
        text = str(event.get("assistant_text") or "").strip()
        if text:
            messages.append(text)
    return messages


def _extract_assistant_usage(events: Iterable[dict[str, Any]]) -> list[dict[str, int]]:
    usage_events: list[dict[str, int]] = []
    for event in events:
        if event.get("type") != "assistant_usage":
            continue
        usage = event.get("usage") or {}
        if not isinstance(usage, dict):
            continue
        input_tokens = int(usage.get("input_tokens") or 0)
        output_tokens = int(usage.get("output_tokens") or 0)
        cache_creation = int(usage.get("cache_creation_input_tokens") or 0)
        cache_read = int(usage.get("cache_read_input_tokens") or 0)
        total = input_tokens + output_tokens + cache_creation
        if total <= 0:
            continue
        usage_events.append(
            {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_creation_input_tokens": cache_creation,
                "cache_read_input_tokens": cache_read,
                "total_tokens": total,
            }
        )
    return usage_events


def _build_transcript(events: Iterable[dict[str, Any]]) -> str:
    """Build a transcript from user prompts and assistant messages in chronological order."""
    transcript_parts: list[str] = []
    for event in events:
        event_type = event.get("type")
        if event_type == "user_prompt":
            prompt_text = str(event.get("prompt_text") or "").strip()
            if prompt_text:
                transcript_parts.append(f"User: {prompt_text}")
        elif event_type == "assistant_message":
            assistant_text = str(event.get("assistant_text") or "").strip()
            if assistant_text:
                transcript_parts.append(f"Assistant: {assistant_text}")
    return "\n\n".join(transcript_parts)


def _sanitize_payload(value: Any, max_chars: int) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        return _truncate_text(value, max_chars)
    try:
        serialized = json.dumps(value, ensure_ascii=False)
    except Exception:
        serialized = str(value)
    if max_chars > 0 and len(serialized) > max_chars:
        return _truncate_text(serialized, max_chars)
    return value


def _sanitize_tool_output(tool: str, output: Any, max_chars: int) -> Any:
    if output is None:
        return None
    # Keep outputs for read/write/edit - observer needs to see file contents
    # Only sanitize/truncate, don't blank
    sanitized = _sanitize_payload(output, max_chars)
    text = str(sanitized or "")
    if _is_low_signal_output(text):
        return ""
    return sanitized


def _event_to_tool_event(event: dict[str, Any], max_chars: int) -> ToolEvent | None:
    if event.get("type") != "tool.execute.after":
        return None
    tool = _normalize_tool_name(event)
    if _is_internal_memory_tool(tool):
        return None
    if tool in LOW_SIGNAL_TOOLS:
        return None
    args = event.get("args") or {}
    result = _sanitize_tool_output(tool, event.get("result"), max_chars)
    error = _sanitize_payload(event.get("error"), max_chars)
    return ToolEvent(
        tool_name=tool,
        tool_input=_sanitize_payload(args, max_chars),
        tool_output=result,
        tool_error=error,
        timestamp=event.get("timestamp"),
        cwd=event.get("cwd") or args.get("cwd"),
    )


def _extract_tool_events(events: Iterable[dict[str, Any]], max_chars: int) -> list[ToolEvent]:
    tool_events: list[ToolEvent] = []
    for event in events:
        tool_event = _event_to_tool_event(event, max_chars)
        if tool_event:
            tool_events.append(tool_event)
    return tool_events


def _summary_body(summary: ParsedSummary) -> str:
    sections = [
        ("Request", summary.request),
        ("Completed", summary.completed),
        ("Learned", summary.learned),
        ("Investigated", summary.investigated),
        ("Next steps", summary.next_steps),
        ("Notes", summary.notes),
    ]
    parts = []
    for label, value in sections:
        if value:
            parts.append(f"## {label}\n{value}")
    return "\n\n".join(parts)


def _normalize_request_text(text: str | None) -> str:
    if not text:
        return ""
    cleaned = text.strip().strip("\"'").strip()
    cleaned = " ".join(cleaned.split())
    return cleaned.lower()


def _is_trivial_request(text: str | None) -> bool:
    normalized = _normalize_request_text(text)
    if not normalized:
        return True
    return normalized in TRIVIAL_REQUESTS


def _first_sentence(text: str) -> str:
    cleaned = " ".join(line.strip() for line in text.splitlines() if line.strip())
    cleaned = re.sub(r"^[#*\-\d\.\s]+", "", cleaned)
    match = re.split(r"(?<=[.!?])\s+", cleaned, maxsplit=1)
    return (match[0] if match else cleaned).strip()


def _derive_request(summary: ParsedSummary) -> str:
    candidates = [
        summary.completed,
        summary.learned,
        summary.investigated,
        summary.next_steps,
        summary.notes,
    ]
    for candidate in candidates:
        if candidate:
            return _first_sentence(candidate)
    return ""


def _normalize_path(path: str, repo_root: str | None) -> str:
    if not path:
        return ""
    cleaned = path.strip()
    if not repo_root:
        return cleaned
    root = repo_root.rstrip("/")
    if cleaned == root:
        return "."
    if cleaned.startswith(root + "/"):
        return cleaned[len(root) + 1 :]
    return cleaned


def _normalize_paths(paths: list[str], repo_root: str | None) -> list[str]:
    normalized: list[str] = []
    for value in paths:
        cleaned = _normalize_path(value, repo_root)
        if cleaned:
            normalized.append(cleaned)
    return normalized


def _extract_prompts(events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    prompts: list[dict[str, Any]] = []
    for event in events:
        if event.get("type") != "user_prompt":
            continue
        prompt_text = str(event.get("prompt_text") or "").strip()
        if not prompt_text:
            continue
        prompts.append(
            {
                "prompt_text": prompt_text,
                "prompt_number": event.get("prompt_number"),
                "timestamp": event.get("timestamp"),
            }
        )
    return prompts


def ingest(payload: dict[str, Any]) -> None:
    cwd = payload.get("cwd") or os.getcwd()
    events = payload.get("events") or []
    if not isinstance(events, list) or not events:
        return

    # Extract session context from plugin (for comprehensive memories)
    session_context = payload.get("session_context") or {}
    first_prompt = session_context.get("first_prompt")
    prompt_count = session_context.get("prompt_count", 0)
    tool_count = session_context.get("tool_count", 0)
    duration_ms = session_context.get("duration_ms", 0)
    files_modified = session_context.get("files_modified", [])
    files_read = session_context.get("files_read", [])

    pre = capture_pre_context(cwd)
    post = capture_post_context(cwd)
    diff_summary = post.get("git_diff") or ""
    project = payload.get("project") or pre.get("project")
    repo_root = pre.get("project") or None
    db_path = os.environ.get("OPENCODE_MEM_DB")
    store = MemoryStore(Path(db_path) if db_path else db.DEFAULT_DB_PATH)
    started_at = payload.get("started_at")
    session_id = store.start_session(
        cwd=cwd,
        project=project,
        git_remote=pre.get("git_remote"),
        git_branch=pre.get("git_branch"),
        user=os.environ.get("USER", "unknown"),
        tool_version="plugin",
        metadata={
            "pre": pre,
            "source": "plugin",
            "event_count": len(events),
            "started_at": started_at,
            "session_context": session_context,
        },
    )
    prompts = _extract_prompts(events)
    prompt_number = None
    for prompt in prompts:
        prompt_number = prompt.get("prompt_number") or prompt_number
        store.add_user_prompt(
            session_id,
            project,
            prompt["prompt_text"],
            prompt_number=prompt.get("prompt_number"),
            metadata={"source": "plugin"},
        )
    max_chars = _get_config().summary_max_chars
    tool_events = _extract_tool_events(events, max_chars)
    assistant_messages = _extract_assistant_messages(events)
    assistant_usage_events = _extract_assistant_usage(events)
    last_assistant_message = assistant_messages[-1] if assistant_messages else None
    # Use first_prompt from session_context if available (more complete)
    latest_prompt = first_prompt or (prompts[-1]["prompt_text"] if prompts else None)
    should_process = (
        bool(tool_events) or bool(latest_prompt) or (STORE_SUMMARY and last_assistant_message)
    )
    if (
        latest_prompt
        and _is_trivial_request(latest_prompt)
        and not tool_events
        and not last_assistant_message
    ):
        should_process = False
    if not should_process:
        store.end_session(
            session_id,
            metadata={
                "post": post,
                "source": "plugin",
                "event_count": len(events),
                "session_context": session_context,
            },
        )
        store.close()
        return
    transcript = _build_transcript(events)
    artifacts = build_artifact_bundle(pre, post, transcript)
    for kind, body, path in artifacts:
        store.add_artifact(session_id, kind=kind, path=path, content_text=body)

    # Build session context summary for observer
    session_summary_parts = []
    if prompt_count > 1:
        session_summary_parts.append(f"Session had {prompt_count} prompts")
    if tool_count > 0:
        session_summary_parts.append(f"{tool_count} tool executions")
    if duration_ms > 0:
        duration_min = duration_ms / 60000
        session_summary_parts.append(f"~{duration_min:.1f} minutes of work")
    if files_modified:
        session_summary_parts.append(f"Modified: {', '.join(files_modified[:5])}")
    if files_read:
        session_summary_parts.append(f"Read: {', '.join(files_read[:5])}")
    session_info = "; ".join(session_summary_parts) if session_summary_parts else ""

    # Provide user request first; keep session_info as trailing context.
    observer_prompt = latest_prompt or ""
    if session_info:
        if observer_prompt:
            observer_prompt = f"{observer_prompt}\n\n[Session context: {session_info}]"
        else:
            observer_prompt = f"[Session context: {session_info}]"

    observer_context = ObserverContext(
        project=project,
        user_prompt=observer_prompt,
        prompt_number=prompt_number,
        tool_events=tool_events,
        last_assistant_message=last_assistant_message if STORE_SUMMARY else None,
        include_summary=STORE_SUMMARY,
        diff_summary=diff_summary,
        recent_files=post.get("recent_files") or "",
    )
    response = _get_observer().observe(observer_context)
    parsed = response.parsed
    discovery_parts = []
    if latest_prompt:
        discovery_parts.append(latest_prompt)
    if last_assistant_message:
        discovery_parts.append(last_assistant_message)
    if tool_events:
        discovery_parts.append(json.dumps([asdict(e) for e in tool_events], ensure_ascii=False))
    discovery_text = "\n".join(discovery_parts)
    usage_token_total = sum(event["total_tokens"] for event in assistant_usage_events)
    if usage_token_total > 0:
        discovery_tokens = usage_token_total
    else:
        discovery_tokens = store.estimate_tokens(discovery_text)

    observations_to_store = []
    if STORE_TYPED and has_meaningful_observation(parsed.observations):
        allowed_kinds = {
            "bugfix",
            "feature",
            "refactor",
            "change",
            "discovery",
            "decision",
            "exploration",
        }
        for obs in parsed.observations:
            kind = obs.kind.strip().lower()
            if kind not in allowed_kinds:
                continue
            if not (obs.title or obs.narrative):
                continue
            if is_low_signal_observation(obs.title) or is_low_signal_observation(obs.narrative):
                continue
            obs.files_read = _normalize_paths(obs.files_read, repo_root)
            obs.files_modified = _normalize_paths(obs.files_modified, repo_root)
            observations_to_store.append(obs)

    summary_to_store = None
    request_original = None
    if STORE_SUMMARY and parsed.summary and not parsed.skip_summary_reason:
        summary = parsed.summary
        if any(
            [
                summary.request,
                summary.investigated,
                summary.learned,
                summary.completed,
                summary.next_steps,
                summary.notes,
            ]
        ):
            summary.files_read = _normalize_paths(summary.files_read, repo_root)
            summary.files_modified = _normalize_paths(summary.files_modified, repo_root)
            derived_request = summary.request
            if _is_trivial_request(summary.request):
                derived_request = _derive_request(summary)
            if derived_request and derived_request != summary.request:
                request_original = summary.request
                summary.request = derived_request
            summary_to_store = summary

    total_items = len(observations_to_store) + (1 if summary_to_store else 0)
    per_item_tokens = 0
    if discovery_tokens > 0 and total_items > 0:
        per_item_tokens = max(1, discovery_tokens // total_items)

    for obs in observations_to_store:
        metadata: dict[str, str | int] = {"source": "observer"}
        if per_item_tokens:
            metadata["discovery_tokens"] = per_item_tokens
            metadata["discovery_source"] = "usage" if usage_token_total > 0 else "estimate"
        store.remember_observation(
            session_id,
            kind=obs.kind.strip().lower(),
            title=obs.title or obs.narrative[:80],
            narrative=obs.narrative,
            subtitle=obs.subtitle,
            facts=obs.facts,
            concepts=obs.concepts,
            files_read=obs.files_read,
            files_modified=obs.files_modified,
            prompt_number=prompt_number,
            confidence=0.6,
            metadata=metadata,
        )

    if summary_to_store:
        summary_metadata: dict[str, Any] = {
            "request": summary_to_store.request,
            "investigated": summary_to_store.investigated,
            "learned": summary_to_store.learned,
            "completed": summary_to_store.completed,
            "next_steps": summary_to_store.next_steps,
            "notes": summary_to_store.notes,
            "files_read": summary_to_store.files_read,
            "files_modified": summary_to_store.files_modified,
            "prompt_number": prompt_number,
            "source": "observer",
        }
        if request_original:
            summary_metadata["request_original"] = request_original
        if per_item_tokens:
            summary_metadata["discovery_tokens"] = per_item_tokens
            summary_metadata["discovery_source"] = "usage" if usage_token_total > 0 else "estimate"
        store.add_session_summary(
            session_id,
            project,
            summary_to_store.request,
            summary_to_store.investigated,
            summary_to_store.learned,
            summary_to_store.completed,
            summary_to_store.next_steps,
            summary_to_store.notes,
            files_read=summary_to_store.files_read,
            files_edited=summary_to_store.files_modified,
            prompt_number=prompt_number,
            metadata=summary_metadata,
        )
        body_text = _summary_body(summary_to_store)
        if body_text and not is_low_signal_observation(body_text):
            summary_title = _first_sentence(summary_to_store.request) or "Session summary"
            store.remember(
                session_id,
                kind="session_summary",
                title=summary_title,
                body_text=body_text,
                confidence=0.6,
                metadata=summary_metadata,
            )
    # Record observer work investment (tokens spent creating memories)
    observer_output_tokens = store.estimate_tokens(response.raw or "")
    observer_input_tokens = store.estimate_tokens(transcript)
    store.record_usage(
        "observe",
        session_id=session_id,
        tokens_read=observer_input_tokens,
        tokens_written=observer_output_tokens,
        metadata={
            "project": project,
            "observations": len(observations_to_store),
            "has_summary": summary_to_store is not None,
        },
    )

    store.end_session(
        session_id,
        metadata={"post": post, "source": "plugin", "event_count": len(events)},
    )
    store.close()


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        return
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"opencode-mem: invalid payload: {exc}") from exc
    ingest(payload)


if __name__ == "__main__":
    main()
