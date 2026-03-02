from __future__ import annotations

import pytest

from codemem.memory_kinds import ALLOWED_MEMORY_KINDS, MEMORY_KIND_BONUS
from codemem.store.search import _kind_bonus, _rerank_results, _rerank_results_hybrid
from codemem.store.types import MemoryResult


def _memory_result(memory_id: int, kind: str, score: float = 1.0) -> MemoryResult:
    timestamp = "2026-01-01T00:00:00+00:00"
    return MemoryResult(
        id=memory_id,
        kind=kind,
        title=f"{kind} title",
        body_text=f"{kind} body",
        confidence=0.7,
        created_at=timestamp,
        updated_at=timestamp,
        tags_text="",
        score=score,
        session_id=1,
        metadata={},
    )


def test_memory_kind_bonus_covers_all_allowed_kinds() -> None:
    assert set(MEMORY_KIND_BONUS) == set(ALLOWED_MEMORY_KINDS)


@pytest.mark.parametrize(
    ("kind", "expected"),
    [
        ("session_summary", 0.25),
        ("decision", 0.2),
        ("feature", 0.18),
        ("bugfix", 0.18),
        ("refactor", 0.17),
        ("note", 0.15),
        ("change", 0.12),
        ("discovery", 0.12),
        ("observation", 0.1),
        ("exploration", 0.1),
        ("entities", 0.05),
    ],
)
def test_kind_bonus_returns_expected_weight(kind: str, expected: float) -> None:
    assert _kind_bonus(kind) == expected


def test_kind_bonus_defaults_to_zero_for_unknown_or_missing_kind() -> None:
    assert _kind_bonus("unknown") == 0.0
    assert _kind_bonus(None) == 0.0


def test_kind_bonus_normalizes_mixed_case_and_whitespace() -> None:
    assert _kind_bonus(" Decision ") == 0.2


def test_rerank_results_prefers_higher_kind_bonus_when_base_scores_tie() -> None:
    higher_bonus = _memory_result(1, "decision")
    lower_bonus = _memory_result(2, "entities")

    ranked = _rerank_results([lower_bonus, higher_bonus], limit=2)

    assert [item.id for item in ranked] == [1, 2]


def test_rerank_results_hybrid_prefers_higher_kind_bonus_when_other_signals_tie() -> None:
    higher_bonus = _memory_result(1, "refactor")
    lower_bonus = _memory_result(2, "observation")

    ranked = _rerank_results_hybrid(
        [lower_bonus, higher_bonus],
        limit=2,
        semantic_ids=set(),
    )

    assert [item.id for item in ranked] == [1, 2]
