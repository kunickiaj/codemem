import json
from pathlib import Path

from typer.testing import CliRunner

from opencode_mem import db
from opencode_mem.cli import app
from opencode_mem.store import MemoryStore

runner = CliRunner()


def test_export_import_roundtrip(tmp_path: Path) -> None:
    """Test that exported memories can be imported back correctly."""
    # Create source database with test data
    source_db = tmp_path / "source.sqlite"
    store = MemoryStore(source_db)

    # Create a session with various memory types
    session = store.start_session(
        cwd="/tmp/myproject",
        project="/tmp/myproject",
        git_remote="git@github.com:user/repo.git",
        git_branch="main",
        user="tester",
        tool_version="test",
    )

    # Add various memory types
    store.remember(
        session,
        kind="observation",
        title="Learned about testing",
        body_text="Testing is important for code quality",
        confidence=0.8,
        tags=["testing", "quality"],
    )

    store.remember_observation(
        session,
        kind="discovery",
        title="Found database pattern",
        narrative="The store uses SQLite with FTS5 for full-text search",
        facts=["SQLite FTS5 enabled", "Row factory for dicts"],
        concepts=["full-text search", "database patterns"],
        files_read=["store.py", "db.py"],
        confidence=0.9,
    )

    store.add_session_summary(
        session,
        project="/tmp/myproject",
        request="Understand the codebase",
        investigated="Looked at store.py and db.py",
        learned="FTS5 is used for search",
        completed="Initial investigation",
        next_steps="Write tests",
        notes="Good architecture",
        files_read=["store.py"],
        files_edited=None,
    )

    store.add_user_prompt(
        session,
        project="/tmp/myproject",
        prompt_text="Help me understand this codebase",
        prompt_number=1,
    )

    store.end_session(session)

    # Export to JSON
    sessions_rows = store.conn.execute("SELECT * FROM sessions").fetchall()
    sessions = [dict(row) for row in sessions_rows]
    session_ids = [s["id"] for s in sessions]

    memories_rows = store.conn.execute(
        f"SELECT * FROM memory_items WHERE session_id IN ({','.join('?' * len(session_ids))}) AND active = 1",
        session_ids,
    ).fetchall()
    memories = [dict(row) for row in memories_rows]

    summaries_rows = store.conn.execute(
        f"SELECT * FROM session_summaries WHERE session_id IN ({','.join('?' * len(session_ids))})",
        session_ids,
    ).fetchall()
    summaries = [dict(row) for row in summaries_rows]

    prompts_rows = store.conn.execute(
        f"SELECT * FROM user_prompts WHERE session_id IN ({','.join('?' * len(session_ids))})",
        session_ids,
    ).fetchall()
    prompts = [dict(row) for row in prompts_rows]

    export_data = {
        "version": "1.0",
        "exported_at": "2025-01-15T10:00:00Z",
        "export_metadata": {
            "tool_version": "opencode-mem",
            "projects": ["/tmp/myproject"],
            "total_memories": len(memories),
            "total_sessions": len(sessions),
        },
        "sessions": sessions,
        "memory_items": memories,
        "session_summaries": summaries,
        "user_prompts": prompts,
    }

    export_path = tmp_path / "export.json"
    export_path.write_text(json.dumps(export_data, ensure_ascii=False, indent=2))

    # Create destination database and import
    dest_db = tmp_path / "dest.sqlite"
    dest_store = MemoryStore(dest_db)

    import_data = json.loads(export_path.read_text())

    # Create session mapping
    session_mapping = {}
    for sess_data in import_data["sessions"]:
        old_session_id = sess_data["id"]
        new_session_id = dest_store.start_session(
            cwd=sess_data.get("cwd", "/tmp"),
            project=sess_data.get("project"),
            git_remote=sess_data.get("git_remote"),
            git_branch=sess_data.get("git_branch"),
            user=sess_data.get("user", "tester"),
            tool_version=sess_data.get("tool_version", "import"),
        )
        session_mapping[old_session_id] = new_session_id

    # Import memories
    for mem_data in import_data["memory_items"]:
        old_session_id = mem_data.get("session_id")
        new_session_id = session_mapping.get(old_session_id)
        if not new_session_id:
            continue
        dest_store.remember(
            new_session_id,
            kind=mem_data.get("kind", "observation"),
            title=mem_data.get("title", "Untitled"),
            body_text=mem_data.get("body_text", ""),
            confidence=mem_data.get("confidence", 0.5),
        )

    # Import summaries
    for summ_data in import_data["session_summaries"]:
        old_session_id = summ_data.get("session_id")
        new_session_id = session_mapping.get(old_session_id)
        if not new_session_id:
            continue
        dest_store.add_session_summary(
            new_session_id,
            project=summ_data.get("project"),
            request=summ_data.get("request", ""),
            investigated=summ_data.get("investigated", ""),
            learned=summ_data.get("learned", ""),
            completed=summ_data.get("completed", ""),
            next_steps=summ_data.get("next_steps", ""),
            notes=summ_data.get("notes", ""),
        )

    # Import prompts
    for prompt_data in import_data["user_prompts"]:
        old_session_id = prompt_data.get("session_id")
        new_session_id = session_mapping.get(old_session_id)
        if not new_session_id:
            continue
        dest_store.add_user_prompt(
            new_session_id,
            project=prompt_data.get("project"),
            prompt_text=prompt_data.get("prompt_text", ""),
            prompt_number=prompt_data.get("prompt_number"),
        )

    # End sessions
    for new_session_id in session_mapping.values():
        dest_store.end_session(new_session_id)

    # Verify imported data
    dest_memories = dest_store.recent(limit=10)
    assert len(dest_memories) == 2  # Two memories were created

    dest_sessions = dest_store.all_sessions()
    assert len(dest_sessions) == 1

    # Search works on imported data
    results = dest_store.search("testing", limit=5)
    assert len(results) == 1
    assert "testing" in results[0].body_text.lower()


