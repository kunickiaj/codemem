from __future__ import annotations

from pathlib import Path

from codemem.store import MemoryStore


def test_search_widens_into_shared_results_when_personal_results_are_weak(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    personal_id = store.remember(session, kind="note", title="Alpha", body_text="Local alpha")
    shared_id = store.remember(
        session,
        kind="note",
        title="Alpha",
        body_text="Shared alpha",
        metadata={
            "actor_id": "actor:teammate",
            "actor_display_name": "Teammate",
            "workspace_id": "shared:team-alpha",
            "workspace_kind": "shared",
            "visibility": "shared",
        },
    )
    store.end_session(session)

    results, widening = store.search_with_diagnostics(
        "alpha",
        limit=1,
        filters={"project": "/tmp/project-a", "widen_shared_when_weak": True},
    )

    assert [item.id for item in results] == [personal_id, shared_id]
    assert results[0].metadata["widened_from_shared"] is False
    assert results[1].metadata["widened_from_shared"] is True
    assert widening["widening_applied"] is True
    assert widening["personal_result_count"] == 1
    assert widening["shared_result_count"] == 1


def test_search_does_not_widen_for_explicitly_personal_query(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    personal_id = store.remember(session, kind="note", title="My notes", body_text="Local alpha")
    store.remember(
        session,
        kind="note",
        title="My notes",
        body_text="Shared alpha",
        metadata={
            "actor_id": "actor:teammate",
            "actor_display_name": "Teammate",
            "workspace_id": "shared:team-alpha",
            "workspace_kind": "shared",
            "visibility": "shared",
        },
    )
    store.end_session(session)

    results, widening = store.search_with_diagnostics(
        "my notes",
        limit=1,
        filters={"project": "/tmp/project-a", "widen_shared_when_weak": True},
    )

    assert [item.id for item in results] == [personal_id]
    assert widening["widening_applied"] is False


def test_search_soft_trust_bias_prefers_trusted_shared_memory(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    trusted_id = store.remember(
        session,
        kind="note",
        title="Shared auth flow",
        body_text="Trusted shared details",
        metadata={
            "actor_id": "actor:trusted",
            "actor_display_name": "Trusted teammate",
            "workspace_id": "shared:team-alpha",
            "workspace_kind": "shared",
            "visibility": "shared",
            "trust_state": "trusted",
        },
    )
    legacy_id = store.remember(
        session,
        kind="note",
        title="Shared auth flow",
        body_text="Legacy shared details",
        metadata={
            "actor_id": "actor:legacy",
            "actor_display_name": "Legacy teammate",
            "workspace_id": "shared:team-alpha",
            "workspace_kind": "shared",
            "visibility": "shared",
            "trust_state": "legacy_unknown",
        },
    )
    store.end_session(session)
    store.conn.execute(
        "UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?",
        ("2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00", trusted_id),
    )
    store.conn.execute(
        "UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?",
        ("2026-01-02T00:00:00+00:00", "2026-01-02T00:00:00+00:00", legacy_id),
    )
    store.conn.commit()

    baseline = store.search(
        "shared auth flow",
        limit=2,
        filters={"project": "/tmp/project-a", "personal_first": False, "trust_bias": "off"},
    )
    trust_biased = store.search(
        "shared auth flow",
        limit=2,
        filters={"project": "/tmp/project-a", "personal_first": False, "trust_bias": "soft"},
    )

    assert [item.id for item in baseline] == [legacy_id, trusted_id]
    assert [item.id for item in trust_biased] == [trusted_id, legacy_id]


def test_search_soft_trust_bias_does_not_penalize_local_actor_memory(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    local_id = store.remember(
        session,
        kind="note",
        title="Auth summary",
        body_text="Local memory",
        metadata={"trust_state": "legacy_unknown"},
    )
    shared_id = store.remember(
        session,
        kind="note",
        title="Auth summary",
        body_text="Trusted teammate memory",
        metadata={
            "actor_id": "actor:trusted",
            "actor_display_name": "Trusted teammate",
            "workspace_id": "shared:team-alpha",
            "workspace_kind": "shared",
            "visibility": "shared",
            "trust_state": "trusted",
        },
    )
    store.end_session(session)

    results = store.search(
        "auth summary",
        limit=2,
        filters={"project": "/tmp/project-a", "trust_bias": "soft"},
    )

    assert [item.id for item in results] == [local_id, shared_id]


def test_search_soft_trust_bias_applies_with_working_set_hint(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "mem.sqlite")
    session = store.start_session(
        cwd="/tmp",
        git_remote=None,
        git_branch="main",
        user="tester",
        tool_version="test",
        project="/tmp/project-a",
    )
    trusted_id = store.remember_observation(
        session,
        kind="note",
        title="Auth service",
        narrative="Trusted details",
        files_modified=["src/auth/service.py"],
        metadata={
            "actor_id": "actor:trusted",
            "actor_display_name": "Trusted teammate",
            "workspace_id": "shared:team-alpha",
            "workspace_kind": "shared",
            "visibility": "shared",
            "trust_state": "trusted",
        },
    )
    legacy_id = store.remember_observation(
        session,
        kind="note",
        title="Auth service",
        narrative="Legacy details",
        files_modified=["src/auth/service.py"],
        metadata={
            "actor_id": "actor:legacy",
            "actor_display_name": "Legacy teammate",
            "workspace_id": "shared:team-alpha",
            "workspace_kind": "shared",
            "visibility": "shared",
            "trust_state": "legacy_unknown",
        },
    )
    store.end_session(session)
    store.conn.execute(
        "UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?",
        ("2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00", trusted_id),
    )
    store.conn.execute(
        "UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?",
        ("2026-01-02T00:00:00+00:00", "2026-01-02T00:00:00+00:00", legacy_id),
    )
    store.conn.commit()

    results = store.search(
        "auth service",
        limit=2,
        filters={
            "project": "/tmp/project-a",
            "personal_first": False,
            "trust_bias": "soft",
            "working_set_paths": ["src/auth/service.py"],
        },
    )

    assert [item.id for item in results] == [trusted_id, legacy_id]
