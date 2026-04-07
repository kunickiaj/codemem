# Recap Policy for Automatic Injection vs Explicit Recap

**Status:** Draft
**Date:** 2026-04-07
**Parent policy:** `docs/plans/2026-04-07-track-3-injection-first-memory-policy.md`
**Depends on:** `docs/plans/2026-04-07-session-boundary-matrix.md`
**Primary bead:** `codemem-l92r`

## Purpose

Define how recap-like material should behave differently in:

- **automatic transform-hook injection**
- **explicit recap / summary requests**

The goal is not to eliminate recap. The goal is to stop recap from drowning out
durable, reusable context during default injection while still supporting
intentional summary-oriented workflows.

## Core Principle

Recap may be acceptable for `summary of X`, `catch me up`, or explicit review
questions while still being too noisy for default automatic injection.

In other words:

> recap is a useful mode, not a universal default

## Definitions

### Recap-like memory

Any memory whose primary purpose is summarization or progress narration rather
than preserving a durable, reusable outcome.

Examples:

- `session_summary`
- observer-generated `change` rows with summary metadata
- observer-summary-like rows with `request/completed/learned` recap structure
- broad wrap-up memories that restate process without adding much future utility

### Durable memory

A memory that helps future sessions reduce rediscovery effort by preserving:

- decision rationale
- implementation outcomes
- troubleshooting discoveries
- bugfixes
- reusable explanations of how things work

## Modes

### 1. Automatic injection mode

This is the default transform-hook path. It should be stricter.

#### Policy

- recap is **allowed but conservative**
- durable memories should beat recap by default
- recap should be demoted when it is:
  - unmapped
  - from a low-value micro-session
  - observer-summary-like and generic
  - not clearly tied to the current workstream

#### Default rule

Automatic injection should use recap only when recap materially improves
orientation and does not crowd out better durable context.

### 2. Explicit recap mode

This is activated by explicit user intent such as:

- `summary of ...`
- `recap`
- `catch me up`
- `what happened`

#### Policy

- recap can be preferred
- legacy summary-like rows may be tolerated
- broader summarization context is acceptable
- summary-first output is expected and useful

#### Default rule

When the user explicitly requests recap, recap material is not a bug. It is the
desired response mode.

## Recap Decision Matrix

| Context | Recap allowed? | Recap preferred? | Recap demoted? | Notes |
|---|---:|---:|---:|---|
| Automatic injection, trivial turn noise | no | no | n/a | suppress entirely |
| Automatic injection, low-value micro-session | rarely | no | yes (strong) | usually suppress or heavily demote |
| Automatic injection, high-signal short session | maybe | no | yes (mild) | typed output preferred |
| Automatic injection, working session | yes | no | conditional | recap can support orientation but not dominate |
| Automatic injection, durable work session | yes | sometimes | conditional | durable typed output still primary |
| Explicit summary / recap request | yes | yes | no | recap-first is intended |

## Practical Rules

### Rule 1 — recap should not dominate default injection

In automatic injection mode:

- recap should not be the highest-ranked class unless there is no better durable
  candidate
- broad recap blobs should lose to decisions, bugfixes, discoveries, and durable
  explanations when those are relevant

### Rule 2 — unmapped recap is especially risky

Unmapped recap often behaves like loose process narration rather than durable
knowledge. In automatic injection:

- strongly demote unmapped recap
- use it only when no better mapped or durable context exists

### Rule 3 — low-value micro-session recap should usually disappear

If recap comes from the low-value micro-session class defined in the session
boundary matrix:

- prefer suppression at write time
- if it survives, demote it aggressively at retrieval/injection time

### Rule 4 — explicit recap mode should be broad but honest

When the user asks for recap, the system may prefer:

- summary artifacts
- summary-like legacy rows
- workstream recap context

But it should still avoid irrelevant or wrong-thread summary injection.

### Rule 5 — recap can support orientation, not replace durable memory

Even in automatic injection mode, recap is useful when it helps answer:

- where this work left off
- what thread is active
- what broader effort the current prompt belongs to

But recap should usually be supporting context, not the whole meal.

## Indicators of Bad Recap

Recap should be treated as low-value in automatic injection when it has one or
more of these traits:

- generic process narration ("investigated / completed / next steps" with little durable content)
- weak linkage to current files, concepts, or workstream
- obvious observer-summary boilerplate
- no decision value, no locating value, and no outcome value
- merely restates a broad session without reducing scouting effort

## Indicators of Good Recap

Recap is valuable when it improves orientation by clearly summarizing:

- current workstream state
- active blockers
- major thread transitions
- what was just completed and what logically follows

Good recap should help automatic injection answer:

- what is this workstream about?
- what should happen next?
- what larger thread does this prompt belong to?

## Evaluation Metrics

Track recap policy using automatic-injection metrics, not just explicit summary
prompt quality.

### Suggested metrics

- top-5 recap share for non-summary topical queries
- top-5 unmapped recap share for non-summary topical queries
- top-5 recap share for explicit recap queries
- percentage of automatic injection packs where recap outranks more durable
  relevant memories
- percentage of micro-session recap memories that survive into injected context

### Desired direction

- non-summary recap share: **down**
- unmapped recap share: **down hard**
- explicit recap quality: **flat or up**
- wrong-thread recap intrusion: **down**

## Relationship to Current Code

The current implementation already contains early recap-control heuristics in
`search.ts` and `pack.ts`, including:

- recap detection
- observer-summary penalties
- explicit recap intent detection
- demotion of recap-heavy fallbacks

This policy exists to unify those heuristics into a principled rule set rather
than letting recap logic accrete as scattered special cases.

## First Implementation Slice

The first implementation slice should:

1. classify recap by session class from `fbpg`
2. formalize automatic-vs-explicit recap mode in one shared policy helper
3. apply stronger demotion to recap that is both:
   - low-value micro-session derived
   - and unmapped or observer-summary-like
4. add eval scenarios that show recap helps explicit summary requests without
   retaking over default injection

## Open Questions

- Should recap demotion be encoded numerically in one shared policy helper or as
  separate rank rules by mode?
- Should recap from durable work sessions still be limited to a maximum share of
  injected context?
- Should recap become its own first-class artifact distinct from durable summary
  and legacy summary-like rows?
