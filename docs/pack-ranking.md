# Pack candidate ranking

Hybrid packs combine keyword and semantic evidence with equal-weight reciprocal rank fusion (RRF), so incompatible raw score scales cannot decide which channel wins.

## Ranking contract

Each eligible channel ranks unique memory IDs by descending raw score before fusion.

- Ranks start at one. The fixed rank constant is **60**, and each channel contributes `1 / (60 + rank)`; a missing channel contributes zero. This dampens differences near the top without calibrating BM25 and vector similarity onto one scale.
- Duplicate IDs contribute once per channel, using their highest finite score. Invalid IDs and non-finite semantic scores contribute no evidence. Equal raw scores use ascending memory ID for deterministic ranks.
- Fused relevance sorts first. Existing recency, kind, role, ownership, trust, and path preferences only break exact fused-score ties, calculated with a zero raw-score component. Memory ID breaks remaining ties.

## Scope and compatibility

Fusion consumes the existing keyword candidate pool and scoped, revalidated semantic rows; it does not expand authorization or eligibility.

Semantic rows use the same row conversion as keyword rows, including authoritative actor, device, workspace, visibility, trust, and file metadata. Existing project, scope, visibility, and automatic requester-session checks still run before semantic fusion. Keyword candidate generation, truncation, and weak-result widening retain their existing behavior.

Ordinary single-channel search and public raw `MemoryResult.score` values retain their existing meaning. For a hybrid duplicate, the keyword result supplies the public raw score; the semantic raw score remains available in diagnostics. Fusion is an ordering mechanism, not a confidence estimate or an abstention threshold.

Hybrid ordering deliberately changes: recency, personal ownership, and soft shared-trust preferences now break exact fused-relevance ties rather than override relevance through arithmetic bonuses or penalties. An eligible shared or unreviewed memory can therefore outrank a personal or trusted memory when its fused relevance is higher. Access filters and ordinary single-channel search are unchanged; this is not a claim that all hybrid ordering is unchanged.

## Diagnostics and later stages

Candidate traces expose fusion evidence separately from public raw scores.

`scores.fusion` contains `fts_score`, `fts_rank`, `semantic_score`, `semantic_rank`, `fused_score`, `rank_constant`, `fusion_rank`, and `secondary_score`. Missing channel evidence is `null`. `combined_score` retains its legacy raw-score-plus-preferences calculation and is **not the hybrid selection key**. Hybrid ordering uses `fused_score` first and `secondary_score` only for exact ties; `fusion_rank` records the pre-limit fused position, while the existing candidate `rank` still records first exposure order.

Human-readable CLI traces show `fused_score` with eight significant digits and `fusion_rank` separately from the legacy two-decimal score display. Each pack runs at most one fusion merge within its chosen mode, so its ID-keyed evidence map describes one ranking pass rather than accumulating multiple queries.

The retrieval ledger validates these supported fusion keys and persists them as flat numeric/null fields alongside existing score components. Readback and cached-attempt cloning retain all evidence. Unknown keys, conflicting nested/flat fields, and non-finite values remain invalid; legacy traces without fusion retain their existing serialized shape.

Task-query broadening, later word-overlap and kind sorting, section allocation, fallback, deduplication, and budgeting remain separate stages. They can change final pack membership or order after fusion, so a better fused ranking alone does not guarantee a better final pack.
