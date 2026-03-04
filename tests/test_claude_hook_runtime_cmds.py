from __future__ import annotations

import io
import json
import shutil
import stat
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from codemem.commands.claude_hook_runtime_cmds import (
    _build_inject_query,
    _track_hook_session_state,
    claude_hook_ingest_cmd,
    claude_hook_inject_cmd,
)


def test_claude_hook_inject_cmd_returns_continue_when_pack_missing(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    payload = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-1",
        "prompt": "run tests",
        "cwd": "/tmp/worktrees/codemem",
    }
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._track_hook_session_state",
        lambda _payload: {},
    )
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._fetch_pack_text",
        lambda **_: None,
    )

    claude_hook_inject_cmd()

    output = json.loads(capsys.readouterr().out)
    assert output == {"continue": True}


def test_claude_hook_inject_cmd_prefers_cwd_project_and_emits_context(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    payload = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-2",
        "prompt": "run tests",
        "cwd": "/tmp/worktrees/codemem",
        "project": "main",
    }
    captured: dict[str, object] = {}

    def _fake_fetch_pack_text(
        *,
        prompt: str,
        project: str | None,
        limit: int | None,
        token_budget: int | None,
        working_set_files: list[str] | None,
    ) -> str:
        captured["prompt"] = prompt
        captured["project"] = project
        captured["limit"] = limit
        captured["token_budget"] = token_budget
        captured["working_set_files"] = working_set_files
        return "Remember to run targeted tests."

    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._track_hook_session_state",
        lambda _payload: {},
    )
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds.resolve_project", lambda _: "codemem"
    )
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._fetch_pack_text",
        _fake_fetch_pack_text,
    )

    claude_hook_inject_cmd()

    output = json.loads(capsys.readouterr().out)
    assert output["continue"] is True
    assert output["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
    assert "Remember to run targeted tests." in output["hookSpecificOutput"]["additionalContext"]
    assert captured["project"] == "codemem"


def test_claude_hook_inject_cmd_prefers_local_pack_before_http_fallback(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    payload = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-local-first",
        "prompt": "run tests",
    }
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._track_hook_session_state",
        lambda _payload: {},
    )
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._build_local_pack_text",
        lambda **_: "local pack text",
    )

    def _unexpected_http(**_: object) -> str | None:
        pytest.fail("HTTP fallback should not run when local pack succeeds")

    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._fetch_pack_text_http",
        _unexpected_http,
    )

    claude_hook_inject_cmd()

    output = json.loads(capsys.readouterr().out)
    assert output["continue"] is True
    assert "local pack text" in output["hookSpecificOutput"]["additionalContext"]


def test_claude_hook_inject_cmd_uses_http_fallback_when_local_pack_errors(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    payload = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-http-fallback",
        "prompt": "run tests",
    }
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._track_hook_session_state",
        lambda _payload: {},
    )

    def _raise_local(**_: object) -> str | None:
        raise RuntimeError("local unavailable")

    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._build_local_pack_text",
        _raise_local,
    )
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._fetch_pack_text_http",
        lambda **_: "http fallback text",
    )

    claude_hook_inject_cmd()

    output = json.loads(capsys.readouterr().out)
    assert output["continue"] is True
    assert "http fallback text" in output["hookSpecificOutput"]["additionalContext"]


def test_claude_hook_inject_cmd_returns_continue_when_local_pack_empty_without_http(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    payload = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-no-pack",
        "prompt": "run tests",
    }
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._track_hook_session_state",
        lambda _payload: {},
    )
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._build_local_pack_text",
        lambda **_: None,
    )

    def _unexpected_http(**_: object) -> str | None:
        pytest.fail("HTTP fallback should not run when local pack returns empty")

    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._fetch_pack_text_http",
        _unexpected_http,
    )

    claude_hook_inject_cmd()

    output = json.loads(capsys.readouterr().out)
    assert output == {"continue": True}


def test_build_inject_query_matches_opencode_signal_order() -> None:
    state = {
        "first_prompt": "build release automation",
        "files_modified": [
            "/repo/src/first.py",
            "/repo/src/second.py",
        ],
    }

    query = _build_inject_query(prompt="fix edge case", project="codemem", state=state)

    assert query.startswith("build release automation fix edge case codemem")
    assert "first.py second.py" in query


def test_track_hook_session_state_captures_prompt_and_modified_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("CODEMEM_CLAUDE_HOOK_CONTEXT_DIR", str(tmp_path))

    _track_hook_session_state(
        {
            "hook_event_name": "UserPromptSubmit",
            "session_id": "sess-ctx",
            "prompt": "ship parity",
        }
    )
    state = _track_hook_session_state(
        {
            "hook_event_name": "PostToolUse",
            "session_id": "sess-ctx",
            "tool_name": "Edit",
            "tool_input": {"filePath": "/repo/src/feature.py"},
        }
    )

    assert state is not None
    assert state["first_prompt"] == "ship parity"
    assert state["last_prompt"] == "ship parity"
    assert "/repo/src/feature.py" in state["files_modified"]


