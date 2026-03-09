from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from codemem.cli import app
from codemem.store import MemoryStore

runner = CliRunner()


def test_db_size_report_shows_core_sections(tmp_path: Path) -> None:
    db_path = tmp_path / "mem.sqlite"
    store = MemoryStore(db_path)
    try:
        session_id = store.start_session(
            cwd=str(tmp_path),
            git_remote=None,
            git_branch=None,
            user="tester",
            tool_version="test",
            project="codemem",
        )
        store.remember(session_id, kind="note", title="Alpha", body_text="Body")
    finally:
        store.close()

    result = runner.invoke(app, ["db", "size-report", "--db-path", str(db_path), "--limit", "5"])
    assert result.exit_code == 0
    assert "Database size report" in result.stdout
    assert "File size:" in result.stdout
    assert "Largest tables / indexes" in result.stdout
    assert "Selected row counts" in result.stdout
    assert "memory_items:" in result.stdout
