from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from typing import Any, Iterable, List, Optional


@dataclass
class TypedMemory:
    category: str
    title: str
    narrative: str
    subtitle: Optional[str] = None
    facts: list[str] | None = None
    concepts: list[str] | None = None
    files_read: list[str] | None = None
    files_modified: list[str] | None = None
    confidence: float = 0.5
    metadata: Optional[dict[str, Any]] = None


DEFAULT_OPENAI_MODEL = os.getenv("OPENCODE_MEM_OBSERVATION_MODEL", "gpt-5.1-codex-mini")
DEFAULT_ANTHROPIC_MODEL = "claude-4.5-haiku"


class ObservationClassifier:
    def __init__(self) -> None:
        provider = os.getenv("OPENCODE_MEM_OBSERVATION_PROVIDER", "openai").lower()
        self.provider = "anthropic" if provider == "anthropic" else "openai"
        self.model = (
            DEFAULT_ANTHROPIC_MODEL
            if self.provider == "anthropic"
            else DEFAULT_OPENAI_MODEL
        )
        self.client: Any = None
        self.api_key = os.getenv("OPENCODE_MEM_OBSERVATION_API_KEY")
        from .config import load_config

        cfg = load_config()
        self.use_opencode_run = cfg.use_opencode_run
        self.opencode_model = cfg.opencode_model
        self.opencode_agent = cfg.opencode_agent
        self.fallback_heuristic = cfg.classifier_fallback_heuristic
        self.classifier_max_chars = cfg.classifier_max_chars
        if self.provider == "anthropic":
            if not self.api_key:
                self.api_key = os.getenv("ANTHROPIC_API_KEY")
            if not self.api_key:
                self.client = None
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
                self.client = None
                return
            try:
                from openai import OpenAI  # type: ignore

                self.client = OpenAI(api_key=self.api_key)
            except Exception:  # pragma: no cover
                self.client = None

    def available(self) -> bool:
        return self.client is not None

    def classify(
        self,
        transcript: str,
        summary: Any,
        events: Iterable[dict[str, Any]] | None = None,
        context: Optional[dict[str, str]] = None,
    ) -> List[TypedMemory]:
        payload = self._build_payload(transcript, summary, events, context)
        payload = self._truncate_prompt(payload)
        if self.use_opencode_run:
            text = self._call_opencode_run(payload)
        elif self.available():
            text = self._call_model(payload)
        else:
            text = None
        if not text:
            return self._heuristic_classify(summary) if self.fallback_heuristic else []
        memories = self._parse_response(text)
        if not memories:
            return self._heuristic_classify(summary) if self.fallback_heuristic else []
        return memories

    def _build_payload(
        self,
        transcript: str,
        summary: Any,
        events: Iterable[dict[str, Any]] | None,
        context: Optional[dict[str, str]],
    ) -> str:
        obs = summary.observations if hasattr(summary, "observations") else []
        obs_text = "\n".join(obs[:5])
        diff_summary = ""
        recent_files = ""
        tool_events = ""
        if context:
            diff_summary = context.get("diff_summary", "")
            recent_files = context.get("recent_files", "")
            tool_events = context.get("tool_events", "")
        prompt_parts = [
            "You are a memory curator. Produce high-signal developer memories.",
            "Return JSON array. Each item includes: type, title, subtitle, facts, narrative, concepts, files_read, files_modified, confidence.",
            "Allowed types: discovery, change, feature, bugfix, refactor, decision.",
            "Use short subtitles and factual bullet-style strings in facts.",
            "Keep narratives to 1-3 sentences, concrete and specific.",
            'Leave fields empty ("" or []) when unavailable.',
            "Avoid low-signal tool logs, line numbers, and raw file dumps.",
            "Session summary:",
            summary.session_summary if hasattr(summary, "session_summary") else "",
            "Key observations:",
            obs_text,
            "Diff summary:",
            diff_summary,
            "Recent files:",
            recent_files,
            "Recent tool events:",
            tool_events,
        ]
        return "\n".join(part for part in prompt_parts if part)

    def _call_model(self, prompt: str) -> Optional[str]:
        try:
            if self.provider == "anthropic" and self.client:
                resp = self.client.completions.create(
                    model=self.model,
                    prompt=f"\nHuman: {prompt}\nAssistant:",
                    temperature=0,
                    max_tokens=400,
                )
                return resp.completion
            if self.client:
                resp = self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": "You categorize memories."},
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0,
                    max_tokens=400,
                )
                return resp.choices[0].message.content
        except Exception:  # pragma: no cover
            return None
        return None

    def _truncate_prompt(self, prompt: str) -> str:
        if self.classifier_max_chars <= 0:
            return prompt
        if len(prompt) <= self.classifier_max_chars:
            return prompt
        return prompt[: self.classifier_max_chars]

    def _call_opencode_run(self, prompt: str) -> Optional[str]:
        cmd = ["opencode", "run", "--format", "json", "--model", self.opencode_model]
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
        text = self._extract_opencode_text(result.stdout)
        return text or None

    def _extract_opencode_text(self, output: str) -> str:
        if not output:
            return ""
        lines = output.splitlines()
        parts: List[str] = []
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

    def _parse_response(self, text: str) -> List[TypedMemory]:
        try:
            data = json.loads(text)
        except Exception:  # pragma: no cover
            return []
        if not isinstance(data, list):
            return []
        results: List[TypedMemory] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            category = item.get("category") or item.get("type")
            if not category or category not in {
                "discovery",
                "change",
                "feature",
                "bugfix",
                "refactor",
                "decision",
            }:
                continue
            title = (
                item.get("title")
                or item.get("narrative", "").strip().splitlines()[0][:80]
                or item.get("body", "").strip().splitlines()[0][:80]
            )
            narrative = (
                item.get("narrative") or item.get("body") or item.get("text") or ""
            )
            subtitle = item.get("subtitle")
            facts = item.get("facts") or []
            concepts = item.get("concepts") or []
            files_read = item.get("files_read") or []
            files_modified = item.get("files_modified") or []
            confidence = float(item.get("confidence", 0.5))
            metadata = item.get("metadata")
            results.append(
                TypedMemory(
                    category=category,
                    title=title,
                    narrative=narrative,
                    subtitle=subtitle,
                    facts=list(facts) if isinstance(facts, list) else [],
                    concepts=list(concepts) if isinstance(concepts, list) else [],
                    files_read=list(files_read) if isinstance(files_read, list) else [],
                    files_modified=list(files_modified)
                    if isinstance(files_modified, list)
                    else [],
                    confidence=confidence,
                    metadata=metadata,
                )
            )
        return results

    def _heuristic_classify(self, summary: Any) -> List[TypedMemory]:
        observations = summary.observations if hasattr(summary, "observations") else []
        results: List[TypedMemory] = []
        for obs in observations[:6]:
            category = self._detect_category(obs)
            title = obs[:80]
            results.append(
                TypedMemory(
                    category=category, title=title, narrative=obs, confidence=0.35
                )
            )
        return results

    def _detect_category(self, text: str) -> str:
        lower = text.lower()
        if any(
            keyword in lower
            for keyword in ["decision", "decid", "choose", "option", "plan"]
        ):
            return "decision"
        if any(
            keyword in lower for keyword in ["bug", "fix", "error", "failure", "crash"]
        ):
            return "bugfix"
        if any(
            keyword in lower
            for keyword in ["refactor", "cleanup", "simplif", "restruct"]
        ):
            return "refactor"
        if any(
            keyword in lower for keyword in ["feature", "add", "implement", "introduc"]
        ):
            return "feature"
        if any(
            keyword in lower for keyword in ["change", "update", "migrat", "rename"]
        ):
            return "change"
        return "discovery"
