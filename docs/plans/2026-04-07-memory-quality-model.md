# Memory Quality Model Around Rediscovery Reduction

**Status:** Draft
**Date:** 2026-04-07
**Parent policy:** `docs/plans/2026-04-07-track-3-injection-first-memory-policy.md`
**Depends on:**
- `docs/plans/2026-04-07-session-boundary-matrix.md`
- `docs/plans/2026-04-07-recap-policy.md`
**Primary bead:** `codemem-gwez`

## Purpose

Define what makes a codemem memory worth storing and prioritizing by grounding
quality in a single question:

> Does this memory reduce rediscovery effort for future work?

This is broader than troubleshooting alone. High-quality memory should reduce the
effort required to:

- locate relevant code, files, modules, or workstreams
- understand previous decisions and tradeoffs
- reuse prior outcomes and fixes
- avoid repeated investigation or context scouting
- make better new decisions with less archaeology

## Core Principle

Memory quality is not the same thing as textual relevance or session richness.

A memory is high-quality when it increases future leverage. A memory is low-quality
when it adds words without materially helping the next session orient, decide,
locate, or act.

## Quality Dimensions

Evaluate a memory along five primary axes.

### 1. Locating value

Does the memory help find relevant code or implementation context faster?

Examples:

- names relevant files or modules
- identifies the workstream, component, or domain area
- points to an implementation pattern or repeated touchpoint

### 2. Decision value

Does the memory preserve a decision and its rationale well enough to improve a
future decision?

Examples:

- explains why a decision was made
- records constraints or tradeoffs
- captures what was rejected and why

### 3. Outcome value

Does the memory preserve what changed or what worked/failed?

Examples:

- shipped bugfix or behavior change
- discovery that altered understanding of the system
- successful implementation or operational outcome

### 4. Troubleshooting value

Does the memory reduce repeated investigation?

Examples:

- root cause
- failed hypotheses
- gotchas or edge cases
- prior diagnosis/fix path

### 5. Future-decision value

Does the memory improve future planning or next-step choices?

Examples:

- clarifies what remains unresolved
- records blockers or follow-up logic
- helps distinguish recap from durable next-step context

## Memory Classes

### A. Durable

#### Definition

Memories that should usually survive and rank well because they preserve high
future leverage.

Typical examples:

- `decision`
- `bugfix`
- `discovery`
- durable `feature`
- meaningful `refactor`

#### Expected value

- high locating value, decision value, or outcome value
- often also high troubleshooting or future-decision value

#### Retrieval posture

- prefer in automatic injection when relevant
- should usually outrank recap-like material for non-summary topical work

### B. Recap

#### Definition

Memories whose primary role is orientation or summarization rather than durable
knowledge preservation.

Typical examples:

- `session_summary`
- summary-like legacy rows
- observer-summary-like wrap-ups

#### Expected value

- useful for orientation
- lower trust than durable memory for default injection
- high value in explicit recap mode, conditional value in automatic injection

#### Retrieval posture

- allowed but conservative in automatic injection
- preferred in explicit recap mode

### C. Ephemeral

#### Definition

Memories that may be useful briefly but usually do not justify durable priority.

Typical examples:

- tiny acknowledgements
- narrow process-status notes
- weak one-off observations without future leverage

#### Expected value

- low or situational
- often poor locating/decision/outcome value

#### Retrieval posture

- demote heavily for automatic injection
- often suppress at write time when possible

### D. General / cross-project

#### Definition

Memories that capture durable patterns, how-things-work explanations, or broadly
reusable knowledge beyond one narrow session.

Typical examples:

- explanation of flush semantics
- relationship between observer schema and typed memory output
- stable architectural patterns

#### Expected value

- often high future-decision and troubleshooting value
- good candidates for broader reuse if they remain specific enough to be useful

#### Retrieval posture

- useful when topical scope matches
- should not override concrete project-local durable evidence when that exists

## What Good Memory Looks Like

High-quality memory usually has one or more of these traits:

- names a specific subsystem, file, concept, or decision
- explains cause and effect
- preserves what changed and why
- reduces the need to re-open old sessions or scout the repo manually
- helps the next agent/session choose a good next step quickly

## What Bad Memory Looks Like

Low-quality memory usually has one or more of these traits:

- broad process narration without durable outcomes
- generic recap that does not help locate, decide, or act
- little or no future leverage beyond the exact moment it was created
- redundant restatement of nearby recap memory
- weak connection to code, decisions, or consequences

## Quality Matrix

| Memory class | Locating value | Decision value | Outcome value | Troubleshooting value | Future-decision value | Automatic injection default |
|---|---|---|---|---|---|---|
| Durable | high or medium | high or medium | high | medium/high | medium/high | prefer when relevant |
| Recap | low/medium | low/medium | medium | low/medium | medium | support-only unless explicit recap |
| Ephemeral | low | low | low | low | low | suppress or heavily demote |
| General / cross-project | medium | medium/high | medium | medium/high | high | allow when scope matches |

## Relationship to Current Types

Current type/kind is not sufficient by itself to determine quality.

Examples:

- a `change` can be low-value recap sludge or a meaningful configuration outcome
- a `session_summary` can be useful orientation or noisy wrap-up
- a short-session `discovery` might still be highly durable

Track 3 should therefore treat quality as:

- **kind-informed**
- but not **kind-determined**

## Practical Policy Implications

### Rule 1 — do not optimize for memory count

More memories is not better. Better memories are better.

### Rule 2 — optimize for future leverage

If a memory would not materially help a later session find, understand, decide,
or reuse, it should usually be demoted or suppressed.

### Rule 3 — typed durable output should beat broad recap

When the system can represent a concrete outcome, decision, or discovery, that is
usually preferable to one more recap-like summary blob.

### Rule 4 — preserve rationale, not just results

Decision/value quality is much higher when the memory captures:

- why the decision happened
- what tradeoff was being protected
- what consequence followed

### Rule 5 — locating value matters

Track 3 must explicitly value memories that help reduce code/context scouting,
not just ones that sound conceptually important.

## Evaluation Questions

To evaluate quality, ask:

- Did this memory help find the right code or workstream faster?
- Did it explain a prior decision well enough to improve a new one?
- Did it preserve what worked or failed?
- Did it reduce repeated investigation?
- Did it make future action easier, not just future reading longer?

## First Implementation Slice

The first implementation slice for this model should be modest:

1. annotate policy docs and eval scenarios with these quality dimensions
2. use the quality model to refine summary-only gating and recap demotion
3. bias extraction toward multiple durable observations when a session contains
   multiple distinct high-value outcomes
4. use this model to score/inspect the rich-session under-extraction case

## Open Questions

- Should quality dimensions be persisted as metadata or remain implicit policy rules?
- How much of the quality model should influence write-time suppression versus
  retrieval-time ranking?
- When should general/cross-project memory outrank project-local recap?