def test_track_hook_session_state_ignores_read_only_tool_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("CODEMEM_CLAUDE_HOOK_CONTEXT_DIR", str(tmp_path))

    _track_hook_session_state(
        {
            "hook_event_name": "UserPromptSubmit",
            "session_id": "sess-read",
            "prompt": "inspect code",
        }
    )
    state = _track_hook_session_state(
        {
            "hook_event_name": "PostToolUse",
            "session_id": "sess-read",
            "tool_name": "Read",
            "tool_input": {"filePath": "/repo/src/just-read.py"},
        }
    )

    assert state is not None
    assert state["files_modified"] == []


def test_track_hook_session_state_clears_on_session_end(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("CODEMEM_CLAUDE_HOOK_CONTEXT_DIR", str(tmp_path))
    _track_hook_session_state(
        {
            "hook_event_name": "UserPromptSubmit",
            "session_id": "sess-end",
            "prompt": "ship parity",
        }
    )

    _track_hook_session_state(
        {
            "hook_event_name": "SessionEnd",
            "session_id": "sess-end",
        }
    )

    assert list(tmp_path.glob("*.json")) == []


def test_claude_hook_ingest_cmd_fallback_uses_flush_default_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {
        "hook_event_name": "SessionEnd",
        "session_id": "sess-fallback",
        "cwd": "/tmp/worktrees/codemem",
    }
    calls: list[bool] = []

    @contextmanager
    def _fake_lock():
        yield SimpleNamespace(lock_ttl_s=300)

    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
    monkeypatch.setattr("codemem.commands.claude_hook_runtime_cmds._http_enqueue", lambda _: False)
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._run_cli_ingest_payload",
        lambda _payload, *, flush_default: calls.append(flush_default) or True,
    )
    monkeypatch.setattr("codemem.commands.claude_hook_runtime_cmds._acquire_lock", _fake_lock)
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._recover_stale_tmp_spool", lambda _: None
    )
    monkeypatch.setattr("codemem.commands.claude_hook_runtime_cmds._drain_spool", lambda: None)

    claude_hook_ingest_cmd()

    assert calls == [True]


def test_claude_hook_ingest_cmd_force_boundary_flush_after_http_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {
        "hook_event_name": "SessionEnd",
        "session_id": "sess-http",
        "cwd": "/tmp/worktrees/codemem",
    }
    calls: list[bool] = []

    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
    monkeypatch.setattr("codemem.commands.claude_hook_runtime_cmds._http_enqueue", lambda _: True)
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._run_cli_ingest_payload",
        lambda _payload, *, flush_default: calls.append(flush_default) or True,
    )

    claude_hook_ingest_cmd()

    assert calls == [True]


def test_claude_hook_ingest_cmd_allows_disabling_session_end_flush(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {
        "hook_event_name": "SessionEnd",
        "session_id": "sess-http-no-flush",
        "cwd": "/tmp/worktrees/codemem",
    }
    calls: list[bool] = []

    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
    monkeypatch.setattr("codemem.commands.claude_hook_runtime_cmds._http_enqueue", lambda _: True)
    monkeypatch.setattr(
        "codemem.commands.claude_hook_runtime_cmds._run_cli_ingest_payload",
        lambda _payload, *, flush_default: calls.append(flush_default) or True,
    )
    monkeypatch.setenv("CODEMEM_CLAUDE_HOOK_FLUSH", "0")

    claude_hook_ingest_cmd()

    assert calls == []


def test_user_prompt_hook_script_does_not_wait_for_ingest(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    source_script = repo_root / "plugins" / "claude" / "scripts" / "user-prompt-hook.sh"
    wrapper = tmp_path / "user-prompt-hook.sh"
    shutil.copy2(source_script, wrapper)
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)

    ingest = tmp_path / "ingest-hook.sh"
    ingest.write_text("#!/usr/bin/env bash\nsleep 2\nexit 0\n", encoding="utf-8")
    ingest.chmod(0o755)

    inject = tmp_path / "inject-context-hook.sh"
    inject.write_text(
        "#!/usr/bin/env bash\n"
        'printf \'%s\\n\' \'{"continue":true,"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"ok"}}\'\n',
        encoding="utf-8",
    )
    inject.chmod(0o755)

    payload = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-latency",
        "prompt": "check latency",
        "cwd": "/tmp/worktrees/codemem",
    }

    start = time.monotonic()
    proc = subprocess.run(
        ["bash", str(wrapper)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
    )
    elapsed = time.monotonic() - start

    assert proc.returncode == 0
    output = json.loads(proc.stdout)
    assert output["continue"] is True
    assert output["hookSpecificOutput"]["additionalContext"] == "ok"
    assert elapsed < 1.2