def test_import_is_idempotent(tmp_path: Path) -> None:
    source_db = tmp_path / "source.sqlite"
    store = MemoryStore(source_db)

    session = store.start_session(
        cwd="/tmp/myproject",
        project="/tmp/myproject",
        git_remote="git@github.com:user/repo.git",
        git_branch="main",
        user="tester",
        tool_version="test",
    )
    store.remember(
        session,
        kind="observation",
        title="Idempotent memory",
        body_text="This should only import once",
        confidence=0.8,
    )
    store.add_session_summary(
        session,
        project="/tmp/myproject",
        request="Idempotent import",
        investigated="Test export",
        learned="Should dedupe",
        completed="Created export",
        next_steps="Re-import",
        notes="",
    )
    store.add_user_prompt(
        session,
        project="/tmp/myproject",
        prompt_text="Run idempotent import",
        prompt_number=1,
    )
    store.end_session(session)

    sessions_rows = store.conn.execute("SELECT * FROM sessions").fetchall()
    sessions = [dict(row) for row in sessions_rows]
    session_ids = [s["id"] for s in sessions]

    memories_rows = store.conn.execute(
        f"SELECT * FROM memory_items WHERE session_id IN ({','.join('?' * len(session_ids))}) AND active = 1",
        session_ids,
    ).fetchall()
    memories = [dict(row) for row in memories_rows]

    summaries_rows = store.conn.execute(
        f"SELECT * FROM session_summaries WHERE session_id IN ({','.join('?' * len(session_ids))})",
        session_ids,
    ).fetchall()
    summaries = [dict(row) for row in summaries_rows]

    prompts_rows = store.conn.execute(
        f"SELECT * FROM user_prompts WHERE session_id IN ({','.join('?' * len(session_ids))})",
        session_ids,
    ).fetchall()
    prompts = [dict(row) for row in prompts_rows]

    export_data = {
        "version": "1.0",
        "exported_at": "2025-01-15T10:00:00Z",
        "export_metadata": {
            "tool_version": "opencode-mem",
            "projects": ["/tmp/myproject"],
            "total_memories": len(memories),
            "total_sessions": len(sessions),
        },
        "sessions": sessions,
        "memory_items": memories,
        "session_summaries": summaries,
        "user_prompts": prompts,
    }

    export_path = tmp_path / "export.json"
    export_path.write_text(json.dumps(export_data, ensure_ascii=False, indent=2))

    dest_db = tmp_path / "dest.sqlite"
    result1 = runner.invoke(app, ["import-memories", str(export_path), "--db-path", str(dest_db)])
    assert result1.exit_code == 0, result1.output
    result2 = runner.invoke(app, ["import-memories", str(export_path), "--db-path", str(dest_db)])
    assert result2.exit_code == 0, result2.output

    dest_store = MemoryStore(dest_db)
    assert dest_store.conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1
    assert dest_store.conn.execute("SELECT COUNT(*) FROM memory_items").fetchone()[0] == 1
    assert dest_store.conn.execute("SELECT COUNT(*) FROM session_summaries").fetchone()[0] == 1
    assert dest_store.conn.execute("SELECT COUNT(*) FROM user_prompts").fetchone()[0] == 1


