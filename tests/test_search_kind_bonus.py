from __future__ import annotations

import pytest

from codemem.memory_kinds import ALLOWED_MEMORY_KINDS, MEMORY_KIND_BONUS
from codemem.store.search import _kind_bonus


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
