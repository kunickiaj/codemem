from __future__ import annotations

import json
import os
import sys
from collections.abc import Iterable
from dataclasses import asdict
from pathlib import Path, PureWindowsPath
from typing import Any

from . import db
from .capture import build_artifact_bundle, capture_post_context, capture_pre_context
from .config import load_config
from .ingest.context import build_artifacts as _build_artifacts_impl
from .ingest.context import capture_context as _capture_context_impl
from .ingest.events import (
    LOW_SIGNAL_TOOLS,
)
from .ingest.events import (
    budget_tool_events as _budget_tool_events_impl,
)
from .ingest.events import (
    event_to_tool_event as _event_to_tool_event_impl,
)
from .ingest.events import (
    extract_tool_events as _extract_tool_events_impl,
)
from .ingest.events import (
    is_internal_memory_tool as _is_internal_memory_tool_impl,
)
from .ingest.events import (
    normalize_tool_name as _normalize_tool_name_impl,
)
from .ingest.persist import (
    end_session as _end_session_impl,
)
from .ingest.persist import (
    persist_artifacts as _persist_artifacts_impl,
)
from .ingest.persist import (
    persist_observations as _persist_observations_impl,
)
from .ingest.persist import (
    persist_session_summary as _persist_session_summary_impl,
)
from .ingest.persist import (
    persist_user_prompts as _persist_user_prompts_impl,
)
from .ingest.persist import (
    record_observer_usage as _record_observer_usage_impl,
)
from .ingest.transcript import (
    build_transcript as _build_transcript_impl,
)
from .ingest.transcript import (
    derive_request as _derive_request_impl,
)
from .ingest.transcript import (
    first_sentence as _first_sentence_impl,
)
from .ingest.transcript import (
    is_trivial_request as _is_trivial_request_impl,
)
from .ingest.transcript import (
    normalize_request_text as _normalize_request_text_impl,
)
from .ingest_sanitize import _strip_private
from .observer import ObserverClient
from .observer_prompts import ObserverContext, ToolEvent
from .store import MemoryStore
from .summarizer import is_low_signal_observation
from .utils import resolve_project
from .xml_parser import ParsedSummary, has_meaningful_observation

CONFIG: object | None = None
OBSERVER: ObserverClient | None = None

STORE_SUMMARY = True
STORE_TYPED = True


def _is_internal_memory_tool(tool: str) -> bool:
    """Return True for codemem memory retrieval tools.

    These tools surface previously stored memory. Treating their outputs as
    new evidence can create feedback loops and noisy, self-referential memories.
    """

    return _is_internal_memory_tool_impl(tool)


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
    return _normalize_tool_name_impl(event)


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

    return _build_transcript_impl(events, strip_private=_strip_private)


def _event_to_tool_event(event: dict[str, Any], max_chars: int) -> ToolEvent | None:
    return _event_to_tool_event_impl(event, max_chars=max_chars, low_signal_tools=LOW_SIGNAL_TOOLS)


def _extract_tool_events(events: Iterable[dict[str, Any]], max_chars: int) -> list[ToolEvent]:
    return _extract_tool_events_impl(events, max_chars)


def _budget_tool_events(
    tool_events: list[ToolEvent],
    *,
    max_total_chars: int,
    max_events: int,
) -> list[ToolEvent]:
    return _budget_tool_events_impl(
        tool_events,
        max_total_chars=max_total_chars,
        max_events=max_events,
    )


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
    return _normalize_request_text_impl(text)


def _is_trivial_request(text: str | None) -> bool:
    return _is_trivial_request_impl(text, trivial_requests=TRIVIAL_REQUESTS)


def _first_sentence(text: str) -> str:
    return _first_sentence_impl(text)


def _derive_request(summary: ParsedSummary) -> str:
    return _derive_request_impl(summary)


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


