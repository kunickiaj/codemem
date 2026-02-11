from __future__ import annotations

import re


def normalize_tag(value: str, *, stopwords: set[str] | None = None) -> str:
    lowered = (value or "").strip().lower()
    if not lowered:
        return ""
    lowered = re.sub(r"[^a-z0-9_]+", "-", lowered)
    lowered = re.sub(r"-+", "-", lowered).strip("-")
    if not lowered:
        return ""
    if stopwords and lowered in stopwords:
        return ""
    if len(lowered) > 40:
        lowered = lowered[:40].rstrip("-")
    return lowered


def file_tags(path_value: str, *, stopwords: set[str] | None = None) -> list[str]:
    raw = (path_value or "").strip()
    if not raw:
        return []
    parts = re.split(r"[\\/]+", raw)
    parts = [part for part in parts if part and part not in {".", ".."}]
    if not parts:
        return []
    tags: list[str] = []
    basename = normalize_tag(parts[-1], stopwords=stopwords)
    if basename:
        tags.append(basename)
    if len(parts) >= 2:
        parent = normalize_tag(parts[-2], stopwords=stopwords)
        if parent:
            tags.append(parent)
    if len(parts) >= 3:
        top = normalize_tag(parts[0], stopwords=stopwords)
        if top:
            tags.append(top)
    return tags


def derive_tags(
    *,
    kind: str,
    title: str = "",
    concepts: list[str] | None = None,
    files_read: list[str] | None = None,
    files_modified: list[str] | None = None,
    stopwords: set[str] | None = None,
) -> list[str]:
    tags: list[str] = []
    kind_tag = normalize_tag(kind, stopwords=stopwords)
    if kind_tag:
        tags.append(kind_tag)
    for concept in concepts or []:
        normalized = normalize_tag(concept, stopwords=stopwords)
        if normalized:
            tags.append(normalized)
    for path_value in (files_read or []) + (files_modified or []):
        tags.extend(file_tags(path_value, stopwords=stopwords))

    if not tags and title:
        for token in re.findall(r"[A-Za-z0-9_]+", title.lower()):
            normalized = normalize_tag(token, stopwords=stopwords)
            if normalized:
                tags.append(normalized)

    deduped: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        if tag in seen:
            continue
        seen.add(tag)
        deduped.append(tag)
        if len(deduped) >= 20:
            break
    return deduped