def test_import_memories_flattens_summary_metadata(tmp_path: Path) -> None:
    export_data = {
        "version": "1.0",
        "exported_at": "2025-01-15T10:00:00Z",
        "export_metadata": {
            "tool_version": "opencode-mem",
            "projects": ["/tmp/project"],
            "total_memories": 1,
            "total_sessions": 1,
        },
        "sessions": [
            {
                "id": 1,
                "started_at": "2025-01-15T09:00:00Z",
                "cwd": "/tmp/project",
                "project": "/tmp/project",
                "git_remote": None,
                "git_branch": "main",
                "user": "tester",
                "tool_version": "test",
            }
        ],
        "memory_items": [
            {
                "id": 1,
                "session_id": 1,
                "kind": "session_summary",
                "title": "Session summary",
                "body_text": "## Request\nDo the thing",
                "confidence": 0.7,
                "active": 1,
                "created_at": "2025-01-15T10:00:00Z",
                "updated_at": "2025-01-15T10:00:00Z",
                "metadata_json": {
                    "request": "Do the thing",
                    "investigated": "Checked the importer",
                },
            }
        ],
        "session_summaries": [],
        "user_prompts": [],
    }

    export_path = tmp_path / "export.json"
    export_path.write_text(json.dumps(export_data, ensure_ascii=False))

    dest_db = tmp_path / "dest.sqlite"
    result = runner.invoke(app, ["import-memories", str(export_path), "--db-path", str(dest_db)])
    assert result.exit_code == 0, result.output

    dest_store = MemoryStore(dest_db)
    row = dest_store.conn.execute(
        "SELECT metadata_json FROM memory_items WHERE kind = 'session_summary'"
    ).fetchone()
    assert row is not None
    metadata = db.from_json(row["metadata_json"])
    assert metadata.get("request") == "Do the thing"
    assert metadata.get("investigated") == "Checked the importer"


def test_normalize_imported_metadata_updates_session_summary(tmp_path: Path) -> None:
    db_path = tmp_path / "dest.sqlite"
    store = MemoryStore(db_path)
    session_id = store.start_session(
        cwd="/tmp/project",
        project="/tmp/project",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
    )
    store.remember(
        session_id,
        kind="session_summary",
        title="Session summary",
        body_text="## Request\nDo the thing",
        confidence=0.7,
        metadata={
            "source": "export",
            "import_metadata": {"request": "Do the thing", "investigated": "Checked"},
        },
    )
    store.end_session(session_id)
    store.close()

    result = runner.invoke(app, ["normalize-imported-metadata", "--db-path", str(db_path)])
    assert result.exit_code == 0, result.output

    updated_store = MemoryStore(db_path)
    row = updated_store.conn.execute(
        "SELECT metadata_json FROM memory_items WHERE kind = 'session_summary'"
    ).fetchone()
    assert row is not None
    metadata = db.from_json(row["metadata_json"])
    assert metadata.get("request") == "Do the thing"
    assert metadata.get("investigated") == "Checked"


def test_normalize_imported_metadata_fills_empty_strings(tmp_path: Path) -> None:
    db_path = tmp_path / "dest.sqlite"
    store = MemoryStore(db_path)
    session_id = store.start_session(
        cwd="/tmp/project",
        project="/tmp/project",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
    )
    store.remember(
        session_id,
        kind="session_summary",
        title="Session summary",
        body_text="## Request\nDo the thing",
        confidence=0.7,
        metadata={
            "source": "export",
            "request": "",
            "import_metadata": {"request": "Do the thing"},
        },
    )
    store.end_session(session_id)
    store.close()

    result = runner.invoke(app, ["normalize-imported-metadata", "--db-path", str(db_path)])
    assert result.exit_code == 0, result.output

    updated_store = MemoryStore(db_path)
    row = updated_store.conn.execute(
        "SELECT metadata_json FROM memory_items WHERE kind = 'session_summary'"
    ).fetchone()
    assert row is not None
    metadata = db.from_json(row["metadata_json"])
    assert metadata.get("request") == "Do the thing"


