from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Iterable

import sqlite_vec


class _FastEmbedClient:
    def __init__(self, model: str) -> None:
        try:
            from fastembed import TextEmbedding
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("fastembed is required for semantic search") from exc
        self.model = model
        self._embedder = TextEmbedding(model_name=model)

    def embed(self, texts: Iterable[str]) -> list[list[float]]:
        embeddings = self._embedder.embed(texts)
        return [list(vec) for vec in embeddings]


_CLIENT: _FastEmbedClient | None = None


def get_embedding_client() -> _FastEmbedClient | None:
    global _CLIENT
    if _CLIENT is not None:
        return _CLIENT
    if os.getenv("OPENCODE_MEM_EMBEDDING_DISABLED", "").lower() in {"1", "true", "yes"}:
        return None
    model = os.getenv("OPENCODE_MEM_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
    try:
        _CLIENT = _FastEmbedClient(model=model)
    except Exception:
        _CLIENT = None
    return _CLIENT


def embed_texts(texts: Iterable[str]) -> list[bytes]:
    client = get_embedding_client()
    if not client:
        return []
    embeddings = client.embed(texts)
    return [sqlite_vec.serialize_float32(list(vector)) for vector in embeddings]


def chunk_text(text: str, max_chars: int = 1200) -> list[str]:
    cleaned = text.strip()
    if not cleaned:
        return []
    if len(cleaned) <= max_chars:
        return [cleaned]
    paragraphs = [p.strip() for p in re.split(r"\n{2,}", cleaned) if p.strip()]
    chunks: list[str] = []
    buffer: list[str] = []
    buffer_len = 0
    for paragraph in paragraphs:
        if buffer_len + len(paragraph) + 2 <= max_chars:
            buffer.append(paragraph)
            buffer_len += len(paragraph) + 2
            continue
        if buffer:
            chunks.append("\n\n".join(buffer))
            buffer = []
            buffer_len = 0
        if len(paragraph) <= max_chars:
            chunks.append(paragraph)
            continue
        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", paragraph) if s.strip()]
        sentence_buffer: list[str] = []
        sentence_len = 0
        for sentence in sentences:
            if sentence_len + len(sentence) + 1 <= max_chars:
                sentence_buffer.append(sentence)
                sentence_len += len(sentence) + 1
                continue
            if sentence_buffer:
                chunks.append(" ".join(sentence_buffer))
            sentence_buffer = [sentence]
            sentence_len = len(sentence)
        if sentence_buffer:
            chunks.append(" ".join(sentence_buffer))
    if buffer:
        chunks.append("\n\n".join(buffer))
    return chunks


def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
