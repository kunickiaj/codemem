from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import textwrap
from dataclasses import dataclass

from .utils import redact

LOW_SIGNAL_PATTERNS: list[re.Pattern[str]] = [
    # Empty by default - trust the observer LLM to make nuanced decisions.
    # Add specific patterns here only if we observe actual noise getting through
    # that the observer consistently fails to filter.
    #
    # Previously had patterns like r"opencode" which caused false positives,
    # filtering legitimate technical content about OpenCode.
]
logger = logging.getLogger(__name__)


LOW_SIGNAL_OBSERVATION_PATTERNS: list[re.Pattern[str]] = [
    # Empty by default - trust the observer LLM.
    # Add patterns here only for content that consistently gets through
    # despite observer guidance. These catch low-signal session summaries
    # the observer regularly fails to suppress.
    re.compile(r"\bno\s+code\s+changes?\s+(?:were|was)\s+(?:recorded|made)\b", re.IGNORECASE),
    re.compile(r"\bno\s+code\s+was\s+modified\b", re.IGNORECASE),
    re.compile(
        r"\bno\s+new\s+(?:code|configuration|config|documentation)"
        r"(?:\s+or\s+(?:code|configuration|config|documentation))?\s+(?:was|were)\s+(?:shipped|delivered)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bno\s+new\s+deliverables?\b", re.IGNORECASE),
    re.compile(
        r"\bno\s+definitive\s+(?:code\s+rewrite|feature\s+delivery)"
        r"(?:\s+or\s+(?:code\s+rewrite|feature\s+delivery))?\s+(?:occurred|happened)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bonly\s+file\s+inspection\s+occurred\b", re.IGNORECASE),
    re.compile(r"\bonly\s+produced\s+(?:an?\s+)?understanding\b", re.IGNORECASE),
    re.compile(r"\bconsisted\s+entirely\s+of\s+capturing\b", re.IGNORECASE),
    re.compile(r"\bno\s+fully\s+resolved\s+deliverable\b", re.IGNORECASE),
    re.compile(r"\beffort\s+focused\s+on\s+clarifying\b", re.IGNORECASE),
    re.compile(
        r"\bno\s+code\s*,?\s+configuration\s*,?\s+or\s+documentation\s+changes?\s+(?:were|was)\s+made\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bwork\s+consisted\s+entirely\s+of\s+capturing\s+the\s+current\s+state\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bprimary\s+user\s+request\s+details\s+were\s+absent\b", re.IGNORECASE),
]


@dataclass
class Summary:
    session_summary: str
    observations: list[str]
    entities: list[str]


class _LLMClient:
    def __init__(self, model: str, api_key: str, base_url: str | None) -> None:
        try:
            from openai import OpenAI
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("openai package is required for model summaries") from exc
        self.model = model
        self.client = OpenAI(api_key=api_key, base_url=base_url)

    def summarize(
        self, transcript: str, diff_summary: str, recent_files: str, max_obs: int
    ) -> Summary:
        prompt = (
            "Summarize the following terminal session for a developer journal. "
            "Include a concise session summary, up to {max_obs} short observations, "
            "and any notable entities (names of services, components, or domains). "
            "Return JSON with keys: session_summary (string), observations (list of strings), "
            "entities (list of strings).\n"
            "Diff summary:\n{diff}\nRecent files:\n{files}\nTranscript:\n{transcript}"
        ).format(
            max_obs=max_obs,
            diff=diff_summary or "n/a",
            files=recent_files or "n/a",
            transcript=transcript[:6000],
        )
        resp = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {
                    "role": "system",
                    "content": "You are a concise assistant for session journaling.",
                },
                {"role": "user", "content": prompt},
            ],
            max_tokens=320,
            temperature=0,
        )
        content = resp.choices[0].message.content or ""
        try:
            data = json.loads(content)
        except Exception:
            data = {
                "session_summary": content.strip() or "Session summary unavailable",
                "observations": [],
                "entities": [],
            }
        if not isinstance(data, dict):
            data = {
                "session_summary": content.strip() or "Session summary unavailable",
                "observations": [],
                "entities": [],
            }
        return Summary(
            session_summary=str(data.get("session_summary", "")).strip()
            or "Session summary unavailable",
            observations=list(data.get("observations", []))[:max_obs],
            entities=list(data.get("entities", []))[:max_obs],
        )