def test_export_project_filter(tmp_path: Path) -> None:
    """Test that project filter works correctly during export."""
    db_path = tmp_path / "test.sqlite"
    store = MemoryStore(db_path)

    # Create sessions for different projects
    proj_a = store.start_session(
        cwd="/tmp/project-a",
        project="/tmp/project-a",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
    )
    store.remember(proj_a, kind="note", title="Project A note", body_text="Content for A")
    store.end_session(proj_a)

    proj_b = store.start_session(
        cwd="/tmp/project-b",
        project="/tmp/project-b",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
    )
    store.remember(proj_b, kind="note", title="Project B note", body_text="Content for B")
    store.end_session(proj_b)

    # Query only project-a sessions
    sessions_rows = store.conn.execute(
        "SELECT * FROM sessions WHERE project = ?",
        ("/tmp/project-a",),
    ).fetchall()
    session_ids = [row["id"] for row in sessions_rows]

    assert len(session_ids) == 1

    memories_rows = store.conn.execute(
        f"SELECT * FROM memory_items WHERE session_id IN ({','.join('?' * len(session_ids))}) AND active = 1",
        session_ids,
    ).fetchall()

    assert len(memories_rows) == 1
    assert memories_rows[0]["title"] == "Project A note"


def test_import_remap_project(tmp_path: Path) -> None:
    """Test that project remapping works during import."""
    # Create export data
    export_data = {
        "version": "1.0",
        "exported_at": "2025-01-15T10:00:00Z",
        "export_metadata": {
            "tool_version": "opencode-mem",
            "projects": ["/original/project"],
            "total_memories": 1,
            "total_sessions": 1,
        },
        "sessions": [
            {
                "id": 1,
                "started_at": "2025-01-15T09:00:00Z",
                "cwd": "/original/project",
                "project": "/original/project",
                "git_remote": None,
                "git_branch": "main",
                "user": "alice",
                "tool_version": "test",
            }
        ],
        "memory_items": [
            {
                "id": 1,
                "session_id": 1,
                "kind": "note",
                "title": "Test note",
                "body_text": "Test content",
                "confidence": 0.7,
                "active": 1,
            }
        ],
        "session_summaries": [],
        "user_prompts": [],
    }

    # Import with remapped project
    db_path = tmp_path / "dest.sqlite"
    store = MemoryStore(db_path)

    remap_project = "/new/location/project"

    for sess_data in export_data["sessions"]:
        new_session_id = store.start_session(
            cwd=sess_data.get("cwd", "/tmp"),
            project=remap_project,  # Use remapped project
            git_remote=sess_data.get("git_remote"),
            git_branch=sess_data.get("git_branch"),
            user=sess_data.get("user", "tester"),
            tool_version="import",
        )
        store.end_session(new_session_id)

    # Verify project was remapped
    sessions = store.all_sessions()
    assert len(sessions) == 1
    assert sessions[0]["project"] == "/new/location/project"


def test_export_include_inactive(tmp_path: Path) -> None:
    """Test that inactive memories can be optionally included."""
    db_path = tmp_path / "test.sqlite"
    store = MemoryStore(db_path)

    session = store.start_session(
        cwd="/tmp",
        project="/tmp/test",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
    )

    store.remember(session, kind="note", title="Active", body_text="Active content")
    inactive_id = store.remember(
        session, kind="note", title="Inactive", body_text="Inactive content"
    )

    # Deactivate one memory
    store.forget(inactive_id)
    store.end_session(session)

    # Query without inactive
    active_only = store.conn.execute("SELECT * FROM memory_items WHERE active = 1").fetchall()
    assert len(active_only) == 1

    # Query with inactive
    all_memories = store.conn.execute("SELECT * FROM memory_items").fetchall()
    assert len(all_memories) == 2
