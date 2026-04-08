# Pack Trace and Context Inspector Design

**Status:** Approved design
**Date:** 2026-04-08
**Related bead:** `codemem-ei1c`

## Context

codemem's value depends on prompt-time recall actually being useful. The current
failure symptom is not "the pack command crashed" but "the model behaves like it
did not remember something it should have known."

Today, codemem does not provide a clean way to inspect:

- what query inputs were used to build a pack
- what memories were retrieved into the candidate pool
- which candidates were selected, dropped, deduped, or trimmed
- what final pack text was produced for the model

That makes quality work too guess-heavy. When context seems missing, the root
cause could be any of these:

1. useful memories were never extracted
2. useful memories exist but retrieval missed them
3. useful candidates were found but ranking or pack assembly lost them
4. the final pack was produced but formatted poorly enough to be ignored
5. injection or adapter delivery failed after pack generation

This design addresses the middle of that chain first: **retrieval plus pack
assembly observability**.

The guiding idea is to professionally steal the good parts of tools like
`claude-mem`: diagnostics should **prove correctness**, and context should be a
first-class inspectable product. We should not copy noisy log spam.

## Goals

- Make pack generation inspectable for a manual query
- Show a wider retrieval pool, not only final selected items
- Preserve both machine-readable and human-readable diagnostics
- Reuse one canonical trace object across CLI and future viewer surfaces
- Prepare for a future viewer **Context Inspector** entered from Search
- Leave room for a broader future **Doctor** diagnostics surface

## Non-Goals

- Trace the full extraction pipeline in v1
- Trace adapter injection/delivery in v1
- Redesign ranking heuristics as part of this design
- Add a new top-level viewer tab immediately
- Dump internal SQL/FTS implementation details into the user-facing output

## Design Decision

Add a canonical **PackTrace** diagnostic object in core, then expose it through:

1. **CLI first** via `codemem pack trace "<query>"`
2. **Viewer later** via a Context Inspector panel entered from Search

The trace object is the source of truth. Human-readable output is derived from
it rather than maintained as a separate logic path.

## User Experience

### Primary v1 workflow

The operator runs a manual query and inspects:

- inputs used for pack generation
- retrieval pool and ranks
- selection and drop decisions
- final packed text

This should answer the practical questions quickly:

- Did the right memory exist?
- Did retrieval find it?
- Did ranking lose it?
- Did token-budget trimming remove it?
- Did the final pack text actually contain it?

### Future viewer workflow

The viewer gets a **Context Inspector** panel attached to Search rather than a
new top-level tab.

That panel should support manual query inspection first. It can later expand to
historical prompt inspection and broader doctor-style diagnostics.

## CLI Surface

Add a new pack subcommand mode:

```text
codemem pack trace "<query>"
```

Supported flags should match the normal pack surface where relevant:

- `--project`
- `--working-set-file` (repeatable)
- `--token-budget`
- `--limit`
- `--json`

### Output rules

- default output: human-readable trace followed by final pack text
- `--json`: canonical PackTrace JSON only

This keeps trace a first-class pack operation instead of a weird debug flag.

## Canonical `PackTrace` Shape

The JSON contract should be explicit and deterministic.

### Top-level envelope

```json
{
  "version": 1,
  "inputs": {},
  "mode": {},
  "retrieval": {},
  "assembly": {},
  "output": {}
}
```

## `inputs`

Request inputs and effective knobs used to build the trace:

```json
{
  "query": "continue viewer health work",
  "project": "codemem",
  "working_set_files": ["packages/ui/src/tabs/feed.ts"],
  "token_budget": 1800,
  "limit": 12
}
```

Rules:

- arrays are empty arrays, not `null`
- optional scalars use explicit `null`
- values should reflect effective inputs used during trace generation

## `mode`

Pack mode selection plus terse reasons:

```json
{
  "selected": "task",
  "reasons": [
    "query matched task hints",
    "working set present"
  ]
}
```

This is meant to prove why the pack took a particular route, not expose every
internal branch in the decision tree.

## `retrieval`

The wider candidate pool used for debugging ranking and selection outcomes.

Recommended default pool size: **top 20 candidates**.

```json
{
  "candidate_count": 20,
  "candidates": [
    {
      "id": 13604,
      "rank": 1,
      "kind": "session_summary",
      "title": "Make 24q2 executable by adding scenario-pack support...",
      "preview": "Added named scenario-pack support with --scenario for role-report and role-compare...",
      "scores": {
        "search_score": 0.82,
        "rerank_score": 0.91,
        "tag_overlap": 3,
        "text_overlap": 4,
        "working_set_overlap": 1,
        "recency_boost": 0.10
      },
      "reasons": [
        "matched query terms",
        "working-set overlap",
        "summary-like memory"
      ],
      "disposition": "selected",
      "section": "summary"
    }
  ]
}
```

### Candidate rules

- `rank` preserves raw ranked order in JSON
- `preview` is a short stable body preview for human scanning
- `scores` may contain nullable components when not derivable
- `reasons` are terse human-readable explanations, not verbose chain-of-thought
- `disposition` is one of:
  - `selected`
  - `dropped`
  - `deduped`
  - `trimmed`