def _normalize_project_label(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if "/" in text or "\\" in text:
        looks_like_windows_path = "\\" in text or (
            len(text) >= 2 and text[1] == ":" and text[0].isalpha()
        )
        if looks_like_windows_path:
            return PureWindowsPath(text).name or None
        return Path(text).name or None
    return text


def _resolve_ingest_project(cwd: str, payload_project: Any, pre_project: Any) -> str | None:
    env_project = _normalize_project_label(os.environ.get("CODEMEM_PROJECT"))
    if env_project:
        return env_project

    payload_label = _normalize_project_label(payload_project)
    pre_label = _normalize_project_label(pre_project)
    cwd_project = _normalize_project_label(resolve_project(cwd))
    if payload_label:
        if not cwd_project:
            return payload_label
        if payload_label == cwd_project:
            return payload_label
        if not pre_label:
            return cwd_project
        if pre_label and payload_label == pre_label:
            return cwd_project
        return payload_label

    if cwd_project:
        return cwd_project

    return pre_label


def ingest(payload: dict[str, Any]) -> None:
    cwd = payload.get("cwd") or os.getcwd()
    events = payload.get("events") or []
    if not isinstance(events, list) or not events:
        return

    # Extract session context from plugin (for comprehensive memories)
    session_context = payload.get("session_context") or {}
    flush_batch = session_context.get("flush_batch")
    if not isinstance(flush_batch, dict):
        flush_batch = None
    first_prompt = session_context.get("first_prompt")
    prompt_count = session_context.get("prompt_count", 0)
    tool_count = session_context.get("tool_count", 0)
    duration_ms = session_context.get("duration_ms", 0)
    files_modified = session_context.get("files_modified", [])
    files_read = session_context.get("files_read", [])

    pre, post = _capture_context_impl(
        cwd,
        capture_pre=capture_pre_context,
        capture_post=capture_post_context,
    )
    diff_summary = post.get("git_diff") or ""
    project = _resolve_ingest_project(cwd, payload.get("project"), pre.get("project"))
    repo_root = pre.get("project") or None
    db_path = os.environ.get("CODEMEM_DB")
    store = MemoryStore(Path(db_path) if db_path else db.DEFAULT_DB_PATH)
    try:
        started_at = payload.get("started_at")
        opencode_session_id = session_context.get("opencode_session_id")
        if isinstance(opencode_session_id, str) and opencode_session_id.strip():
            session_id = store.get_or_create_opencode_session(
                opencode_session_id=opencode_session_id,
                cwd=cwd,
                project=project,
                metadata={
                    "pre": pre,
                    "source": "plugin",
                    "event_count": len(events),
                    "started_at": started_at,
                    "session_context": session_context,
                },
            )
        else:
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
        prompt_number = _persist_user_prompts_impl(
            store,
            session_id=session_id,
            project=project,
            prompts=prompts,
        )
        max_chars = _get_config().summary_max_chars
        tool_events = _extract_tool_events(events, max_chars)

        cfg = _get_config()
        observer_budget = int(getattr(cfg, "observer_max_chars", 12000) or 12000)
        tool_budget = max(2000, min(8000, observer_budget - 5000))
        tool_events = _budget_tool_events(tool_events, max_total_chars=tool_budget, max_events=30)
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
            _end_session_impl(
                store,
                session_id=session_id,
                metadata={
                    "post": post,
                    "source": "plugin",
                    "event_count": len(events),
                    "session_context": session_context,
                },
            )
            return
        transcript = _build_transcript(events)
        artifacts = _build_artifacts_impl(pre, post, transcript, build_bundle=build_artifact_bundle)
        _persist_artifacts_impl(
            store,
            session_id=session_id,
            artifacts=artifacts,
            flush_batch=flush_batch,
        )

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
        flusher = session_context.get("flusher")
        if isinstance(flusher, str) and flusher == "raw_events" and not response.raw:
            # Raw-event flushing must be lossless. If the observer call fails (no raw output),
            # raise so the flush batch is marked error and the cursor is not advanced.
            raise RuntimeError("observer failed during raw-event flush")
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

        discovery_group = None
        if isinstance(opencode_session_id, str) and opencode_session_id.strip():
            if prompt_number is not None:
                discovery_group = f"{opencode_session_id.strip()}:p{prompt_number}"
            else:
                discovery_group = f"{opencode_session_id.strip()}:unknown"
        elif prompt_number is not None:
            discovery_group = f"session:{session_id}:p{prompt_number}"

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

        _persist_observations_impl(
            store,
            session_id=session_id,
            observations=observations_to_store,
            prompt_number=prompt_number,
            discovery_group=discovery_group,
            discovery_tokens=int(discovery_tokens),
            discovery_source="usage" if usage_token_total > 0 else "estimate",
            flush_batch=flush_batch,
        )

        if summary_to_store:
            _persist_session_summary_impl(
                store,
                session_id=session_id,
                project=project,
                summary=summary_to_store,
                prompt_number=prompt_number,
                request_original=request_original,
                discovery_group=discovery_group,
                discovery_tokens=int(discovery_tokens),
                discovery_source="usage" if usage_token_total > 0 else "estimate",
                flush_batch=flush_batch,
                summary_body=_summary_body,
                is_low_signal_text=is_low_signal_observation,
                first_sentence=_first_sentence,
            )

        _record_observer_usage_impl(
            store,
            session_id=session_id,
            project=project,
            response_raw=response.raw or "",
            transcript=transcript,
            observation_count=len(observations_to_store),
            has_summary=summary_to_store is not None,
        )

        _end_session_impl(
            store,
            session_id=session_id,
            metadata={"post": post, "source": "plugin", "event_count": len(events)},
        )
    finally:
        store.close()


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        return
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"codemem: invalid payload: {exc}") from exc
    ingest(payload)


if __name__ == "__main__":
    main()
