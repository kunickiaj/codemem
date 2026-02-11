from __future__ import annotations

from opencode_mem.ingest.events import event_to_tool_event


def test_event_to_tool_event_handles_non_dict_args() -> None:
    event = {
        "type": "tool.execute.after",
        "tool": "bash",
        "args": ["not", "a", "dict"],
        "result": "ok",
    }
    tool_event = event_to_tool_event(event, max_chars=200)
    assert tool_event is not None
    assert tool_event.cwd is None
    assert tool_event.tool_input == {}


def test_event_to_tool_event_uses_cwd_from_dict_args() -> None:
    event = {
        "type": "tool.execute.after",
        "tool": "bash",
        "args": {"cwd": "/tmp/work"},
        "result": "ok",
    }
    tool_event = event_to_tool_event(event, max_chars=200)
    assert tool_event is not None
    assert tool_event.cwd == "/tmp/work"
