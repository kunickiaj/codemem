from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Iterable

from .capture import (
    DEFAULT_MAX_TRANSCRIPT_BYTES,
    TRUNCATION_NOTICE,
    _max_transcript_bytes,
    build_artifact_bundle,
    capture_post_context,
    capture_pre_context,
)
from .classifier import ObservationClassifier
from .config import load_config
from . import db
from .store import MemoryStore
from .summarizer import Summarizer, is_low_signal_observation


CONFIG = load_config()
CLASSIFIER = ObservationClassifier()

STORE_SUMMARY = CONFIG.store_summary
STORE_OBSERVATIONS = CONFIG.store_observations
STORE_ENTITIES = CONFIG.store_entities
STORE_TYPED = CONFIG.store_typed

LOW_SIGNAL_TOOLS = {
    "read",
    "edit",
    "write",
    "glob",
    "grep",
    "tui",
    "shell",
    "cmd",
    "task",
}

HIGH_SIGNAL_TOOLS = {
    "bash",
    "webfetch",
    "fetch",
    "mcp",
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


def _truncate_text(text: str, max_bytes: int) -> str:
    if max_bytes <= 0:
        return ""
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    truncated = encoded[:max_bytes].decode("utf-8", errors="replace")
    return f"{truncated}{TRUNCATION_NOTICE}"


def _summarize_output(value: str, limit: int = 360) -> str:
    if not value:
        return ""
    cleaned = " ".join(line.strip() for line in value.splitlines() if line.strip())
    if len(cleaned) > limit:
        return f"{cleaned[:limit]}…"
    return cleaned


def _normalize_tool_name(event: dict[str, Any]) -> str:
    tool = str(event.get("tool") or event.get("type") or "tool").lower()
    if "." in tool:
        tool = tool.split(".")[-1]
    if ":" in tool:
        tool = tool.split(":")[-1]
    return tool


def _has_high_signal_events(events: Iterable[dict[str, Any]]) -> bool:
    for event in events:
        tool = _normalize_tool_name(event)
        if tool in HIGH_SIGNAL_TOOLS:
            return True
    return False


def _filter_events(events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    filtered: list[dict[str, Any]] = []
    for event in events:
        if event.get("type") == "user_prompt":
            continue
        tool = _normalize_tool_name(event)
        if tool in LOW_SIGNAL_TOOLS:
            continue
        filtered.append(event)
    return filtered


def _format_event(event: dict[str, Any]) -> str | None:
    tool = _normalize_tool_name(event)
    stamp = event.get("timestamp") or ""
    args = event.get("args") or {}
    result = event.get("result") or ""
    error = event.get("error") or ""

    if tool in LOW_SIGNAL_TOOLS:
        return None

    if tool == "bash":
        command = args.get("command") or args.get("cmd") or ""
        header = f"[{stamp}] bash {command}".strip()
        output = _summarize_output(str(result))
        if output and output.lower().strip() not in LOW_SIGNAL_OUTPUTS:
            return f"{header} :: {output}".strip()
        return header

    if tool in {"webfetch", "fetch"}:
        url = args.get("url") or args.get("uri") or args.get("href") or ""
        header = f"[{stamp}] {tool} {url}".strip()
        return header

    if tool == "mcp":
        name = args.get("name") or args.get("tool") or ""
        header = f"[{stamp}] mcp {name}".strip()
        return header

    if tool in HIGH_SIGNAL_TOOLS:
        header = f"[{stamp}] {tool}".strip()
        output = _summarize_output(str(result))
        if output and output.lower().strip() not in LOW_SIGNAL_OUTPUTS:
            return f"{header} :: {output}".strip()
        return header

    if error:
        return f"[{stamp}] {tool} error: {_summarize_output(str(error))}".strip()

    return None


def _build_transcript(
    events: Iterable[dict[str, Any]],
) -> tuple[str, list[dict[str, Any]], list[str]]:
    filtered = _filter_events(events)
    lines: list[str] = []
    for event in filtered:
        line = _format_event(event)
        if line:
            lines.append(line)
    return "\n".join(lines).strip(), filtered, lines


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
    max_bytes = _max_transcript_bytes()
    transcript, filtered_events, transcript_lines = _build_transcript(events)
    transcript = _truncate_text(transcript, max_bytes)
    allow_memories = _has_high_signal_events(events) or bool(diff_summary.strip())
    if not transcript.strip():
        if not allow_memories:
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
        if diff_summary.strip():
            transcript = _truncate_text(f"Diff summary:\n{diff_summary}", max_bytes)
    artifacts = build_artifact_bundle(pre, post, transcript)
    for kind, body, path in artifacts:
        store.add_artifact(session_id, kind=kind, path=path, content_text=body)
    events_json = json.dumps(filtered_events, ensure_ascii=False)
    events_json = _truncate_text(events_json, max_bytes or DEFAULT_MAX_TRANSCRIPT_BYTES)
    store.add_artifact(
        session_id,
        kind="tool_events",
        path=None,
        content_text=events_json,
        metadata={"source": "plugin"},
    )
    summary = None
    if transcript.strip():
        summarizer = Summarizer(force_heuristic=True)
        summary = summarizer.summarize(
            transcript=transcript,
            diff_summary=diff_summary,
            recent_files=post.get("recent_files") or "",
        )
        if STORE_SUMMARY and (
            summary.session_summary
            and len(summary.session_summary.strip()) >= 40
            and not is_low_signal_observation(summary.session_summary)
        ):
            store.remember(
                session_id,
                kind="session_summary",
                title="Session summary",
                body_text=summary.session_summary,
                confidence=0.6,
            )
        if STORE_OBSERVATIONS:
            for obs in summary.observations:
                if is_low_signal_observation(obs):
                    continue
                if len(obs.strip()) < 20:
                    continue
                store.remember(
                    session_id,
                    kind="observation",
                    title=obs[:80],
                    body_text=obs,
                    confidence=0.5,
                )
        if STORE_ENTITIES and summary.entities:
            filtered_entities = [
                ent for ent in summary.entities if not is_low_signal_observation(ent)
            ]
            if filtered_entities:
                store.remember(
                    session_id,
                    kind="entities",
                    title="Entities",
                    body_text="; ".join(filtered_entities),
                    confidence=0.4,
                )
        if STORE_TYPED:
            typed_memories = CLASSIFIER.classify(
                transcript=transcript,
                summary=summary,
                events=filtered_events,
                context={
                    "diff_summary": diff_summary,
                    "recent_files": post.get("recent_files") or "",
                    "tool_events": "\n".join(transcript_lines[:20]),
                },
            )
            for mem in typed_memories:
                if is_low_signal_observation(mem.title) or is_low_signal_observation(
                    mem.narrative
                ):
                    continue
                metadata: dict[str, Any] = {"source": "classifier"}
                if mem.metadata:
                    metadata["detail"] = mem.metadata
                store.remember_observation(
                    session_id,
                    kind=mem.category,
                    title=mem.title,
                    narrative=mem.narrative,
                    subtitle=mem.subtitle,
                    facts=mem.facts,
                    concepts=mem.concepts,
                    files_read=mem.files_read,
                    files_modified=mem.files_modified,
                    prompt_number=prompt_number,
                    confidence=mem.confidence,
                    metadata=metadata,
                )
    if summary:
        transcript_tokens = store.estimate_tokens(transcript)
        summary_tokens = store.estimate_tokens(summary.session_summary)
        summary_tokens += sum(
            store.estimate_tokens(obs) for obs in summary.observations
        )
        summary_tokens += sum(
            store.estimate_tokens(entity) for entity in summary.entities
        )
        tokens_saved = max(0, transcript_tokens - summary_tokens)
        store.record_usage(
            "summarize",
            session_id=session_id,
            tokens_read=transcript_tokens,
            tokens_written=summary_tokens,
            tokens_saved=tokens_saved,
            metadata={"mode": "plugin"},
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
