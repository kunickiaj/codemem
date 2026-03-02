# memory.explain Contract (codemem-chf.1)

This document defines the API contract for the planned MCP tool `memory_explain`.

Goal: return deterministic, per-memory retrieval rationale without changing existing ranking behavior.

## Request Contract

`memory_explain` accepts these inputs:

- `query: str | None = None`
- `ids: list[int] | None = None`
- `project: str | None = None`
- `include_pack_context: bool = False`
- `limit: int = 10`

Rules:

1. At least one of `query` or `ids` must be provided.
2. `ids` are deduped while preserving first-seen order.
3. `limit` applies only to query-derived results, not explicit IDs.
4. `project` applies the same project scoping semantics as existing MCP memory tools.

## Response Contract

Top-level response:

```json
{
  "items": [],
  "missing_ids": [],
  "errors": [],
  "metadata": {}
}
```

### `items[]`

Each item contains stable retrieval and scoring rationale:

```json
{
  "id": 123,
  "kind": "decision",
  "title": "Picked SQLite path normalization",
  "created_at": "2026-03-01T00:00:00+00:00",
  "project": "/repo/project",
  "retrieval": {
    "source": "query",
    "rank": 1
  },
  "score": {
    "total": 2.14,
    "components": {
      "base": 1.2,
      "recency": 0.74,
      "kind_bonus": 0.2,
      "semantic_boost": null
    }
  },
  "matches": {
    "query_terms": ["sqlite", "normalization"],
    "project_match": true
  },
  "pack_context": null
}
```

Field notes:

- `retrieval.source` is one of: `query`, `id_lookup`, `query+id_lookup`.
- `score.total` and `score.components.*` are numbers when derivable; otherwise `null`.
- `pack_context` is `null` unless `include_pack_context=true`.

### `missing_ids[]`

IDs requested in `ids` but not found in scope (including project scope).

### `errors[]`

Non-fatal, structured errors:

```json
{
  "code": "INVALID_ARGUMENT",
  "message": "at least one of query or ids is required",
  "field": "query"
}
```

Error codes:

- `INVALID_ARGUMENT`
- `NOT_FOUND`
- `PROJECT_MISMATCH`

### `metadata`

Stable envelope metadata:

- `query: str | null`
- `project: str | null`
- `requested_ids_count: int`
- `returned_items_count: int`
- `include_pack_context: bool`

## Deterministic Null/Default Rules

1. Unknown score components are `null` (never omitted).
2. Missing arrays are empty arrays (never `null`).
3. Missing object fields use explicit `null` when present in schema.
4. `errors` is additive and non-fatal unless request parsing fails entirely.

## Test Contract Matrix (for codemem-chf.4)

1. Schema registration includes `memory_explain` with request args above.
2. Happy path returns `items[]` with stable required fields.
3. Mixed valid/missing IDs populate both `items[]` and `missing_ids[]`.
4. Project filter mismatch returns `PROJECT_MISMATCH` and deterministic empty/partial items.
5. `include_pack_context=false` returns `pack_context: null` for all items.
6. `include_pack_context=true` returns object shape with deterministic keys.
7. Unknown derivable score components are `null`, not omitted.

## Out of Scope for chf.1

- Store-side scoring assembly implementation (`codemem-chf.2`)
- MCP tool wiring and runtime behavior (`codemem-chf.3`)
- Test implementation (`codemem-chf.4`)
