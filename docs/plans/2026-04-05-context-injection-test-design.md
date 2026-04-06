# Context Injection & Pack Quality Test Design

**Status:** Decision
**Date:** 2026-04-05

## Context

codemem's main value proposition is automatic memory recall at prompt time. That
value is delivered through multiple surfaces:

- core memory pack retrieval and formatting
- OpenCode prompt-time injection
- Claude hook prompt-time context emission
- CLI/manual pack and inject commands

Today, the repository has solid coverage for many pack-building invariants in
`packages/core/src/pack.test.ts`, plus some plugin-adjacent tests for OpenCode
adapter helpers. That is not enough.

The highest-risk failure mode is silent regression: context injection still
"exists" in docs and wiring, but the wrong query is built, the adapter stops
injecting, cache invalidation breaks, or the pack remains technically valid but
stops being useful.

This document defines a layered test strategy that verifies both:

1. the core pack remains structurally correct and usefully ranked
2. each adapter continues to deliver that pack correctly

## Problem Statement

The current test surface is uneven:

- **Core pack behavior:** reasonably covered for sections, fallback, token
  budget, task/recall mode, and some ranking behavior
- **OpenCode adapter behavior:** helper coverage exists, but prompt-time
  injection contract coverage is too thin for the highest-risk path
- **Claude hook path:** needs explicit contract-level coverage as a first-class
  adapter surface
- **Usefulness evaluation:** current tests mostly prove pack existence and shape,
  not whether the pack is actually helpful for realistic recall and continuation
  workflows

The result is a brittle gap: regressions in delivery semantics or retrieval
quality can slip through without obvious failures.

## Goals

- Add deterministic regression guards for context delivery
- Treat adapter delivery as a first-class contract, not incidental wiring
- Add curated usefulness evals for realistic recall, task, and continuation
  prompts
- Reuse one shared fixture corpus for core usefulness checks where practical
- Keep tests deterministic, cheap to run, and easy to extend

## Non-Goals

- Redesign the pack format before test evidence justifies it
- Rewrite retrieval heuristics as part of this work
- Add external benchmark infrastructure in the first pass
- Duplicate full usefulness suites per adapter

## Design Principle

**Test retrieval quality once in core. Test delivery semantics per adapter.**

Core tests answer: "Did we choose and structure the right memories?"

Adapter tests answer: "Did this surface request, receive, and emit that context
correctly?"

This keeps the suite focused and avoids adapter-specific duplication of the same
ranking assertions.

## Test Layers

### Layer 1: Core pack regression and usefulness

Core pack tests live with the pack implementation in `packages/core/src/`.

#### 1A. Pack invariant tests

Keep and extend invariant coverage in `packages/core/src/pack.test.ts` for:

- section ordering: `Summary`, `Timeline`, `Observations`
- fallback behavior when search misses
- summary fallback to latest `session_summary`
- observation fallback behavior
- exact dedupe across sections
- token-budget trimming, with earlier sections retaining priority
- task-mode selection
- recall-mode selection
- working-set influenced ranking
- distractor resistance in mixed result sets
- support metadata (`support_count`, `duplicate_ids`) where dedupe collapses
  exact duplicates

These tests should remain deterministic and implementation-near.

#### 1B. Pack usefulness evals

Add a curated eval suite, for example:

- `packages/core/src/pack.eval.test.ts`

This suite should use a hand-authored corpus and realistic queries such as:

- "what did we decide about oauth last time?"
- "what should we do next about sync?"
- "continue the viewer health work"
- "I'm editing this file, what context matters?"

Recommended assertions:

- expected top-N contains key memory IDs
- expected key memory outranks known distractors
- expected section contains the target item
- pack text contains target concepts and terminology
- expected retrieval mode is selected (`default`, `task`, `recall`)

The eval suite should prefer tiered assertions over full exact-order snapshots.
Exact full-order snapshots create brittle, noisy failures for small ranking
adjustments that do not materially reduce usefulness.

### Layer 2: Adapter contract tests

Adapter tests verify delivery semantics, not retrieval quality itself.

#### 2A. OpenCode adapter contract tests

Extend tests under `packages/cli/.opencode/tests/` to cover the actual prompt
injection path and its supporting query logic.

Required coverage:

- `experimental.chat.system.transform` injects context into `output.system`
- injected context is prefixed/formatted according to the adapter contract
- no injection occurs when pack generation fails
- no injection occurs for invalid or empty JSON payloads
- first injection toast fires once per session
- cached injection is reused when the query is unchanged
- cache invalidates when query inputs change
- query assembly includes the intended signals:
  - first prompt
  - latest prompt when distinct and non-trivial
  - project name
  - recently modified files
- pack args include working-set files, limit, and token budget where applicable

These tests should stay focused on adapter behavior and not duplicate core pack
ranking logic.

#### 2B. Claude hook contract tests

