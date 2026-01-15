from __future__ import annotations

import os
from collections.abc import Iterable


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
