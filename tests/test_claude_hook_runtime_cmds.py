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

from codemem.commands.claude_hook_runtime_cmds import claude_hook_ingest_cmd, claude_hook_inject_cmd


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
        *, prompt: str, project: str | None, limit: int, token_budget: int
    ) -> str:
        captured["prompt"] = prompt
        captured["project"] = project
        captured["limit"] = limit
        captured["token_budget"] = token_budget
        return "Remember to run targeted tests."

    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
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
    monkeypatch.setenv("CODEMEM_CLAUDE_HOOK_FLUSH", "1")

    claude_hook_ingest_cmd()

    assert calls == [False]


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
