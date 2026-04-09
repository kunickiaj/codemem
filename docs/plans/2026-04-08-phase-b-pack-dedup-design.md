# Phase B: Pack near-duplicate compression

**Parent:** [Pack usefulness roadmap](./2026-04-08-pack-usefulness-roadmap.md)
**Status:** Design ready — pending approval
**Prereqs:** Phase D (shipped), Phase A (shipped)

## Empirical findings

A 30-trace pack audit (spanning task, recall, and default modes across diverse
queries) produced these results:

| Metric | Value |
|---|---|
| Traces analyzed | 30 |
| Total candidates | 300 |
| Total selected items | 246 |
| Exact dedupes (current system) | 1 |
| Near-duplicate clusters found | 41 |
| All-selected clusters (synthesis targets) | 27 |
| Selected items in clusters | 70 (28% of selected) |

**Mode breakdown:**

| Mode | Selected in clusters | Cluster rate |
|---|---|---|
| default | 66 / 206 | 32% |
| recall | 4 / 13 | 31% |
| task | 0 / 27 | 0% |

Task mode returns distinct actionable items and does not need synthesis.
Default and recall modes waste ~30% of their token budget on near-duplicate
content covering the same theme.

### Cluster pattern taxonomy

From the 27 all-selected clusters:

| Pattern | Count | Example |
|---|---|---|
| **Related work** — multiple memories about the same feature/change from different sessions | 14 | Sync orchestrator port appears as both a discovery and a feature memory |
| **Session echo** — a session_summary restating what a detail memory already says | 5 | "Remove accidental docs plan file" appears as a change + session_summary |
| **Operational rule** — same lesson surfaced from different sessions | 4 | Replication retention plan described twice as separate discoveries |
| **Recurring failure** — same bug/fix described twice | 2 | Peer deletion cursor leak: two bugfix memories with near-identical titles |
| **Thematic overlap** — same investigation from different angles | 2 | Python→TS port footguns: a discovery + an exploration |

### Token savings estimate

The most cluster-heavy traces (sync replication: 4 clusters in 10 items, viewer
inspector: 5-item cluster) could drop 30–40% in token cost if clusters were
compressed. Across the full audit, compressing 27 clusters would eliminate ~70
redundant items, saving roughly 25% of total pack tokens in default/recall modes.

## How claude-mem handles this

claude-mem avoids the problem at two layers:

1. **Ingestion-time content-hash dedup** — `sha256(session_id, title,
   narrative)` with a 30-second window prevents identical observations from being
   stored (e.g., webhook retries, re-processing).

2. **Per-session dedup at retrieval** — For file-context queries, claude-mem
   keeps only the most recent observation per session, then ranks by specificity.
   This prevents the "5 memories about the same PR from 5 sessions" pattern.

3. **No pack-time synthesis** — claude-mem does not compress near-duplicates. It
   relies on its compact index format (`ID TIME TYPE TITLE` table) plus
   `get_observations([IDs])` to let the model choose what to expand. The model
   does the synthesis implicitly by only fetching what it needs.

**Key insight:** claude-mem's approach sidesteps synthesis by (a) preventing
duplicates from being stored and (b) giving the model a cheap index with
on-demand detail. codemem's compact mode (Phase A) now provides the same
on-demand pattern, but the underlying data still has near-duplicates that waste
index lines and detail slots.

## Root cause

codemem's observer creates a new `memory_item` for each session that touches a
topic. When multiple sessions work on the same feature (e.g., 3 sessions
implementing a PR, reviewing it, and fixing review feedback), each produces a
separate memory. These memories have similar titles and overlapping body content
but different IDs, different sessions, and slightly different wording — enough to
bypass exact dedup.

## Design

### Two complementary layers

Phase B addresses near-duplicates at both ingestion and rendering:

**Layer 1: Ingestion-time near-dedup (prevent new duplicates)**

Lightweight content-hash check at `remember()` time. Before inserting a new
memory item, compute a dedup key and check for a recent match.

