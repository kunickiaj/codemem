import json
import sqlite3
from pathlib import Path

from typer.testing import CliRunner

from opencode_mem.cli import app
from opencode_mem.store import MemoryStore

runner = CliRunner()


def _create_claude_db(tmp_path: Path) -> Path:
    claude_db = tmp_path / "claude-mem.db"
    claude_conn = sqlite3.connect(claude_db)

    claude_conn.execute(
        """
        CREATE TABLE sdk_sessions (
            id INTEGER PRIMARY KEY,
            content_session_id TEXT UNIQUE NOT NULL,
            memory_session_id TEXT UNIQUE,
            project TEXT NOT NULL,
            started_at TEXT NOT NULL,
            started_at_epoch INTEGER NOT NULL
        )
        """
    )

    claude_conn.execute(
        """
        CREATE TABLE observations (
            id INTEGER PRIMARY KEY,
            memory_session_id TEXT NOT NULL,
            project TEXT NOT NULL,
            type TEXT NOT NULL,
            title TEXT,
            subtitle TEXT,
            facts TEXT,
            narrative TEXT,
            concepts TEXT,
            files_read TEXT,
            files_modified TEXT,
            prompt_number INTEGER,
            created_at TEXT NOT NULL,
            created_at_epoch INTEGER NOT NULL,
            discovery_tokens INTEGER,
            text TEXT
        )
        """
    )

    claude_conn.execute(
        """
        CREATE TABLE session_summaries (
            id INTEGER PRIMARY KEY,
            memory_session_id TEXT NOT NULL,
            project TEXT NOT NULL,
            request TEXT,
            investigated TEXT,
            learned TEXT,
            completed TEXT,
            next_steps TEXT,
            notes TEXT,
            files_read TEXT,
            files_edited TEXT,
            prompt_number INTEGER,
            created_at TEXT NOT NULL,
            created_at_epoch INTEGER NOT NULL,
            discovery_tokens INTEGER
        )
        """
    )

    claude_conn.execute(
        """
        CREATE TABLE user_prompts (
            id INTEGER PRIMARY KEY,
            content_session_id TEXT NOT NULL,
            prompt_number INTEGER NOT NULL,
            prompt_text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            created_at_epoch INTEGER NOT NULL
        )
        """
    )

    claude_conn.execute(
        """
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            "session-1",
            "mem-session-1",
            "test-project",
            "2024-01-01T00:00:00Z",
            1704067200000,
        ),
    )

    claude_conn.execute(
        """
        INSERT INTO observations (
            memory_session_id, project, type, title, subtitle, facts, narrative,
            concepts, files_read, files_modified, prompt_number, created_at, created_at_epoch, discovery_tokens, text
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "mem-session-1",
            "test-project",
            "discovery",
            "Test observation",
            "Test subtitle",
            json.dumps(["fact1", "fact2"]),
            "This is a test narrative",
            json.dumps(["concept1"]),
            json.dumps(["file1.py"]),
            json.dumps(["file2.py"]),
            1,
            "2024-01-01T00:00:00Z",
            1704067200000,
            1234,
            None,
        ),
    )

    claude_conn.execute(
        """
        INSERT INTO session_summaries (
            memory_session_id, project, request, investigated, learned, completed,
            next_steps, notes, files_read, files_edited, prompt_number, created_at, created_at_epoch, discovery_tokens
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "mem-session-1",
            "test-project",
            "Test request",
            "Test investigated",
            "Test learned",
            "Test completed",
            "Test next steps",
            "Test notes",
            json.dumps(["read1.py"]),
            json.dumps(["edit1.py"]),
            1,
            "2024-01-01T00:00:00Z",
            1704067200000,
            2222,
        ),
    )

    claude_conn.execute(
        """
        INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
        """,
        ("session-1", 1, "Test prompt", "2024-01-01T00:00:00Z", 1704067200000),
    )

    claude_conn.commit()
    claude_conn.close()
    return claude_db


def test_import_from_claude_mem(tmp_path: Path) -> None:
    """Test importing from a mock claude-mem database."""
    claude_db = _create_claude_db(tmp_path)

    # Import into opencode-mem
    opencode_db = tmp_path / "opencode-mem.db"
    store = MemoryStore(opencode_db)

    # Simulate import command logic
    import_session = store.start_session(
        cwd="/tmp",
        project="test-project",
        git_remote=None,
        git_branch=None,
        user="test-user",
        tool_version="import-claude-mem",
        metadata={"source": "claude-mem"},
    )

    # Read and import observations
    claude_conn = sqlite3.connect(claude_db)
    claude_conn.row_factory = sqlite3.Row

    obs_count = 0
    for row in claude_conn.execute("SELECT * FROM observations"):
        store.remember_observation(
            import_session,
            kind=row["type"],
            title=row["title"] or "Untitled",
            narrative=row["narrative"] or row["text"] or "",
            subtitle=row["subtitle"],
            facts=json.loads(row["facts"]) if row["facts"] else None,
            concepts=json.loads(row["concepts"]) if row["concepts"] else None,
            files_read=json.loads(row["files_read"]) if row["files_read"] else None,
            files_modified=json.loads(row["files_modified"]) if row["files_modified"] else None,
            prompt_number=row["prompt_number"],
            confidence=0.7,
            metadata={
                "source": "claude-mem",
                "original_session_id": row["memory_session_id"],
            },
        )
        obs_count += 1

    # Read and import summaries
    summary_count = 0
    for row in claude_conn.execute("SELECT * FROM session_summaries"):
        store.add_session_summary(
            import_session,
            project=row["project"],
            request=row["request"] or "",
            investigated=row["investigated"] or "",
            learned=row["learned"] or "",
            completed=row["completed"] or "",
            next_steps=row["next_steps"] or "",
            notes=row["notes"] or "",
            files_read=json.loads(row["files_read"]) if row["files_read"] else None,
            files_edited=json.loads(row["files_edited"]) if row["files_edited"] else None,
            prompt_number=row["prompt_number"],
            metadata={"source": "claude-mem"},
        )
        summary_count += 1

    # Read and import prompts
    prompt_count = 0
    for row in claude_conn.execute(
        "SELECT p.*, s.project FROM user_prompts p LEFT JOIN sdk_sessions s ON s.content_session_id = p.content_session_id"
    ):
        store.add_user_prompt(
            import_session,
            project=row["project"],
            prompt_text=row["prompt_text"],
            prompt_number=row["prompt_number"],
            metadata={"source": "claude-mem"},
        )
        prompt_count += 1

    claude_conn.close()
    store.end_session(import_session, metadata={"imported": True})

    # Verify imports
    assert obs_count == 1, "Should import 1 observation"
    assert summary_count == 1, "Should import 1 summary"
    assert prompt_count == 1, "Should import 1 prompt"

    # Verify data in opencode-mem
    memories = store.recent(limit=10)
    assert len(memories) >= 1, "Should have at least 1 memory"

    obs_memory = [m for m in memories if m["kind"] == "discovery"]
    assert len(obs_memory) == 1, "Should have 1 discovery observation"
    assert obs_memory[0]["title"] == "Test observation"


def test_import_from_claude_mem_idempotent(tmp_path: Path) -> None:
    claude_db = _create_claude_db(tmp_path)
    opencode_db = tmp_path / "opencode-mem.db"

    result1 = runner.invoke(
        app, ["import-from-claude-mem", str(claude_db), "--db-path", str(opencode_db)]
    )
    assert result1.exit_code == 0, result1.output
    result2 = runner.invoke(
        app, ["import-from-claude-mem", str(claude_db), "--db-path", str(opencode_db)]
    )
    assert result2.exit_code == 0, result2.output

    store = MemoryStore(opencode_db)
    assert store.conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1
    assert store.conn.execute("SELECT COUNT(*) FROM memory_items").fetchone()[0] == 2
    assert store.conn.execute("SELECT COUNT(*) FROM session_summaries").fetchone()[0] == 1
    assert store.conn.execute("SELECT COUNT(*) FROM user_prompts").fetchone()[0] == 1