class Summarizer:
    def __init__(self, max_observations: int = 5, force_heuristic: bool = False) -> None:
        self.max_observations = max_observations
        self.force_heuristic = force_heuristic
        from .config import load_config

        cfg = load_config()
        self.use_opencode_run = cfg.use_opencode_run
        self.opencode_model = cfg.opencode_model
        self.opencode_agent = cfg.opencode_agent
        model = os.getenv("CODEMEM_SUMMARY_MODEL")
        api_key = (
            os.getenv("CODEMEM_SUMMARY_API_KEY")
            or os.getenv("OPENCODE_API_KEY")
            or os.getenv("OPENAI_API_KEY")
        )
        base_url = (
            os.getenv("CODEMEM_SUMMARY_BASE_URL")
            or os.getenv("OPENCODE_API_BASE")
            or os.getenv("OPENAI_BASE_URL")
        )
        self.llm: _LLMClient | None = None
        if (not force_heuristic) and model and api_key:
            try:
                self.llm = _LLMClient(model=model, api_key=api_key, base_url=base_url)
            except Exception:
                self.llm = None

    def summarize(self, transcript: str, diff_summary: str, recent_files: str) -> Summary:
        transcript = redact(transcript)
        diff_summary = redact(diff_summary)
        filtered_lines = self._filter_transcript_lines(transcript)
        filtered_transcript = "\n".join(filtered_lines) if filtered_lines else transcript
        heuristic = self._heuristic_summary(filtered_transcript, diff_summary, recent_files)
        if not self.force_heuristic and self.use_opencode_run:
            summary = self._summarize_with_opencode_run(
                filtered_transcript, diff_summary, recent_files
            )
            if summary:
                return self._filter_summary_observations(summary)
        if not self.force_heuristic and self.llm:
            try:
                summary = self.llm.summarize(
                    filtered_transcript,
                    diff_summary,
                    recent_files,
                    self.max_observations,
                )
                return self._filter_summary_observations(summary)
            except Exception:
                return self._filter_summary_observations(heuristic)
        return self._filter_summary_observations(heuristic)

    def _build_summary_prompt(self, transcript: str, diff_summary: str, recent_files: str) -> str:
        return (
            "Summarize the following terminal session for a developer journal. "
            "Include a concise session summary, up to {max_obs} short observations, "
            "and any notable entities (names of services, components, or domains). "
            "Return JSON with keys: session_summary (string), observations (list of strings), "
            "entities (list of strings).\n"
            "Diff summary:\n{diff}\nRecent files:\n{files}\nTranscript:\n{transcript}"
        ).format(
            max_obs=self.max_observations,
            diff=diff_summary or "n/a",
            files=recent_files or "n/a",
            transcript=transcript[:6000],
        )

    def _parse_summary_payload(self, content: str) -> Summary:
        try:
            data = json.loads(content)
        except Exception:
            data = {
                "session_summary": content.strip() or "Session summary unavailable",
                "observations": [],
                "entities": [],
            }
        if not isinstance(data, dict):
            data = {
                "session_summary": content.strip() or "Session summary unavailable",
                "observations": [],
                "entities": [],
            }
        return Summary(
            session_summary=str(data.get("session_summary", "")).strip()
            or "Session summary unavailable",
            observations=list(data.get("observations", []))[: self.max_observations],
            entities=list(data.get("entities", []))[: self.max_observations],
        )

    def _summarize_with_opencode_run(
        self, transcript: str, diff_summary: str, recent_files: str
    ) -> Summary | None:
        prompt = self._build_summary_prompt(transcript, diff_summary, recent_files)
        text = self._call_opencode_run(prompt)
        if not text:
            return None
        return self._parse_summary_payload(text)

    def _call_opencode_run(self, prompt: str) -> str | None:
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
        except Exception as exc:  # pragma: no cover
            logger.exception("summarizer opencode run failed", exc_info=exc)
            return None
        if result.returncode != 0:
            logger.warning(
                "summarizer opencode run returned non-zero",
                extra={"returncode": result.returncode},
            )
            return None
        text = self._extract_opencode_text(result.stdout)
        return text or None

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

    def _filter_transcript_lines(self, transcript: str) -> list[str]:
        lines: list[str] = []
        for raw in transcript.splitlines():
            line = raw.strip()
            if not line:
                continue
            if not re.search(r"[A-Za-z0-9]", line):
                continue
            if any(pattern.search(line) for pattern in LOW_SIGNAL_PATTERNS):
                continue
            lines.append(line)
        return lines

    def _filter_summary_observations(self, summary: Summary) -> Summary:
        observations = [obs for obs in summary.observations if not is_low_signal_observation(obs)]
        return Summary(
            session_summary=summary.session_summary,
            observations=observations[: self.max_observations],
            entities=summary.entities,
        )

    def _format_diff_summary(self, diff_summary: str) -> str:
        lines = [line.strip() for line in diff_summary.splitlines() if line.strip()]
        if not lines:
            return ""
        limit = 8
        if len(lines) > limit:
            lines = lines[:limit] + [f"... (+{len(lines) - limit} more)"]
        return "; ".join(lines)

    def _format_recent_files(self, recent_files: str) -> str:
        files = [line.strip() for line in recent_files.splitlines() if line.strip()]
        if not files:
            return ""
        limit = 5
        if len(files) > limit:
            files = files[:limit] + [f"... (+{len(files) - limit} more)"]
        return ", ".join(files)

    def _heuristic_summary(self, transcript: str, diff_summary: str, recent_files: str) -> Summary:
        lines = self._filter_transcript_lines(transcript)
        if len(lines) > 200:
            head = lines[:50]
            tail = lines[-150:]
            lines = head + tail

        notes: list[str] = []
        diff_text = self._format_diff_summary(diff_summary)
        if diff_text:
            notes.append(f"Code changes: {diff_text}")
        files_text = self._format_recent_files(recent_files)
        if files_text:
            notes.append(f"Touched files: {files_text}")

        transcript_lines = lines
        important = transcript_lines[: self.max_observations]
        observations = (notes + important)[: self.max_observations]
        session_summary = textwrap.shorten(" ".join(transcript_lines), width=480, placeholder="...")
        entities = self._extract_entities(transcript_lines)
        return Summary(
            session_summary=session_summary,
            observations=observations,
            entities=entities,
        )

    def _extract_entities(self, lines: list[str]) -> list[str]:
        entities: list[str] = []
        for line in lines:
            if "service" in line.lower() and len(entities) < self.max_observations:
                entities.append(line)
            if "component" in line.lower() and len(entities) < self.max_observations:
                entities.append(line)
        return entities


def normalize_observation(text: str) -> str:
    cleaned = re.sub(r"^[\s\-\u2022\u2514\u203a>$]+", "", text.strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def is_low_signal_observation(text: str) -> bool:
    normalized = normalize_observation(text)
    if not normalized:
        return True
    if any(pattern.search(normalized) for pattern in LOW_SIGNAL_PATTERNS):
        return True
    return bool(any(pattern.search(normalized) for pattern in LOW_SIGNAL_OBSERVATION_PATTERNS))
