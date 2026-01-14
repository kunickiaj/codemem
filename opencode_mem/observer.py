from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from typing import Optional

from .config import load_config
from .observer_prompts import ObserverContext, build_observer_prompt
from .xml_parser import ParsedOutput, parse_observer_output


DEFAULT_OPENAI_MODEL = "gpt-5.1-codex-mini"
DEFAULT_ANTHROPIC_MODEL = "claude-4.5-haiku"


@dataclass
class ObserverResponse:
    raw: Optional[str]
    parsed: ParsedOutput


class ObserverClient:
    def __init__(self) -> None:
        cfg = load_config()
        provider = (cfg.observer_provider or "").lower()
        if not provider:
            if os.getenv("ANTHROPIC_API_KEY") and not os.getenv("OPENAI_API_KEY"):
                provider = "anthropic"
            else:
                provider = "openai"
        if provider not in {"openai", "anthropic"}:
            provider = "openai"
        self.provider = provider
        self.use_opencode_run = cfg.use_opencode_run
        self.opencode_model = cfg.opencode_model
        self.opencode_agent = cfg.opencode_agent
        self.model = cfg.observer_model or (
            DEFAULT_ANTHROPIC_MODEL if provider == "anthropic" else DEFAULT_OPENAI_MODEL
        )
        self.api_key = cfg.observer_api_key or os.getenv(
            "OPENCODE_MEM_OBSERVER_API_KEY"
        )
        self.max_chars = cfg.observer_max_chars
        self.client: object | None = None
        if self.use_opencode_run:
            return
        if provider == "anthropic":
            if not self.api_key:
                self.api_key = os.getenv("ANTHROPIC_API_KEY")
            if not self.api_key:
                return
            try:
                import anthropic  # type: ignore

                self.client = anthropic.Anthropic(api_key=self.api_key)
            except Exception:  # pragma: no cover
                self.client = None
        else:
            if not self.api_key:
                self.api_key = (
                    os.getenv("OPENCODE_API_KEY")
                    or os.getenv("OPENAI_API_KEY")
                    or os.getenv("CODEX_API_KEY")
                )
            if not self.api_key:
                return
            try:
                from openai import OpenAI  # type: ignore

                self.client = OpenAI(api_key=self.api_key)
            except Exception:  # pragma: no cover
                self.client = None

    def observe(self, context: ObserverContext) -> ObserverResponse:
        prompt = build_observer_prompt(context)
        if self.max_chars > 0 and len(prompt) > self.max_chars:
            prompt = prompt[: self.max_chars]
        raw = self._call(prompt)
        parsed = parse_observer_output(raw or "")
        return ObserverResponse(raw=raw, parsed=parsed)

    def _call(self, prompt: str) -> Optional[str]:
        if self.use_opencode_run:
            return self._call_opencode_run(prompt)
        if not self.client:
            return None
        try:
            if self.provider == "anthropic":
                resp = self.client.completions.create(
                    model=self.model,
                    prompt=f"\nHuman: {prompt}\nAssistant:",
                    temperature=0,
                    max_tokens_to_sample=800,
                )
                return resp.completion
            resp = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "You are a memory observer."},
                    {"role": "user", "content": prompt},
                ],
                temperature=0,
                max_tokens=800,
            )
            return resp.choices[0].message.content
        except Exception:  # pragma: no cover
            return None

    def _call_opencode_run(self, prompt: str) -> Optional[str]:
        model = self.opencode_model or self.model
        cmd = ["opencode", "run", "--format", "json", "--model", model]
        if self.opencode_agent:
            cmd.extend(["--agent", self.opencode_agent])
        cmd.append(prompt)
        try:
            result = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                text=True,
                timeout=20,
            )
        except Exception:  # pragma: no cover
            return None
        if result.returncode != 0:
            return None
        return self._extract_opencode_text(result.stdout)

    def _extract_opencode_text(self, output: str) -> str:
        if not output:
            return ""
        lines = output.splitlines()
        parts: list[str] = []
        for line in lines:
            try:
                payload = json.loads(line)
            except Exception:
                continue
            if payload.get("type") == "text":
                part = payload.get("part") or {}
                text = part.get("text") if isinstance(part, dict) else None
                if text:
                    parts.append(text)
        if parts:
            return "\n".join(parts).strip()
        return output.strip()
