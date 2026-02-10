from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..semantic import chunk_text, embed_texts, get_embedding_client, hash_text

if TYPE_CHECKING:
    from ._store import MemoryStore


def backfill_vectors(
    store: MemoryStore,
    limit: int | None = None,
    since: str | None = None,
    project: str | None = None,
    active_only: bool = True,
    dry_run: bool = False,
    memory_ids: list[int] | None = None,
) -> dict[str, int]:
    client = get_embedding_client()
    if not client:
        return {"checked": 0, "embedded": 0, "inserted": 0, "skipped": 0}
    params: list[Any] = []
    where_clauses = []
    join_sessions = False
    if active_only:
        where_clauses.append("memory_items.active = 1")
    if since:
        where_clauses.append("memory_items.created_at >= ?")
        params.append(since)
    if project:
        clause, clause_params = store._project_clause(project)
        if clause:
            where_clauses.append(clause)
            params.extend(clause_params)
        join_sessions = True
    if memory_ids:
        placeholders = ",".join(["?"] * len(memory_ids))
        where_clauses.append(f"memory_items.id IN ({placeholders})")
        params.extend(int(memory_id) for memory_id in memory_ids)
    where = " AND ".join(where_clauses) if where_clauses else "1=1"
    join_clause = "JOIN sessions ON sessions.id = memory_items.session_id" if join_sessions else ""
    limit_clause = "LIMIT ?" if limit else ""
    if limit:
        params.append(limit)
    rows = store.conn.execute(
        f"""
        SELECT memory_items.id, memory_items.title, memory_items.body_text
        FROM memory_items
        {join_clause}
        WHERE {where}
        ORDER BY memory_items.created_at ASC
        {limit_clause}
        """,
        params,
    ).fetchall()
    checked = 0
    embedded = 0
    inserted = 0
    skipped = 0
    model = client.model
    for row in rows:
        checked += 1
        memory_id = int(row["id"])
        title = row["title"] or ""
        body_text = row["body_text"] or ""
        text = f"{title}\n{body_text}".strip()
        chunks = chunk_text(text)
        if not chunks:
            continue
        existing = store.conn.execute(
            """
            SELECT content_hash
            FROM memory_vectors
            WHERE memory_id = ? AND model = ?
            """,
            (memory_id, model),
        ).fetchall()
        existing_hashes = {row["content_hash"] for row in existing if row["content_hash"]}
        pending_chunks: list[str] = []
        pending_hashes: list[str] = []
        for chunk in chunks:
            content_hash = hash_text(chunk)
            if content_hash in existing_hashes:
                skipped += 1
                continue
            pending_chunks.append(chunk)
            pending_hashes.append(content_hash)
        if not pending_chunks:
            continue
        embeddings = embed_texts(pending_chunks)
        if not embeddings:
            continue
        embedded += len(embeddings)
        if dry_run:
            inserted += len(embeddings)
            continue
        for index, (vector, content_hash) in enumerate(
            zip(embeddings, pending_hashes, strict=False)
        ):
            store.conn.execute(
                """
                INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
                VALUES (?, ?, ?, ?, ?)
                """,
                (vector, memory_id, index, content_hash, model),
            )
            inserted += 1
    if not dry_run:
        store.conn.commit()
    return {
        "checked": checked,
        "embedded": embedded,
        "inserted": inserted,
        "skipped": skipped,
    }


def _store_vectors(store: MemoryStore, memory_id: int, title: str, body_text: str) -> None:
    client = get_embedding_client()
    if not client:
        return
    text = f"{title}\n{body_text}".strip()
    chunks = chunk_text(text)
    if not chunks:
        return
    embeddings = embed_texts(chunks)
    if not embeddings:
        return
    model = getattr(client, "model", "unknown")
    for index, (chunk, vector) in enumerate(zip(chunks, embeddings, strict=False)):
        if not vector:
            continue
        store.conn.execute(
            """
            INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
            VALUES (?, ?, ?, ?, ?)
            """,
            (vector, memory_id, index, hash_text(chunk), model),
        )
    store.conn.commit()
