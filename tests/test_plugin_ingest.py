import json
from dataclasses import asdict
from pathlib import Path
from unittest.mock import MagicMock, patch

from opencode_mem.observer_prompts import ToolEvent
from opencode_mem.plugin_ingest import (
    _budget_tool_events,
    _build_transcript,
    _event_to_tool_event,
    ingest,
)


def test_build_transcript_from_events() -> None:
    """Transcript should be built from user prompts and assistant messages in order."""
    events = [
        {
            "type": "user_prompt",
            "prompt_text": "What is 2 + 2?",
            "prompt_number": 1,
            "timestamp": "2026-01-14T19:00:00Z",
        },
        {
            "type": "tool.execute.after",
            "tool": "bash",
            "args": {"command": "echo 4"},
            "result": "4",
            "timestamp": "2026-01-14T19:00:01Z",
        },
        {
            "type": "assistant_message",
            "assistant_text": "The answer is 4.",
            "timestamp": "2026-01-14T19:00:02Z",
        },
        {
            "type": "user_prompt",
            "prompt_text": "Thanks!",
            "prompt_number": 2,
            "timestamp": "2026-01-14T19:00:03Z",
        },
        {
            "type": "assistant_message",
            "assistant_text": "You're welcome!",
            "timestamp": "2026-01-14T19:00:04Z",
        },
    ]

    transcript = _build_transcript(events)

    assert "User: What is 2 + 2?" in transcript
    assert "Assistant: The answer is 4." in transcript
    assert "User: Thanks!" in transcript
    assert "Assistant: You're welcome!" in transcript
    # Tool events should NOT appear in transcript (they're separate)
    assert "echo 4" not in transcript
    # Order should be preserved
    assert transcript.index("What is 2 + 2?") < transcript.index("The answer is 4.")
    assert transcript.index("Thanks!") < transcript.index("You're welcome!")


def test_build_transcript_strips_private_blocks() -> None:
    events = [
        {
            "type": "user_prompt",
            "prompt_text": "Hello <private>secret</private> world",
            "prompt_number": 1,
            "timestamp": "2026-01-14T19:00:00Z",
        },
        {
            "type": "assistant_message",
            "assistant_text": "Ack <private>hidden</private>",
            "timestamp": "2026-01-14T19:00:01Z",
        },
    ]
    transcript = _build_transcript(events)
    assert "secret" not in transcript
    assert "hidden" not in transcript
    assert "Hello" in transcript


def test_build_transcript_empty_events() -> None:
    """Empty events should produce empty transcript."""
    assert _build_transcript([]) == ""


def test_build_transcript_no_messages() -> None:
    """Only tool events should produce empty transcript."""
    events = [
        {
            "type": "tool.execute.after",
            "tool": "bash",
            "args": {"command": "ls"},
            "result": "file.txt",
        },
    ]
    assert _build_transcript(events) == ""


def test_tool_events_are_json_serializable() -> None:
    """ToolEvent objects must be serializable for discovery_text building."""
    events = [
        ToolEvent(
            tool_name="bash",
            tool_input={"command": "ls"},
            tool_output="file.txt",
            tool_error=None,
            timestamp="2026-01-14T19:18:05.811Z",
            cwd="/tmp",
        ),
        ToolEvent(
            tool_name="read",
            tool_input={"filePath": "/tmp/file.txt"},
            tool_output="contents",
            tool_error=None,
            timestamp="2026-01-14T19:18:06.811Z",
            cwd=None,
        ),
    ]
    serialized = json.dumps([asdict(e) for e in events], ensure_ascii=False)
    parsed = json.loads(serialized)
    assert len(parsed) == 2
    assert parsed[0]["tool_name"] == "bash"
    assert parsed[1]["tool_name"] == "read"


