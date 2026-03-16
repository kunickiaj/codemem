# TypeScript Store Port — Known Phase 1 Parity Gaps

Date: 2026-03-16
Status: Active
Beads: codemem-6h33 (this doc), codemem-d91c (pack gaps)

## Overview

The TS store port (bead codemem-egb) covers the core MemoryStore API: get,
remember, forget, recent, recentByKinds, stats, updateMemoryVisibility,
search, timeline, explain, buildMemoryPack. During Phase 1, Python owns DDL
and the TS runtime validates schema but does not run migrations.

This document tracks known behavioral differences between the Python and TS
implementations that will cause parity test failures or ranking divergences.

## Search Ranking Differences

### personal_bias (not ported)

Python's `_rerank_results` adds `_personal_bias(store, item, filters)` to the
combined score. When `personal_first` is enabled (the default in production),
memories with matching `actor_id` or `origin_device_id` get a +0.45 bonus.
The TS reranker omits this term entirely.

**Impact:** Search result ordering will differ for any user with
`personal_first` enabled. Memories owned by the current actor will rank lower
in TS results compared to Python.

**Resolution:** Port actor resolution and personal_bias scoring. Tracked as
part of the broader actor/provenance work.

### trust_penalty (not ported)

Python subtracts `_shared_trust_penalty(store, item, filters)` from the
combined score. Memories with `trust_state = "legacy_unknown"` get penalized
(-0.18) and `trust_state = "unreviewed"` gets penalized (-0.12) when
`trust_bias` is active.

**Impact:** In multi-actor deployments, untrusted shared memories rank higher
in TS than in Python.

**Resolution:** Port trust_bias logic alongside actor resolution.

### Query widening (always on in TS)

Python only widens the SQL candidate set (fetching 4× the requested limit)
when `working_set_paths` or `personal_first` is active. TS always widens.

**Impact:** TS fetches more SQL rows per search than Python for simple queries
without filters. This is actually better for reranking accuracy but means
more work per query and subtly different result sets when the extra candidates
change the top-K after reranking.

**Resolution:** Could conditionally widen, but the current behavior is
arguably more correct. Document as intentional divergence.

## build_memory_pack Gaps

See bead codemem-d91c for the full list. Key differences:

- Task/recall mode detection not ported (always uses default search path)
- Semantic search merge not ported (FTS-only)
- Fuzzy search fallback not ported
- Exact dedup (`_collapse_exact_duplicates`) not ported
- Pack delta tracking not ported
- `items` array missing `support_count` and `duplicate_ids` fields
- `metrics` has ~5 fields vs Python's ~35
- Empty sections filtered out (Python always emits all three headers)
- Observation fallback to `recent_by_kinds` not ported

## Features Not Ported (Phase 1)

These are intentionally deferred, not bugs:

- Semantic/vector search (needs onnxruntime-node + embedding worker)
- Usage tracking (`record_usage`)
- Prompt links (`_attach_prompt_links`)
- Project filter (requires session join, `joinSessions` path)
- Full provenance resolution (actor_id, actor_display_name lookup)
- `memory_owned_by_self` full check (currently checks `origin_device_id` only)
- `flush_batch` dedup in `remember()`
- `search_index` (separate from FTS search)
- Working set path boosting
- Shadow comparison logging