- `section` is present only when the candidate is selected into a final pack
  section

The JSON view should preserve ranked order. Human-readable rendering should group
by disposition while still showing the raw rank.

## `assembly`

Pack-assembly decisions that happen after candidate retrieval:

```json
{
  "deduped_ids": [101, 104],
  "collapsed_groups": [
    {
      "kept": 99,
      "dropped": [101, 104],
      "support_count": 3
    }
  ],
  "trimmed_ids": [122, 123],
  "trim_reasons": [
    "token budget exceeded; lower-priority observation items dropped first"
  ],
  "sections": {
    "summary": [13604],
    "timeline": [13597, 13596],
    "observations": [13739, 13668]
  }
}
```

This section exists to prove whether a candidate lost because of exact dedupe,
section prioritization, or token-budget trimming.

## `output`

Final render details:

```json
{
  "estimated_tokens": 734,
  "truncated": false,
  "section_counts": {
    "summary": 1,
    "timeline": 2,
    "observations": 2
  },
  "pack_text": "## Summary\n..."
}
```

This is the final proof artifact: what the model would have seen from pack
generation.

## Human-Readable Trace Rendering

The default CLI rendering should be optimized for fast debugging, not perfect
machine re-parsing.

Recommended structure:

1. inputs summary
2. selected mode
3. candidates grouped by disposition
4. assembly summary
5. final pack text

Example shape:

```text
Pack trace
- Query: continue viewer health work
- Project: codemem
- Working set: packages/ui/src/tabs/feed.ts
- Mode: task
- Token budget: 1800

Selected
1. [13604] (session_summary) Make 24q2 executable...
   - section: Summary
   - reasons: matched query, working-set overlap, summary-like
   - scores: rerank=0.91 tag=3 text=4 file=1

Dropped
3. [13431] (session_summary) Audit whether context injection...
   - reasons: lower-ranked summary after prioritization

Deduped / Trimmed
- kept [99], dropped [101, 104]
- trimmed for budget: [122, 123]

Final pack
## Summary
...
```

## Viewer Follow-On: Context Inspector

The future viewer surface should be a **panel entered from Search**, not a new
top-level tab.

### Why Search first

- manual query inspection is the first supported workflow
- users already associate Search with retrieval/debugging intent
- it avoids cluttering primary viewer navigation before the feature proves value

### Initial panel contents

- query input
- optional project input
- optional working-set files input
- candidate list with rank, disposition, reasons, and scores
- final packed text pane

The panel should consume the same PackTrace JSON produced by the CLI path.

## Future Doctor Direction

This design should leave room for a broader future **Doctor** surface, inspired
by the useful part of `claude-mem`'s diagnostics philosophy.

Potential later additions:

- recent pack traces
- injection success/failure proof
- token-budget and truncation statistics
- adapter/cache health
- last successful injection for a session or prompt

That broader doctor surface is intentionally out of scope for v1.

## Implementation Plan

### Phase 1: Core trace contract

- add PackTrace types to core
- plumb trace capture through pack building without changing normal pack output
- expose enough ranking and assembly metadata to explain outcomes

### Phase 2: CLI trace command

- add `codemem pack trace "<query>"`
- support text and JSON output modes
- keep normal pack command behavior unchanged

### Phase 3: Viewer Context Inspector panel

- add a Search entry point for manual query inspection
- render canonical PackTrace JSON in the viewer
- keep this as a panel/debug surface rather than a new primary tab

### Phase 4: Follow-on diagnostics

- evaluate a broader doctor-style debug surface after trace usage proves value

## Testing Strategy

Minimum required coverage:

### Core tests

- PackTrace JSON contains deterministic top-level fields
- candidate dispositions are correct for selected/dropped/deduped/trimmed cases
- assembly metadata reflects exact dedupe and token trimming decisions
- `output.pack_text` matches the normal pack render for the same input

### CLI tests

- `codemem pack trace` emits readable trace text by default
- `codemem pack trace --json` emits valid deterministic JSON
- relevant flags flow through to PackTrace inputs and pack generation

### Viewer follow-on tests

- Search entry opens Context Inspector panel
- manual query inspector renders candidate list and final pack text
- viewer consumes the canonical JSON shape rather than recreating pack logic

## Risks and Trade-Offs

- surfacing too much internal scoring detail can turn the trace into useless
  sludge; v1 should prefer terse reasons plus a small raw-score set
- tracing should not fork pack logic; normal pack output and traced pack output
  must stay aligned
- viewer polish should not block the CLI diagnostic path

## Recommended Bead Breakdown

Spin implementation out from `codemem-ei1c` into these follow-on tasks:

1. `codemem-zm46` — core PackTrace contract and pack instrumentation
2. `codemem-5prk` — CLI `codemem pack trace` command surface
3. `codemem-b1wo` — viewer Context Inspector panel entered from Search
4. `codemem-dcho` — future doctor-style diagnostics follow-on

These should be linked back to the parent design bead using
`discovered-from:codemem-ei1c`.
