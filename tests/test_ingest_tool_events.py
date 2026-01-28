from opencode_mem.ingest_tool_events import (
    _budget_tool_events,
    _compact_bash_output,
    _compact_list_output,
    _compact_read_output,
    _tool_event_importance,
    _tool_event_signature,
)
from opencode_mem.observer_prompts import ToolEvent


def test_compact_read_output_truncates_lines() -> None:
    text = "a\nb\nc"
    compacted = _compact_read_output(text, max_lines=2, max_chars=1000)
    assert compacted == "a\nb\n... (+1 more lines)"


def test_compact_read_output_truncates_chars() -> None:
    text = "a\nb\nc"
    compacted = _compact_read_output(text, max_lines=10, max_chars=3)
    assert compacted == "a\nb\n... (truncated)"


def test_compact_wrappers_match_read_behavior() -> None:
    text = "a\nb\nc"
    assert _compact_bash_output(text, max_lines=2, max_chars=1000) == _compact_read_output(
        text, max_lines=2, max_chars=1000
    )
    assert _compact_list_output(text, max_lines=2, max_chars=1000) == _compact_read_output(
        text, max_lines=2, max_chars=1000
    )


def test_tool_event_signature_special_cases_git_status() -> None:
    event = ToolEvent(
        tool_name="bash",
        tool_input={"command": "git status"},
        tool_output="ok",
        tool_error=None,
    )
    assert _tool_event_signature(event) == "bash:git status"


def test_tool_event_importance_scores_errors() -> None:
    event = ToolEvent(
        tool_name="read",
        tool_input={},
        tool_output="",
        tool_error="boom",
    )
    assert _tool_event_importance(event) == 120


def test_budget_tool_events_dedupes_by_signature() -> None:
    first = ToolEvent(
        tool_name="read",
        tool_input={"path": "a"},
        tool_output="x",
        tool_error=None,
        timestamp="t1",
    )
    second = ToolEvent(
        tool_name="read",
        tool_input={"path": "a"},
        tool_output="x",
        tool_error=None,
        timestamp="t2",
    )
    deduped = _budget_tool_events([first, second], max_total_chars=10000, max_events=10)
    assert len(deduped) == 1
    assert deduped[0].timestamp == "t2"


def test_budget_tool_events_keeps_highest_importance() -> None:
    read_event = ToolEvent(
        tool_name="read",
        tool_input={},
        tool_output="x",
        tool_error=None,
    )
    edit_event = ToolEvent(
        tool_name="edit",
        tool_input={},
        tool_output="x",
        tool_error=None,
    )
    bash_event = ToolEvent(
        tool_name="bash",
        tool_input={},
        tool_output="x",
        tool_error=None,
    )
    kept = _budget_tool_events(
        [read_event, edit_event, bash_event], max_total_chars=10000, max_events=1
    )
    assert len(kept) == 1
    assert kept[0].tool_name == "edit"