Add explicit coverage for the Claude hook path as a first-class adapter.

Required coverage:

- hook input is translated into the intended context query/input shape
- the hook emits codemem context in the expected contract format
- failure to build a pack produces safe fallback behavior
- empty or malformed pack output does not produce broken hook output
- prompt/project/working-set inputs flow into pack generation correctly
- adapter-specific formatting remains stable

The Claude hook tests should validate the hook as the delivery surface, not just
the CLI command it happens to call.

#### 2C. CLI/manual contract tests

Treat CLI/manual pack surfaces as a baseline contract:

- `codemem pack`
- `codemem memory inject`

Required coverage:

- output shape/schema for JSON responses
- raw injected text contract for manual injection surfaces
- project scoping behavior
- working-set flag plumbing
- failure handling and empty-result behavior

These tests provide a simple, stable baseline for adapter consumers.

## Adapter Matrix

| Adapter | Entry point | Output mechanism | Query/input source | Cache behavior | Test location |
|---|---|---|---|---|---|
| OpenCode | plugin transform | append to system prompt | prompts + project + modified files | per-session/query cache | `packages/cli/.opencode/tests/` |
| Claude hook | hook path | hook-emitted prompt/additional context text | hook-specific prompt/context inputs | adapter-defined | Claude hook test file(s) |
| CLI/manual | `pack` / `memory inject` | stdout JSON or raw text | command arguments | none | `packages/cli/src/commands/*.test.ts` and core tests |

## Fixture Strategy

Use a small shared hand-authored memory corpus for usefulness evaluation.

Fixture requirements:

- multiple sessions
- multiple memory kinds:
  - `session_summary`
  - `decision`
  - `feature`
  - `bugfix`
  - `discovery`
- intentional distractor memories
- at least one scenario where naive recency would choose the wrong item
- at least one scenario with overlapping file metadata for working-set ranking

The shared corpus should support multiple query styles without requiring random
or generated data. If a scenario needs a very specific edge case, it may add a
small scenario-local fixture on top of the shared corpus.

## Assertion Strategy

The test strategy uses three assertion styles:

1. **Exact deterministic assertions** for adapter delivery contracts
   - emitted field names
   - presence/absence of injected context
   - cache reuse and invalidation behavior
   - argument construction

2. **Invariant assertions** for pack structure
   - section ordering
   - fallback behavior
   - dedupe behavior
   - token-budget behavior

3. **Tiered usefulness assertions** for retrieval quality
   - expected key item appears in top-N
   - expected key item beats known distractors
   - expected section contains the item
   - expected concepts appear in pack text

This balances confidence against brittleness.

## Validation Commands

The following validation commands should become the standard workflow for
changes to context injection or pack behavior:

- Core pack tests: `pnpm vitest run packages/core/src/pack.test.ts`
- Core usefulness evals: `pnpm vitest run packages/core/src/pack.eval.test.ts`
- OpenCode adapter tests: `pnpm --filter codemem test:plugin`
- Claude hook tests: targeted command to be added with the new test file(s)
- CLI/manual command tests: targeted `pnpm vitest run ...` for the touched
  command tests, or `pnpm --filter codemem test`

If retrieval behavior changes, run both the core invariant suite and the
usefulness eval suite. If adapter delivery changes, run the relevant adapter
contract suite plus the nearest CLI/core contract tests.

## Rollout Plan

### Phase 1: deterministic contract coverage

- add this design doc
- add missing OpenCode prompt injection contract tests
- add Claude hook contract tests
- add any missing pack invariant tests that block confidence in delivery

### Phase 2: usefulness eval coverage

- add curated shared corpus
- add `pack.eval.test.ts` (or equivalent)
- encode recall, task, continuation, and working-set scenarios
- document fixture authoring rules inline in the test file or helper

### Phase 3: optional parity and reporting follow-on

- add lightweight parity checks where the same intent can be validated across
  core and adapter layers without duplicating retrieval logic
- optionally add a simple scorecard/reporting helper if usefulness evals expand

## Success Criteria

This design is successful when:

- breaking OpenCode injection fails fast in tests
- breaking Claude hook delivery fails fast in tests
- pack structure regressions fail deterministic core tests
- realistic recall/task/continuation scenarios fail usefulness tests when
  ranking quality materially degrades
- contributors have one obvious set of commands for the relevant layer they
  changed

## Deferred Work

- external benchmark integration
- broad adapter parity dashboards
- automated scoring beyond repository-local assertions
- pack format redesign based on usefulness results

## Decision

Adopt a layered test strategy:

- deterministic core pack invariant tests
- deterministic adapter contract tests for OpenCode and Claude hook delivery
- curated usefulness evals in core
- thin CLI/manual contract coverage as a baseline output surface

This provides immediate regression protection for delivery semantics while also
adding a path to verify that packs remain genuinely useful instead of merely
well-formed.
