from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import codemem.plugin_ingest as plugin_ingest


class FakeStore:
    def __init__(self) -> None:
        self.prompts: list[dict[str, Any]] = []
        self.artifacts: list[dict[str, Any]] = []
        self.usage: list[dict[str, Any]] = []
        self.ended: list[dict[str, Any]] = []
        self.closed = False

    def get_or_create_opencode_session(self, *_args: Any, **_kwargs: Any) -> int:
        return 1

    def start_session(self, *_args: Any, **_kwargs: Any) -> int:
        return 1

    def add_user_prompt(self, *_args: Any, **kwargs: Any) -> None:
        self.prompts.append(kwargs)

    def add_artifact(self, *_args: Any, **kwargs: Any) -> None:
        self.artifacts.append(kwargs)

    def estimate_tokens(self, _text: str) -> int:
        return 0

    def remember_observation(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def add_session_summary(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def remember(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def record_usage(self, *_args: Any, **kwargs: Any) -> None:
        self.usage.append(kwargs)

    def end_session(self, *_args: Any, **kwargs: Any) -> None:
        self.ended.append(kwargs)

    def close(self) -> None:
        self.closed = True


def _make_response() -> SimpleNamespace:
    return SimpleNamespace(
        parsed=SimpleNamespace(observations=[], summary=None, skip_summary_reason=None),
        raw="",
    )


def _set_common_patches(monkeypatch: Any, store: FakeStore) -> None:
    monkeypatch.setattr(plugin_ingest, "MemoryStore", lambda *_args, **_kwargs: store)
    monkeypatch.setattr(
        plugin_ingest,
        "capture_pre_context",
        lambda _cwd: {"project": "demo", "git_remote": "", "git_branch": ""},
    )
    monkeypatch.setattr(
        plugin_ingest,
        "capture_post_context",
        lambda _cwd: {"git_diff": "", "recent_files": ""},
    )
    monkeypatch.setattr(
        plugin_ingest,
        "CONFIG",
        SimpleNamespace(summary_max_chars=5000, observer_max_chars=6000),
    )


def test_ingest_builds_transcript_and_persists_artifacts(monkeypatch: Any) -> None:
    store = FakeStore()
    captured: dict[str, Any] = {}

    def fake_build_artifact_bundle(pre: dict[str, Any], post: dict[str, Any], transcript: str):
        captured["transcript"] = transcript
        return [("transcript", "body", "transcript.md")]

    observer = SimpleNamespace(observe=lambda _ctx: _make_response())

    _set_common_patches(monkeypatch, store)
    monkeypatch.setattr(plugin_ingest, "build_artifact_bundle", fake_build_artifact_bundle)
    monkeypatch.setattr(plugin_ingest, "OBSERVER", observer)

    payload = {
        "cwd": "/tmp",
        "project": "demo",
        "started_at": "2026-01-28T00:00:00Z",
        "events": [
            {
                "type": "user_prompt",
                "prompt_text": "Hello <private>secret</private> world",
                "prompt_number": 1,
                "timestamp": "2026-01-28T00:00:01Z",
            },
            {
                "type": "assistant_message",
                "assistant_text": "Ack <private>hidden</private>",
                "timestamp": "2026-01-28T00:00:02Z",
            },
        ],
    }

    plugin_ingest.ingest(payload)

    assert captured["transcript"] == "User: Hello  world\n\nAssistant: Ack"
    assert store.artifacts == [
        {"kind": "transcript", "path": "transcript.md", "content_text": "body", "metadata": None}
    ]


def test_ingest_filters_and_budgets_tool_events(monkeypatch: Any) -> None:
    store = FakeStore()
    captured: dict[str, Any] = {}

    def fake_budget(tool_events, max_total_chars: int, max_events: int):
        captured["budget"] = {
            "tool_events": tool_events,
            "max_total_chars": max_total_chars,
            "max_events": max_events,
        }
        return list(tool_events)

    def fake_observe(ctx: Any):
        captured["observer_context"] = ctx
        return _make_response()

    _set_common_patches(monkeypatch, store)
    monkeypatch.setattr(plugin_ingest, "build_artifact_bundle", lambda *_: [])
    monkeypatch.setattr(plugin_ingest, "_budget_tool_events", fake_budget)
    monkeypatch.setattr(plugin_ingest, "OBSERVER", SimpleNamespace(observe=fake_observe))

    payload = {
        "cwd": "/tmp",
        "project": "demo",
        "started_at": "2026-01-28T00:00:00Z",
        "events": [
            {"type": "user_prompt", "prompt_text": "Check tools", "prompt_number": 1},
            {
                "type": "tool.execute.after",
                "tool": "shell",
                "args": {"command": "echo hi"},
                "result": "hi",
            },
            {
                "type": "tool.execute.after",
                "tool": "codemem_memory_search",
                "args": {"query": "anything"},
                "result": "[]",
            },
            {
                "type": "tool.execute.after",
                "tool": "read",
                "args": {"filePath": "/tmp/a.txt"},
                "result": "ok",
            },
            {
                "type": "tool.execute.after",
                "tool": "bash",
                "args": {"command": "ls"},
                "result": "a.txt",
            },
            {
                "type": "tool.execute.after",
                "tool": "functions.grep",
                "args": {"pattern": "todo"},
                "result": "x.py:1",
            },
        ],
    }

    plugin_ingest.ingest(payload)

    budget = captured["budget"]
    budget_names = {event.tool_name for event in budget["tool_events"]}
    assert budget_names == {"read", "bash", "grep"}
    assert budget["max_total_chars"] == 2000
    assert budget["max_events"] == 30

    observer_ctx = captured["observer_context"]
    assert {event.tool_name for event in observer_ctx.tool_events} == {"read", "bash", "grep"}


def test_ingest_early_exit_on_trivial_request(monkeypatch: Any) -> None:
    store = FakeStore()
    observer = MagicMock()

    _set_common_patches(monkeypatch, store)
    monkeypatch.setattr(plugin_ingest, "build_artifact_bundle", MagicMock())
    monkeypatch.setattr(plugin_ingest, "OBSERVER", observer)

    payload = {
        "cwd": "/tmp",
        "project": "demo",
        "started_at": "2026-01-28T00:00:00Z",
        "events": [
            {
                "type": "user_prompt",
                "prompt_text": "ok",
                "prompt_number": 1,
                "timestamp": "2026-01-28T00:00:01Z",
            }
        ],
    }

    plugin_ingest.ingest(payload)

    assert not observer.observe.called
    assert not plugin_ingest.build_artifact_bundle.called
    assert store.ended
    assert store.closed
