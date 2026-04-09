# Pack Usefulness Roadmap

**Status:** Approved design
**Date:** 2026-04-08

## Context

Pack trace inspection revealed that codemem's retrieval is working better than
expected for Graphite-related queries: the right memories are being found and
ranked. The problem is downstream: the pack output is a flat blob that doesn't
help the model orient, act, or synthesize.

The current `formatItem` emits:

```
[13664] (discovery) Identified stale Graphite branches... - <body_text blob>
```

This mashes title + body into one line per item, losing the structured content
(`narrative`, `facts`) that was extracted during observation and stored in the
database. The result is a wall of text that a model must re-parse on every prompt
instead of scanning structured, role-specific content.

Inspiration from `claude-mem`:
- **narrative** is the default "full context" field for AI injection
- compact index lines (`ID TIME TYPE TITLE`) let the model scan without reading
  everything
- `get_observations([IDs])` lets the model fetch detail on demand
- the agent formatter is explicitly optimized for token efficiency

## Phased Roadmap

### Phase D: Restore narrative and facts in pack output

**Goal:** Use structured observation content (`narrative` + `facts`) instead of
the raw `body_text` blob when available.

**What changes:**

1. Expand `MemoryResult` to carry `narrative: string | null` and
   `facts: string | null`.
2. Update search/retrieval queries to propagate those columns (the SQL already
   selects `memory_items.*`, so the data is there — it's just dropped at the
   mapping layer).
3. Update `formatItem` in `pack.ts`:
   - if `narrative` exists, use it as the primary body instead of `body_text`
   - if `facts` exist (JSON string array), render them as bullet points after
     the narrative
   - fall back to `body_text` only when neither structured field is available
4. Update pack trace `preview` to prefer `narrative` over `body_text`.

**Before:**
```
[13664] (discovery) Identified stale Graphite branches after stack merge cleanup - The branch audit clarified which Graphite branches were real outstanding work...
```

**After:**
```
[13664] (discovery) Identified stale Graphite branches after stack merge cleanup
The branch audit clarified which Graphite branches were real outstanding work
and which were just stale local tracking after the stacked-merge cleanup...

- `04-07-feat_track3_injection_policy_foundations` and 4 others were already merged.
- `04-06-feat_plan_safe_raw-event_relink_remediation_steps` had no PR and no unique commits.
- The earlier idea that every squash-merge requires immediate re-parenting was rejected.
```

**Token budget impact:** Narrative + facts will be longer per item. Items that
exceed the budget will be trimmed as before. The tradeoff is intentional: fewer
items with useful structure beats more items of flat noise.

**Design rules:**
- narrative replaces body_text in the pack when available; it does not supplement
  it
- facts are rendered as `- ` bullet lines after the narrative
- body_text is the fallback for memories that lack structured content
- the `PackItem.body` field in the response should also prefer narrative

### Phase A: Compact index + fetch-more pattern

**Goal:** Show a scannable index of selected memories with on-demand detail
access, inspired by claude-mem's `ID TIME TYPE TITLE` + `get_observations`.

**What changes:**

1. Add a "compact mode" pack option where the pack text contains:
   - a scannable index section with one line per item: `[ID] (kind) title`
   - full narrative/facts only for the top N items (configurable, default ~3)
   - a footer note like: "Fetch details for any item via
     `memory_search` or `memory_get`"
2. The default pack mode continues to show full content for all items (the
   current behavior, improved by Phase D).
3. Compact mode is useful for token-constrained injection where a broad overview
   matters more than full detail on every item.

**Design rules:**
- compact mode does not change retrieval or ranking; it only changes rendering
- full mode remains the default for CLI and MCP `memory_pack`
- compact mode is opt-in via a flag or pack configuration
- the index lines use the same `[ID] (kind) title` format as full mode headers

### Phase B: Cross-memory synthesis

**Goal:** When multiple retrieved memories point at the same recurring pattern,
compress them into a concise operational summary instead of listing them
individually.

**What this is NOT:**
- not a knowledge graph
- not a new storage layer
- not extraction-time synthesis

**What this IS:**
- pack-time synthesis: a rendering step that detects cluster patterns in the
  selected candidates and produces a synthesized section

**Candidate synthesis patterns:**
- **recurring failure mode:** multiple memories describe the same class of
  problem (e.g., "Graphite parentage drifts after squash merge") → synthesize
  into one "Known pattern" block with recovery steps
- **operational rules:** multiple memories share the same learned lesson →
  synthesize into a "Rules" block
- **open threads / next steps:** multiple memories reference unresolved work →
  synthesize into a "Resumable threads" block

**Design approach:**
- detect clusters via title/body overlap, shared tags, or shared file paths
- use a lightweight LLM call (or heuristic grouping) to synthesize clusters
- present synthesized sections before the individual memory listing
- keep individual memories available for detail

**This phase has been specified** based on a 30-trace empirical audit conducted
after shipping D and A. See
[Phase B design doc](./2026-04-08-phase-b-pack-dedup-design.md) for the full
spec, audit data, and implementation plan.

## Implementation Order

1. **Phase D** — restore narrative/facts (quick win, high signal) ✅ shipped
2. **Phase A** — compact index + fetch-more (token efficiency, broad context) ✅ shipped
3. **Phase B** — cross-memory synthesis (differentiated product value) — [design ready](./2026-04-08-phase-b-pack-dedup-design.md)

## Files Likely to Change

### Phase D
- `packages/core/src/types.ts` — add `narrative` and `facts` to `MemoryResult`
- `packages/core/src/search.ts` — propagate `narrative` and `facts` from query
  rows into `MemoryResult` at every mapping site
- `packages/core/src/pack.ts` — update `formatItem` and `toPackItem` to prefer
  narrative/facts
- `packages/core/src/pack.test.ts` — add tests for structured content rendering
- `packages/core/src/store.ts` — update `recent`/`recentByKinds` result mapping
  if they feed into pack

### Phase A
- `packages/core/src/pack.ts` — add compact mode rendering path
- `packages/core/src/types.ts` — add compact mode option to pack inputs
- `packages/mcp-server/src/index.ts` — expose compact mode in MCP pack tool
- `packages/cli/src/commands/pack.ts` — add `--compact` flag

### Phase B
- `packages/core/src/pack.ts` — add cluster detection and synthesis rendering
- potentially a new `packages/core/src/pack-synthesis.ts` module
- test coverage for cluster detection heuristics

## Testing Strategy

### Phase D
- memories with narrative + facts render structured output
- memories without narrative fall back to body_text
- pack trace preview prefers narrative
- token budget still trims correctly with longer per-item content
- pack text parity: `buildMemoryPack` and `buildMemoryPackTrace` agree on output

### Phase A
- compact mode renders index lines for all items
- compact mode shows full content only for top N items
- compact mode footer includes fetch-more guidance
- token budget respects compact mode sizing

### Phase B
- cluster detection groups related memories correctly
- synthesis produces concise operational summaries
- individual memories remain accessible after synthesis