**Layer 2: Pack-time cluster compression (handle existing duplicates)**

At pack assembly time, detect near-duplicate clusters in the selected items and
compress each cluster into a single representative item with a support count.

### Layer 1: Ingestion-time near-dedup

**Dedup key:** `sha256(session_id, normalize(title))` — same session + same
normalized title = duplicate. This catches the observer re-extracting the same
memory when a session is processed multiple times.

**Cross-session dedup key:** `sha256(normalize(title))` with a configurable time
window (default: 1 hour). This catches the common pattern of consecutive
sessions producing the same memory (e.g., reviewing a PR, then fixing review
feedback — both sessions produce "PR #649 Context Inspector" memories).

**Normalize:** lowercase, collapse whitespace, strip leading/trailing
punctuation, strip numeric prefixes like PR/issue numbers. This lets "PR #649
review found Context Inspector reads shared query state" and "PR #649 inspector
still shows stale error" remain distinct (different verbs, different claims)
while collapsing true duplicates like "Sync pass orchestrator ported from Python
to TypeScript" appearing twice with minor wording variations.

**On match:** Skip the insert and return the existing memory's ID. Log the skip
at debug level. Optionally bump the existing memory's `updated_at` to reflect
that the topic was re-encountered.

**Configuration:**
- `dedup_same_session`: boolean (default: true) — always deduplicate within a
  session
- `dedup_cross_session_window_ms`: number (default: 3600000 / 1 hour) — set to
  0 to disable cross-session dedup

**Implementation cost:** One indexed lookup per `remember()` call. The
`content_hash` column already exists on `artifacts` but not on `memory_items` —
add a `dedup_key` column with an index.

### Layer 2: Pack-time cluster compression

This is a rendering-only optimization. It does not modify stored data.

#### Detection heuristic

For the selected items in a pack, find clusters of near-duplicates:

```
for each pair of selected items (i, j):
  if titleWordOverlap(i, j) >= 3 significant words:
    group i and j into the same cluster
```

**"Significant words"** = words with length > 2, excluding a stopword set
(the, a, an, and, or, to, in, for, of, on, with, is, was, are, were, from,
this, that, it, not, no). This is the exact heuristic used in the audit and it
caught all 27 real clusters with zero false positives across 30 traces.

**Transitive closure:** If A clusters with B and B clusters with C, all three
form one cluster. Use union-find for efficient grouping.

#### Compression strategy

For each cluster of size ≥ 2:

1. **Pick a representative:** The cluster member with the highest confidence. On
   tie, prefer the most recent. On further tie, prefer the item with narrative
   content.

2. **Annotate the representative:** Add a `support_count` field (extending the
   existing dedup `support_count` pattern) and a `compressed_ids` list of the
   other cluster members' IDs.

3. **Remove non-representatives** from the rendered pack text. They remain in
   `item_ids` and `items` (with a `compressed_into` field pointing to the
   representative) so the model can still fetch them via `memory_get`.

4. **Format compressed items** with an indicator:

   ```
   [42] (discovery) Sync pass orchestrator ported to TypeScript (+1 related)
   The sync pass orchestrator coordinates a complete synchronization exchange...
   ```

   The `(+N related)` suffix signals that more detail exists without consuming
   extra tokens.

#### Interaction with compact mode

In compact mode, compression happens before the Index/Detail split:
- Compressed items get one index line each (with the `+N` suffix)
- Only representatives compete for detail slots
- Non-representatives don't appear in the index at all

In full mode, compression replaces the non-representative items with the
annotated representative. The section structure (Summary/Timeline/Observations)
is preserved.

#### Efficiency

The detection is O(n²) in selected items, where n ≤ limit (default 10). For
n=10, that's 45 pair comparisons, each involving a set intersection of ~5–10
words. This is sub-millisecond work and adds negligible overhead to pack
assembly.

No LLM calls. No network requests. No new storage. The heuristic runs entirely
in-process using word-overlap on data already loaded for rendering.

#### When NOT to compress

