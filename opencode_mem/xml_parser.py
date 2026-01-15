from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from xml.etree import ElementTree

OBSERVATION_BLOCK_RE = re.compile(r"<observation>.*?</observation>", re.DOTALL)
SUMMARY_BLOCK_RE = re.compile(r"<summary>.*?</summary>", re.DOTALL)
SKIP_SUMMARY_RE = re.compile(
    r"<skip_summary(?:\s+reason=\"(?P<reason>[^\"]+)\")?\s*/>",
    re.IGNORECASE,
)
CODE_FENCE_RE = re.compile(r"```(?:xml)?", re.IGNORECASE)


@dataclass
class ParsedObservation:
    kind: str
    title: str
    narrative: str
    subtitle: str | None
    facts: list[str]
    concepts: list[str]
    files_read: list[str]
    files_modified: list[str]


@dataclass
class ParsedSummary:
    request: str
    investigated: str
    learned: str
    completed: str
    next_steps: str
    notes: str
    files_read: list[str]
    files_modified: list[str]


@dataclass
class ParsedOutput:
    observations: list[ParsedObservation]
    summary: ParsedSummary | None
    skip_summary_reason: str | None


def _clean_xml_text(text: str) -> str:
    cleaned = CODE_FENCE_RE.sub("", text)
    return cleaned.strip()


def _extract_blocks(pattern: re.Pattern[str], text: str) -> list[str]:
    return [block.strip() for block in pattern.findall(text)]


def _text(node: ElementTree.Element | None) -> str:
    if node is None or node.text is None:
        return ""
    return node.text.strip()


def _child_texts(parent: ElementTree.Element | None, tag: str) -> list[str]:
    if parent is None:
        return []
    items = []
    for child in parent.findall(tag):
        value = _text(child)
        if value:
            items.append(value)
    return items


def _parse_observation_block(block: str) -> ParsedObservation | None:
    try:
        root = ElementTree.fromstring(block)
    except ElementTree.ParseError:
        return None
    kind = _text(root.find("type"))
    title = _text(root.find("title"))
    subtitle = _text(root.find("subtitle")) or None
    narrative = _text(root.find("narrative"))
    facts = _child_texts(root.find("facts"), "fact")
    concepts = _child_texts(root.find("concepts"), "concept")
    files_read = _child_texts(root.find("files_read"), "file")
    files_modified = _child_texts(root.find("files_modified"), "file")
    return ParsedObservation(
        kind=kind,
        title=title,
        narrative=narrative,
        subtitle=subtitle,
        facts=facts,
        concepts=concepts,
        files_read=files_read,
        files_modified=files_modified,
    )


def _parse_summary_block(block: str) -> ParsedSummary | None:
    try:
        root = ElementTree.fromstring(block)
    except ElementTree.ParseError:
        return None
    return ParsedSummary(
        request=_text(root.find("request")),
        investigated=_text(root.find("investigated")),
        learned=_text(root.find("learned")),
        completed=_text(root.find("completed")),
        next_steps=_text(root.find("next_steps")),
        notes=_text(root.find("notes")),
        files_read=_child_texts(root.find("files_read"), "file"),
        files_modified=_child_texts(root.find("files_modified"), "file"),
    )


def parse_observer_output(text: str) -> ParsedOutput:
    cleaned = _clean_xml_text(text)
    observations: list[ParsedObservation] = []
    for block in _extract_blocks(OBSERVATION_BLOCK_RE, cleaned):
        parsed = _parse_observation_block(block)
        if parsed:
            observations.append(parsed)
    summary: ParsedSummary | None = None
    summary_blocks = _extract_blocks(SUMMARY_BLOCK_RE, cleaned)
    if summary_blocks:
        summary = _parse_summary_block(summary_blocks[-1])
    skip_match = SKIP_SUMMARY_RE.search(cleaned)
    skip_reason = skip_match.group("reason") if skip_match else None
    return ParsedOutput(
        observations=observations,
        summary=summary,
        skip_summary_reason=skip_reason,
    )


def has_meaningful_observation(observations: Iterable[ParsedObservation]) -> bool:
    for obs in observations:
        if obs.title or obs.narrative:
            return True
    return False