def test_ingest_with_tool_events_does_not_crash(tmp_path: Path) -> None:
    """Ingest should handle payloads with tool events without JSON serialization errors."""
    db_path = tmp_path / "test.sqlite"

    payload = {
        "cwd": str(tmp_path),
        "project": "test-project",
        "started_at": "2026-01-14T19:00:00Z",
        "events": [
            {
                "type": "user_prompt",
                "prompt_text": "Fix the bug",
                "prompt_number": 1,
                "timestamp": "2026-01-14T19:00:01Z",
            },
            {
                "type": "tool.execute.after",
                "tool": "bash",
                "args": {"command": "git status"},
                "result": "On branch main",
                "timestamp": "2026-01-14T19:00:02Z",
            },
            {
                "type": "tool.execute.after",
                "tool": "read",
                "args": {"filePath": "/tmp/foo.py"},
                "result": "def foo(): pass",
                "timestamp": "2026-01-14T19:00:03Z",
            },
            {
                "type": "assistant_message",
                "assistant_text": "I fixed the bug by updating the function.",
                "timestamp": "2026-01-14T19:00:04Z",
            },
        ],
    }

    mock_response = MagicMock()
    mock_response.parsed.observations = []
    mock_response.parsed.summary = None
    mock_response.parsed.skip_summary_reason = None

    with (
        patch.dict("os.environ", {"OPENCODE_MEM_DB": str(db_path)}),
        patch("opencode_mem.plugin_ingest.OBSERVER") as mock_observer,
        patch("opencode_mem.plugin_ingest.capture_pre_context") as mock_pre,
        patch("opencode_mem.plugin_ingest.capture_post_context") as mock_post,
    ):
        mock_observer.observe.return_value = mock_response
        mock_pre.return_value = {"project": "test-project"}
        mock_post.return_value = {"git_diff": "", "recent_files": ""}

        # This should not raise TypeError about ToolEvent not being JSON serializable
        ingest(payload)

    assert db_path.exists(), "Database should be created"


def test_read_tool_output_is_compacted() -> None:
    huge = "\n".join([f"{i:04d}: line" for i in range(500)])
    event = {
        "type": "tool.execute.after",
        "tool": "read",
        "args": {"filePath": "/tmp/foo.py"},
        "result": huge,
        "timestamp": "2026-01-14T19:00:03Z",
    }
    tool_event = _event_to_tool_event(event, max_chars=50000)
    assert tool_event is not None
    assert tool_event.tool_name == "read"
    assert isinstance(tool_event.tool_output, str)
    assert "(+" in tool_event.tool_output
    assert len(tool_event.tool_output.splitlines()) <= 81


def test_bash_tool_output_is_compacted() -> None:
    huge = "\n".join([f"{i:04d}: line" for i in range(500)])
    event = {
        "type": "tool.execute.after",
        "tool": "bash",
        "args": {"command": "pytest"},
        "result": huge,
        "timestamp": "2026-01-14T19:00:03Z",
    }
    tool_event = _event_to_tool_event(event, max_chars=50000)
    assert tool_event is not None
    assert tool_event.tool_name == "bash"
    assert isinstance(tool_event.tool_output, str)
    assert "(+" in tool_event.tool_output
    assert len(tool_event.tool_output.splitlines()) <= 81


def test_tool_event_budget_dedupes_and_preserves_errors() -> None:
    events = [
        ToolEvent(
            tool_name="bash",
            tool_input={"command": "git status"},
            tool_output="clean",
            tool_error=None,
            timestamp="2026-01-14T19:18:05.811Z",
            cwd="/tmp",
        ),
        ToolEvent(
            tool_name="bash",
            tool_input={"command": "git status"},
            tool_output="clean",
            tool_error=None,
            timestamp="2026-01-14T19:18:06.811Z",
            cwd="/tmp",
        ),
        ToolEvent(
            tool_name="read",
            tool_input={"filePath": "/tmp/file.txt"},
            tool_output="x" * 5000,
            tool_error=None,
            timestamp="2026-01-14T19:18:07.811Z",
            cwd="/tmp",
        ),
        ToolEvent(
            tool_name="bash",
            tool_input={"command": "pytest"},
            tool_output="",
            tool_error="Traceback: boom",
            timestamp="2026-01-14T19:18:08.811Z",
            cwd="/tmp",
        ),
    ]
    budgeted = _budget_tool_events(events, max_total_chars=800, max_events=3)
    # dedupe
    assert sum(1 for e in budgeted if e.tool_input == {"command": "git status"}) == 1
    # error preserved
    assert any(e.tool_error for e in budgeted)
    assert len(budgeted) <= 3


def test_tool_event_budget_keeps_latest_git_status() -> None:
    events = [
        ToolEvent(
            tool_name="bash",
            tool_input={"command": "git status"},
            tool_output="clean",
            tool_error=None,
            timestamp="2026-01-14T19:18:05.811Z",
            cwd="/tmp",
        ),
        ToolEvent(
            tool_name="bash",
            tool_input={"command": "git status"},
            tool_output="dirty",
            tool_error=None,
            timestamp="2026-01-14T19:18:06.811Z",
            cwd="/tmp",
        ),
    ]
    budgeted = _budget_tool_events(events, max_total_chars=5000, max_events=10)
    assert len(budgeted) == 1
    assert budgeted[0].tool_output == "dirty"
