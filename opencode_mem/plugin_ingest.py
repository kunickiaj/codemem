from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from .capture import (
    DEFAULT_MAX_TRANSCRIPT_BYTES,
    TRUNCATION_NOTICE,
    _max_transcript_bytes,
    build_artifact_bundle,
    capture_post_context,
    capture_pre_context,
)
from . import db
from .store import MemoryStore
from .summarizer import Summarizer


def _truncate_text(text: str, max_bytes: int) -> str:
    if max_bytes <= 0:
        return ""
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    truncated = encoded[:max_bytes].decode("utf-8", errors="replace")
    return f"{truncated}{TRUNCATION_NOTICE}"


def _build_transcript(events: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for event in events:
        stamp = event.get("timestamp") or ""
        tool = event.get("tool") or event.get("type") or "tool"
        lines.append(f"[{stamp}] {tool}")
        args = event.get("args")
        if args:
            lines.append(f"args: {json.dumps(args, ensure_ascii=False)}")
        result = event.get("result")
        if result:
            lines.append(f"result: {result}")
        error = event.get("error")
        if error:
            lines.append(f"error: {error}")
        lines.append("")
    return "\n".join(lines).strip()


def ingest(payload: dict[str, Any]) -> None:
    cwd = payload.get("cwd") or os.getcwd()
    events = payload.get("events") or []
    if not isinstance(events, list) or not events:
        return
    pre = capture_pre_context(cwd)
    post = capture_post_context(cwd)
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
    max_bytes = _max_transcript_bytes()
    transcript = _build_transcript(events)
    transcript = _truncate_text(transcript, max_bytes)
    artifacts = build_artifact_bundle(pre, post, transcript)
    for kind, body, path in artifacts:
        store.add_artifact(session_id, kind=kind, path=path, content_text=body)
    events_json = json.dumps(events, ensure_ascii=False)
    events_json = _truncate_text(events_json, max_bytes or DEFAULT_MAX_TRANSCRIPT_BYTES)
    store.add_artifact(
        session_id,
        kind="tool_events",
        path=None,
        content_text=events_json,
        metadata={"source": "plugin"},
    )
    summarizer = Summarizer(force_heuristic=True)
    summary = summarizer.summarize(
        transcript=transcript,
        diff_summary=post.get("git_diff") or "",
        recent_files=post.get("recent_files") or "",
    )
    store.remember(
        session_id,
        kind="session_summary",
        title="Session summary",
        body_text=summary.session_summary,
        confidence=0.6,
    )
    for obs in summary.observations:
        store.remember(
            session_id,
            kind="observation",
            title=obs[:80],
            body_text=obs,
            confidence=0.5,
        )
    if summary.entities:
        store.remember(
            session_id,
            kind="entities",
            title="Entities",
            body_text="; ".join(summary.entities),
            confidence=0.4,
        )
    transcript_tokens = store.estimate_tokens(transcript)
    summary_tokens = store.estimate_tokens(summary.session_summary)
    summary_tokens += sum(store.estimate_tokens(obs) for obs in summary.observations)
    summary_tokens += sum(store.estimate_tokens(entity) for entity in summary.entities)
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
