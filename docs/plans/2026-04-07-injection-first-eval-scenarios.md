# Injection-First Eval Scenarios for Track 3

**Status:** Draft
**Date:** 2026-04-07
**Parent policy:** `docs/plans/2026-04-07-track-3-injection-first-memory-policy.md`
**Depends on:**
- `docs/plans/2026-04-07-session-boundary-matrix.md`
- `docs/plans/2026-04-07-recap-policy.md`
- `docs/plans/2026-04-07-memory-quality-model.md`
**Primary bead:** `codemem-24q2`

## Purpose

Define evaluation scenarios that measure whether codemem improves **automatic
injection quality** by reducing rediscovery, scouting, and repeated work.

These evals should not treat explicit recap prompts as the main product path.
They should instead focus on whether codemem helps the agent continue work with
less manual context excavation.

## Core Evaluation Question

For a given prompt or work continuation moment:

> Did codemem inject enough of the right prior context that the agent could avoid
> repeated scouting, repeated decision archaeology, and repeated troubleshooting?

## Eval Classes

### 1. Locating / code scouting scenarios

Measure whether codemem helps the agent find relevant implementation context
faster.

Example prompts:

- `what decisions affected index.ts?`
- `what do we know about auth?`
- `where did we already touch recap weighting?`
- `what work touched the viewer health tab?`

What success looks like:

- injected context points to relevant files/modules/workstreams
- less manual file/session scouting is needed
- durable locating memories outrank broad recap blobs

### 2. Decision continuity scenarios

Measure whether codemem helps the agent understand past decisions well enough to
make better new ones.

Example prompts:

- `what did we decide about recap weighting?`
- `what was the rationale for session summary suppression?`
- `what tradeoff drove the summary handling changes?`

What success looks like:

- prior decisions are surfaced with rationale/tradeoffs
- recap does not drown out decision memories
- the agent can use prior reasoning to inform the next step

### 3. Outcome continuity scenarios

Measure whether codemem helps the agent reuse what worked or failed.

Example prompts:

- `what changed for memory retrieval issues?`
- `what was the fix for raw-event relinking?`
- `what happened after the recap fallback fix?`

What success looks like:

- shipped fixes and meaningful outcomes surface cleanly
- low-value recap does not dominate top injected context

### 4. Troubleshooting recurrence scenarios

Measure whether codemem reduces repeated investigation when a similar issue
returns.

Example prompts:

- `what did we decide last time about oauth?`
- `what was the root cause of the micro-session regression?`
- `how did we debug the raw-event flush issue before?`

What success looks like:

- prior root cause and fix path appear quickly
- irrelevant recap or wrong-thread summary material stays out of the way

### 5. Workstream continuation scenarios

Measure whether codemem helps continue ongoing work without manual session
archaeology.

Example prompts:

- `continue the Track 3 work`
- `what should we do next about recap policy?`
- `what remains on sessionization policy?`

What success looks like:

- codemem injects next-step-relevant context
- recap supports orientation without becoming the whole payload

## Scenario Format

Each scenario should specify:

1. **Prompt or injection moment**
2. **Expected primary context types**
3. **Expected anti-signals** (what should *not* dominate)
4. **Measured burden**
5. **Pass criteria**

### Example schema

| Field | Description |
|---|---|
| scenario_id | stable identifier |
| class | locating / decision / outcome / troubleshooting / continuation |
| prompt | query or injection context |
| expected_primary | kinds/roles that should dominate |
| expected_anti_signals | recap noise, wrong-thread summary, unmapped sludge |
| pass_criteria | concrete acceptance conditions |

## Metrics

### Burden metrics

- recap share in top injected context
- unmapped share in top injected context
- recap-unmapped share in top injected context

### Utility metrics

- proportion of injected items with locating value
- proportion of injected items with decision value
- proportion of injected items with outcome or troubleshooting value

### Continuity metrics

- how often the right workstream/session lineage is represented
- whether follow-up prompts can continue without manual scouting

## Existing Candidate Scenarios

The current codebase already contains useful fixture/eval prompts that should be
formalized under this bead:

- `memory retrieval issues`
- `sessionization summary emission`
- `what did we decide last time about oauth`
- `what should we do next about auth`
- `summary of oauth`

These should be treated as seed scenarios, not the entire evaluation corpus.

## Rich Session Under-Extraction Case

The captured case in
`docs/plans/2026-04-07-rich-session-under-extraction-eval-case.md`
should become a first-class Track 3 eval scenario.

### Why it matters

- rich session input
- structurally successful flush
- semantically weak memory output

This scenario tests whether the system can extract multiple durable memories and
a representative summary from a long, high-signal session.

### What to measure

- number of durable typed observations produced
- summary coverage of major subthreads
- whether key decision/outcome/location context survives
- whether output would reduce future scouting and rediscovery effort

## Pass/Fail Direction

### Better looks like

- lower recap burden for non-summary automatic injection
- stable or improved recap usefulness for explicit recap prompts
- more durable observations from rich sessions
- higher locating/decision/outcome value in top injected context

### Worse looks like

- more recap sludge in non-summary injection
- under-extraction of rich sessions
- summary dominance without locating or decision value
- the agent still needing manual session/file scouting to continue work

## First Implementation Slice

1. codify scenario metadata in a small fixture format
2. convert current useful prompts into named scenarios
3. add the rich-session under-extraction case as a tracked non-fixture scenario
4. wire burden + utility metrics into comparison reporting over time

## Open Questions

- Should the first eval harness remain lightweight and prompt-based, or should it
  simulate transform-hook injection more directly?
- Which scenarios should be synthetic fixtures versus captured live-session cases?
- How should we score locating value and decision value without collapsing back
  into vague human vibes?
