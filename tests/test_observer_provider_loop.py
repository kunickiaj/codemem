from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from types import SimpleNamespace

import pytest

from codemem.config import OpencodeMemConfig
from codemem.observer import ObserverClient


@dataclass(frozen=True)
class Scenario:
    name: str
    behavior: str
    expected_text: str | None
    expected_status: str


SCENARIOS = (
    Scenario(
        name="success",
        behavior="success",
        expected_text="hello from adapter",
        expected_status="success",
    ),
    Scenario(
        name="backend-error",
        behavior="raises",
        expected_text=None,
        expected_status="failed",
    ),
    Scenario(
        name="malformed-response",
        behavior="malformed",
        expected_text=None,
        expected_status="failed",
    ),
)


def _target_providers() -> list[str]:
    selected = (os.getenv("CODEMEM_TEST_PROVIDER") or "").strip().lower()
    if selected in {"openai", "anthropic"}:
        return [selected]
    return ["openai", "anthropic"]


def _selected_provider() -> str | None:
    selected = (os.getenv("CODEMEM_TEST_PROVIDER") or "").strip().lower()
    if selected in {"openai", "anthropic"}:
        return selected
    return None


def _make_openai_backend(behavior: str, attempts: list[str]) -> SimpleNamespace:
    class OpenAIChatCompletions:
        def create(self, **_kwargs):
            attempts.append("attempt")
            if behavior == "raises":
                raise RuntimeError("openai failed")
            if behavior == "malformed":
                return SimpleNamespace(choices=[])
            message = SimpleNamespace(content="hello from adapter")
            choice = SimpleNamespace(message=message)
            return SimpleNamespace(choices=[choice])

    return SimpleNamespace(chat=SimpleNamespace(completions=OpenAIChatCompletions()))


def _make_anthropic_backend(behavior: str, attempts: list[str]) -> SimpleNamespace:
    class AnthropicCompletions:
        def create(self, **_kwargs):
            attempts.append("attempt")
            if behavior == "raises":
                raise RuntimeError("anthropic failed")
            if behavior == "malformed":
                return SimpleNamespace()
            return SimpleNamespace(completion="hello from adapter")

    return SimpleNamespace(completions=AnthropicCompletions())


def _run_scenario(provider: str, scenario: Scenario) -> dict[str, object]:
    attempts: list[str] = []

    if provider == "openai":

        class OpenAIStub:
            def __init__(self, **_kwargs: object) -> None:
                self.chat = _make_openai_backend(scenario.behavior, attempts).chat

        module_map = {"openai": SimpleNamespace(OpenAI=OpenAIStub)}
        cfg = OpencodeMemConfig(
            observer_provider="openai",
            observer_api_key="stub-key",
            observer_model="gpt-5.1-codex-mini",
        )
    else:

        class AnthropicStub:
            def __init__(self, **_kwargs: object) -> None:
                self.completions = _make_anthropic_backend(scenario.behavior, attempts).completions

        module_map = {"anthropic": SimpleNamespace(Anthropic=AnthropicStub)}
        cfg = OpencodeMemConfig(
            observer_provider="anthropic",
            observer_api_key="stub-key",
            observer_model="claude-4.5-haiku",
        )

    from unittest.mock import patch

    with (
        patch("codemem.observer.load_config", return_value=cfg),
        patch("codemem.observer._load_opencode_oauth_cache", return_value={}),
        patch.dict(sys.modules, module_map),
    ):
        client = ObserverClient()
        output = client._call("hello")
    status = "success" if output else "failed"
    return {"output": output, "status": status, "attempts": len(attempts)}


@pytest.mark.parametrize("provider", _target_providers())
@pytest.mark.parametrize("scenario", SCENARIOS, ids=[s.name for s in SCENARIOS])
def test_provider_loop_scenarios_match_expected(provider: str, scenario: Scenario) -> None:
    result = _run_scenario(provider, scenario)
    assert result["output"] == scenario.expected_text
    assert result["status"] == scenario.expected_status
    assert result["attempts"] == 1


@pytest.mark.parametrize("scenario", SCENARIOS, ids=[s.name for s in SCENARIOS])
def test_provider_loop_semantics_equivalent_across_adapters(scenario: Scenario) -> None:
    if _selected_provider() is not None:
        pytest.skip("cross-adapter equivalence runs only when CODEMEM_TEST_PROVIDER is unset")
    openai_result = _run_scenario("openai", scenario)
    anthropic_result = _run_scenario("anthropic", scenario)
    assert openai_result["output"] == anthropic_result["output"]
    assert openai_result["status"] == anthropic_result["status"]
    assert openai_result["attempts"] == anthropic_result["attempts"]