- **Task mode:** The audit showed 0% cluster rate in task mode. Skip compression
  when `mode === "task"` to avoid any overhead or false positives.
- **Single-item clusters:** Only compress clusters of size ≥ 2.
- **Cross-kind clusters:** Allow clusters to span kinds (discovery + feature is a
  valid cluster). The representative's kind is preserved.

### Pack trace changes

The trace should report compression:

```json
{
  "assembly": {
    "compressed_clusters": [
      {
        "representative_id": 7566,
        "compressed_ids": [7570],
        "overlap_words": ["sync", "pass", "orchestrator", "ported", "python", "typescript"],
        "pattern": "related_work"
      }
    ]
  }
}
```

## Files to change

### Layer 1 (ingestion dedup)
- `packages/core/src/schema.ts` — add `dedup_key` column to `memory_items`
- `packages/core/src/store.ts` — add dedup check in `remember()`
- Migration for the new column + index
- Tests for dedup behavior

### Layer 2 (pack compression)
- `packages/core/src/pack.ts` — add `detectClusters()` and
  `compressClusters()` between reranking and budget steps
- `packages/core/src/types.ts` — add `support_count` and `compressed_ids` to
  `PackItem`, add `compressed_clusters` to `PackTrace`
- `packages/core/src/pack.test.ts` — cluster detection and compression tests

## Testing strategy

### Layer 1
- Same session, same normalized title → skip insert, return existing ID
- Same session, different title → both inserted
- Cross-session, same title within window → skip insert
- Cross-session, same title outside window → both inserted
- Cross-session dedup disabled → both inserted

### Layer 2
- Items with ≥ 3 shared significant words cluster together
- Items with < 3 shared words remain separate
- Representative is highest-confidence member
- Compressed items get `(+N related)` suffix in pack text
- `item_ids` still contains all original IDs (including compressed)
- Compression reduces `pack_tokens` vs. uncompressed
- Task mode skips compression
- Compact mode: compressed items excluded from index, only representative shown
- Trace reports `compressed_clusters`

## Implementation order

1. **Layer 2 first** (pack compression) — immediate value for existing data,
   no schema migration, rendering-only change
2. **Layer 1 second** (ingestion dedup) — prevents future duplicates, requires
   migration, reduces the work Layer 2 has to do over time

## Design decisions

### 1. Cross-session dedup window: 1 hour

Empirical analysis of the existing DB (13K active memories, 1668 near-duplicate
cross-session pairs):

| Bucket | Pairs | Cumulative |
|---|---|---|
| < 30 min | 202 | 12% |
| < 1 hour | 244 | 15% |
| < 24 hours | 438 | 26% |
| < 30 days | 1386 | 83% |
| 30+ days | 282 | 100% |

The distribution is bimodal: a spike at < 30 minutes (observer re-extracting
the same work within a session split) and a long tail out to weeks/months
(legitimately revisited topics). The median pair gap is 244 hours (~10 days).

**Decision:** Start with 1 hour. This catches 15% of pairs (the acute noise)
without risking suppression of legitimate new memories about revisited topics.
Layer 2 pack compression handles the long-tail redundancy. Instrument skipped
dedup hits at debug level to allow tuning later.

### 2. Title normalization: do not strip PR/issue numbers

The audit heuristic worked with PR numbers included and produced zero false
positives across 30 traces. PR numbers are meaningful signal — two memories
sharing `PR #649` *are* related work, and that helps clustering. If we see
false positives later (two unrelated memories that happen to mention the same
PR), we can revisit.

### 3. Compressed items: exclude from `items`, keep in `item_ids`

Compressed-away items are excluded from the `items` response array but remain
in `item_ids`. The `pack_text` already shows `(+N related)` which signals
more detail exists, and `item_ids` gives the model IDs to fetch via
`memory_get`. Adding compressed items to `items` is dead weight in the common
case where the model trusts the representative. If the "why was this
compressed" signal is needed, `compressed_clusters` in the response metadata
(parallel to the trace field) provides it without bloating every item.
