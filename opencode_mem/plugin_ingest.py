from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, Iterable

from .capture import (
    TRUNCATION_NOTICE,
    build_artifact_bundle,
    capture_post_context,
    capture_pre_context,
)
from .config import load_config
from . import db
from .observer import ObserverClient
from .observer_prompts import ObserverContext, ToolEvent
from .store import MemoryStore
from .summarizer import is_low_signal_observation
from .xml_parser import ParsedSummary, has_meaningful_observation


CONFIG = load_config()
OBSERVER = ObserverClient()

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

LOW_SIGNAL_OUTPUTS = {
    "wrote file successfully.",
    "wrote file successfully",
    "file written successfully.",
    "read file successfully.",
    "read file successfully",
    "<file>",
    "<image>",
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
    if tool in {"read", "write", "edit"}:
        return ""
    sanitized = _sanitize_payload(output, max_chars)
    text = str(sanitized or "")
    if _is_low_signal_output(text):
        return ""
    return sanitized


def _event_to_tool_event(event: dict[str, Any], max_chars: int) -> ToolEvent | None:
    if event.get("type") != "tool.execute.after":
        return None
    tool = _normalize_tool_name(event)
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


def _extract_tool_events(
    events: Iterable[dict[str, Any]], max_chars: int
) -> list[ToolEvent]:
    tool_events: list[ToolEvent] = []
    for event in events:
        tool_event = _event_to_tool_event(event, max_chars)
        if tool_event:
            tool_events.append(tool_event)
    return tool_events


def _summary_body(summary: ParsedSummary) -> str:
    for value in (
        summary.completed,
        summary.request,
        summary.learned,
        summary.investigated,
        summary.next_steps,
        summary.notes,
    ):
        if value:
            return value
    return ""


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
    pre = capture_pre_context(cwd)
    post = capture_post_context(cwd)
    diff_summary = post.get("git_diff") or ""
    project = payload.get("project") or pre.get("project")
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
    max_chars = CONFIG.summary_max_chars
    tool_events = _extract_tool_events(events, max_chars)
    assistant_messages = _extract_assistant_messages(events)
    last_assistant_message = assistant_messages[-1] if assistant_messages else None
    latest_prompt = prompts[-1]["prompt_text"] if prompts else None
    should_process = (
        bool(tool_events)
        or bool(latest_prompt)
        or (STORE_SUMMARY and last_assistant_message)
    )
    if not should_process:
        store.end_session(
            session_id,
            metadata={
                "post": post,
                "source": "plugin",
                "event_count": len(events),
            },
        )
        store.close()
        return
    artifacts = build_artifact_bundle(pre, post, "")
    for kind, body, path in artifacts:
        store.add_artifact(session_id, kind=kind, path=path, content_text=body)
    observer_context = ObserverContext(
        project=project,
        user_prompt=latest_prompt,
        prompt_number=prompt_number,
        tool_events=tool_events,
        last_assistant_message=last_assistant_message if STORE_SUMMARY else None,
        include_summary=STORE_SUMMARY,
        diff_summary=diff_summary,
        recent_files=post.get("recent_files") or "",
    )
    response = OBSERVER.observe(observer_context)
    parsed = response.parsed
    discovery_parts = []
    if latest_prompt:
        discovery_parts.append(latest_prompt)
    if last_assistant_message:
        discovery_parts.append(last_assistant_message)
    if tool_events:
        discovery_parts.append(
            json.dumps([asdict(e) for e in tool_events], ensure_ascii=False)
        )
    discovery_text = "\n".join(discovery_parts)
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
        }
        for obs in parsed.observations:
            kind = obs.kind.strip().lower()
            if kind not in allowed_kinds:
                continue
            if not (obs.title or obs.narrative):
                continue
            if is_low_signal_observation(obs.title) or is_low_signal_observation(
                obs.narrative
            ):
                continue
            observations_to_store.append(obs)

    summary_to_store = None
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
            summary_to_store = summary

    total_items = len(observations_to_store) + (1 if summary_to_store else 0)
    per_item_tokens = 0
    if discovery_tokens > 0 and total_items > 0:
        per_item_tokens = max(1, discovery_tokens // total_items)

    for obs in observations_to_store:
        metadata = {"source": "observer"}
        if per_item_tokens:
            metadata["discovery_tokens"] = per_item_tokens
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
        summary_metadata = {
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
        if per_item_tokens:
            summary_metadata["discovery_tokens"] = per_item_tokens
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
            store.remember(
                session_id,
                kind="session_summary",
                title="Session summary",
                body_text=body_text,
                confidence=0.6,
                metadata=summary_metadata,
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
