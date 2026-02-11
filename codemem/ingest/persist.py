from __future__ import annotations

from collections.abc import Callable
from typing import Any


def persist_user_prompts(
    store: Any,
    *,
    session_id: int,
    project: str | None,
    prompts: list[dict[str, Any]],
) -> int | None:
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
    return prompt_number


def persist_artifacts(
    store: Any,
    *,
    session_id: int,
    artifacts: list[tuple[str, str, str]],
    flush_batch: dict[str, Any] | None,
) -> None:
    for kind, body, path in artifacts:
        artifact_meta: dict[str, Any] | None = {"flush_batch": flush_batch} if flush_batch else None
        store.add_artifact(
            session_id, kind=kind, path=path, content_text=body, metadata=artifact_meta
        )


def persist_observations(
    store: Any,
    *,
    session_id: int,
    observations: list[Any],
    prompt_number: int | None,
    discovery_group: str | None,
    discovery_tokens: int,
    discovery_source: str,
    flush_batch: dict[str, Any] | None,
) -> None:
    for obs in observations:
        metadata: dict[str, Any] = {"source": "observer"}
        if flush_batch:
            metadata["flush_batch"] = flush_batch
        if discovery_group:
            metadata["discovery_group"] = discovery_group
        metadata["discovery_tokens"] = int(discovery_tokens)
        metadata["discovery_source"] = discovery_source
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


def persist_session_summary(
    store: Any,
    *,
    session_id: int,
    project: str | None,
    summary: Any,
    prompt_number: int | None,
    request_original: str | None,
    discovery_group: str | None,
    discovery_tokens: int,
    discovery_source: str,
    flush_batch: dict[str, Any] | None,
    summary_body: Callable[[Any], str],
    is_low_signal_text: Callable[[str], bool],
    first_sentence: Callable[[str], str],
) -> None:
    summary_metadata: dict[str, Any] = {
        "request": summary.request,
        "investigated": summary.investigated,
        "learned": summary.learned,
        "completed": summary.completed,
        "next_steps": summary.next_steps,
        "notes": summary.notes,
        "files_read": summary.files_read,
        "files_modified": summary.files_modified,
        "prompt_number": prompt_number,
        "source": "observer",
    }
    if flush_batch:
        summary_metadata["flush_batch"] = flush_batch
    if request_original:
        summary_metadata["request_original"] = request_original
    if discovery_group:
        summary_metadata["discovery_group"] = discovery_group
    summary_metadata["discovery_tokens"] = int(discovery_tokens)
    summary_metadata["discovery_source"] = discovery_source

    store.add_session_summary(
        session_id,
        project,
        summary.request,
        summary.investigated,
        summary.learned,
        summary.completed,
        summary.next_steps,
        summary.notes,
        files_read=summary.files_read,
        files_edited=summary.files_modified,
        prompt_number=prompt_number,
        metadata=summary_metadata,
    )
    body_text = summary_body(summary)
    if body_text and not is_low_signal_text(body_text):
        summary_title = first_sentence(summary.request) or "Session summary"
        store.remember(
            session_id,
            kind="session_summary",
            title=summary_title,
            body_text=body_text,
            confidence=0.6,
            metadata=summary_metadata,
        )


def record_observer_usage(
    store: Any,
    *,
    session_id: int,
    project: str | None,
    response_raw: str,
    transcript: str,
    observation_count: int,
    has_summary: bool,
) -> None:
    # Record observer work investment (tokens spent creating memories)
    observer_output_tokens = store.estimate_tokens(response_raw or "")
    observer_input_tokens = store.estimate_tokens(transcript)
    store.record_usage(
        "observe",
        session_id=session_id,
        tokens_read=observer_input_tokens,
        tokens_written=observer_output_tokens,
        metadata={
            "project": project,
            "observations": observation_count,
            "has_summary": has_summary,
        },
    )


def end_session(
    store: Any,
    *,
    session_id: int,
    metadata: dict[str, Any],
) -> None:
    store.end_session(session_id, metadata=metadata)
