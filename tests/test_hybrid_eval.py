from __future__ import annotations

from pathlib import Path

import pytest
import typer

from codemem.commands.maintenance_cmds import hybrid_eval_cmd
from codemem.hybrid_eval import read_judged_queries, run_hybrid_eval


def test_read_judged_queries_parses_jsonl() -> None:
    rows = read_judged_queries(
        """
        # comment
        {"query": "alpha", "relevant_ids": [1, 2], "filters": {"project": "p"}}
        {"query": "beta", "relevant_ids": [3]}
        """
    )
    assert len(rows) == 2
    assert rows[0]["query"] == "alpha"
    assert rows[0]["relevant_ids"] == [1, 2]
    assert rows[0]["filters"] == {"project": "p"}


def test_read_judged_queries_requires_query() -> None:
    with pytest.raises(ValueError):
        read_judged_queries('{"relevant_ids": [1]}')


def test_read_judged_queries_requires_relevant_ids_array() -> None:
    with pytest.raises(ValueError, match="'relevant_ids' must be an array"):
        read_judged_queries('{"query": "alpha", "relevant_ids": "123"}')


def test_read_judged_queries_rejects_duplicate_rows() -> None:
    with pytest.raises(ValueError, match="duplicate judged query row"):
        read_judged_queries(
            """
            {"query": "alpha", "relevant_ids": [1], "filters": {"project": "p"}}
            {"query": "alpha", "relevant_ids": [1], "filters": {"project": "p"}}
            """
        )


def test_read_judged_queries_rejects_duplicate_rows_with_permuted_relevant_ids() -> None:
    with pytest.raises(ValueError, match="duplicate judged query row"):
        read_judged_queries(
            """
            {"query": "alpha", "relevant_ids": [1, 2], "filters": {"project": "p"}}
            {"query": "alpha", "relevant_ids": [2, 1], "filters": {"project": "p"}}
            """
        )


def test_run_hybrid_eval_computes_delta_and_restores_flags() -> None:
    class FakeStore:
        def __init__(self) -> None:
            self._hybrid_retrieval_enabled = False
            self._hybrid_retrieval_shadow_log = True

        def build_memory_pack(
            self, context, limit=8, token_budget=None, filters=None, log_usage=True
        ):
            if self._hybrid_retrieval_enabled:
                return {"items": [{"id": 1}, {"id": 7}]}
            return {"items": [{"id": 7}, {"id": 8}]}

    store = FakeStore()
    payload = run_hybrid_eval(
        store=store,  # type: ignore[arg-type]
        judged_queries=[{"query": "alpha", "relevant_ids": [1], "filters": None}],
        limit=2,
    )
    assert payload["summary"]["baseline"]["precision"] == 0.0
    assert payload["summary"]["hybrid"]["precision"] == 0.5
    assert payload["summary"]["delta"]["precision"] == 0.5
    assert payload["summary"]["delta"]["recall"] == 1.0
    assert store._hybrid_retrieval_enabled is False
    assert store._hybrid_retrieval_shadow_log is True


def test_read_judged_queries_requires_nonempty_dataset() -> None:
    with pytest.raises(ValueError, match="no judged queries"):
        read_judged_queries("# only comments\n\n")


def test_hybrid_eval_cmd_fails_when_threshold_not_met(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    class FakeStore:
        def __init__(self) -> None:
            self._hybrid_retrieval_enabled = False
            self._hybrid_retrieval_shadow_log = True

        def build_memory_pack(
            self, context, limit=8, token_budget=None, filters=None, log_usage=True
        ):
            if self._hybrid_retrieval_enabled:
                return {"items": [{"id": 1}, {"id": 7}]}
            return {"items": [{"id": 7}, {"id": 8}]}

        def close(self) -> None:
            return

    judged_path = tmp_path / "judged.jsonl"
    judged_path.write_text('{"query": "alpha", "relevant_ids": [1]}\n')

    with pytest.raises(typer.Exit) as exc:
        hybrid_eval_cmd(
            store_from_path=lambda _db: FakeStore(),
            db_path=None,
            judged_queries_path=judged_path,
            limit=2,
            json_out=None,
            min_delta_precision=0.75,
            min_delta_recall=None,
        )
    assert exc.value.exit_code == 1
    assert "threshold failed" in capsys.readouterr().out


def test_run_hybrid_eval_precision_uses_requested_k_denominator() -> None:
    class FakeStore:
        def __init__(self) -> None:
            self._hybrid_retrieval_enabled = False
            self._hybrid_retrieval_shadow_log = True

        def build_memory_pack(
            self, context, limit=8, token_budget=None, filters=None, log_usage=True
        ):
            if self._hybrid_retrieval_enabled:
                return {"items": [{"id": 1}]}
            return {"items": []}

    payload = run_hybrid_eval(
        store=FakeStore(),  # type: ignore[arg-type]
        judged_queries=[{"query": "alpha", "relevant_ids": [1], "filters": None}],
        limit=4,
    )

    assert payload["summary"]["hybrid"]["precision"] == 0.25
    assert payload["summary"]["hybrid"]["recall"] == 1.0


def test_run_hybrid_eval_deduplicates_hits_for_recall() -> None:
    class FakeStore:
        def __init__(self) -> None:
            self._hybrid_retrieval_enabled = False
            self._hybrid_retrieval_shadow_log = True

        def build_memory_pack(
            self, context, limit=8, token_budget=None, filters=None, log_usage=True
        ):
            if self._hybrid_retrieval_enabled:
                return {"items": [{"id": 1}, {"id": 1}]}
            return {"items": [{"id": 1}, {"id": 1}]}

    payload = run_hybrid_eval(
        store=FakeStore(),  # type: ignore[arg-type]
        judged_queries=[{"query": "alpha", "relevant_ids": [1], "filters": None}],
        limit=2,
    )

    assert payload["summary"]["baseline"]["recall"] == 1.0
    assert payload["summary"]["hybrid"]["recall"] == 1.0
