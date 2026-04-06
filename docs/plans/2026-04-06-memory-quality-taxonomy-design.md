# Memory Quality Model & Taxonomy Evolution Design

**Status:** Decision
**Date:** 2026-04-06

## Context

Recent retrieval and pack-quality work surfaced a broader memory-model problem:

- retrieval was overvaluing recap-like summaries over durable detail
- `change` was overloaded and polluted by summary-like rows
- sessions were often micro-turn artifacts rather than human-scale work sessions
- project scoping data quality was uneven
- the store mixed durable knowledge, continuity/handoff recap, and low-value
  procedural residue into one retrieval pool with insufficient distinction

Real database inspection confirmed these issues are not fixture-only artifacts:

- active `change` memories and `session_summary` memories both exist at large scale
- legacy summary rows exist as `change` + `metadata.is_summary = true`
- many summary-producing sessions are under one minute long
- request/completed/learned recap text is heavily represented in active memory

This document defines the recommended memory-quality model before any large
retroactive remediation work is attempted.

## Problem Statement

codemem currently uses memory kinds as both:

1. a description of what happened
2. an implicit signal for how that memory should behave in retrieval

That is not sufficient.

The current system needs to distinguish between:

- continuity/handoff recap
- durable project knowledge
- procedural or low-value residue
- reusable cross-project/general knowledge

Without that distinction, retrieval quality degrades and remediation becomes
guesswork.

## Goals

- define an evidence-backed memory-quality model that fits the current product
- avoid a large disruptive taxonomy rewrite
- provide a clean conceptual target for future remediation of existing DBs
- support better retrieval behavior for recap, topical recall, debugging, and
  continuation queries
- define how candidate rule sets can be evaluated against a real DB snapshot

## Non-Goals

- full immediate schema redesign
- immediate destructive cleanup of existing databases
- introducing a large new memory-kind ontology
- solving all sessionization/tool boundary problems in this design alone

## Design Principle

**Keep memory kinds mostly stable, but add a distinct concept of memory role.**

Kinds describe **what the memory is about**.

Roles describe **how the memory should behave in retrieval, retention, and
remediation**.

This keeps the model expressive enough to fix the real problem without creating
a taxonomy explosion.

## Recommended Model

### Two-axis memory model

#### Axis 1: subject kind (existing or near-existing)

- `decision`
- `bugfix`
- `discovery`
- `feature`
- `refactor`
- `change`
- `exploration`
- `session_summary`

#### Axis 2: memory role (new conceptual layer)

- `recap`
- `durable`
- `ephemeral`
- `general`

Roles do not need to be persisted as a new database column immediately. They may
start as derived evaluation/remediation labels, then become persisted later if
the evaluation data justifies it.

## Role Definitions

### 1. `recap`

Purpose:

- continuity
- handoff
- broad catch-up context

Examples:

- `session_summary`
- legacy `change` rows with `metadata.is_summary = true`

Behavior:

- useful for broad recap queries (`catch me up`, `summary`, `what happened`)
- useful as pack Summary section support context
- should not dominate issue-specific recall or troubleshooting retrieval

### 2. `durable`

Purpose:

- knowledge worth recalling later as a primary answer

Typical kinds:

- `decision`
- `bugfix`
- strong `discovery`
- meaningful `exploration`
- some non-generic `change` rows if they carry real durable value

Behavior:

- preferred for topical recall queries
- preferred for debugging/troubleshooting similarity queries
- stronger long-term retrieval weight than recap/ephemeral memory

### 3. `ephemeral`

Purpose:

- contextual residue with low long-term value

Examples:

- generic micro-session recap
- repetitive request/completed summaries
- weakly specific `change` rows
- procedural notes with little retrieval value outside the immediate moment

Behavior:

- lower retrieval weight
- candidate for deactivation, demotion, or aggressive filtering during
  remediation

### 4. `general`

Purpose:

- knowledge reusable across projects, not tightly bound to one repo/session

Examples:

- reusable debugging patterns
- toolchain gotchas
- durable infra or workflow lessons that should not be trapped in one project

Behavior:

- should not flood project-local retrieval by default
- should be available when project-local evidence is weak or the query is broad
  enough to justify cross-project knowledge

## Why This Model

### Why not keep the current system unchanged?

Because the evidence already shows the current system cannot cleanly separate:

- recap memory from durable memory
- procedural residue from useful knowledge
- summary behavior from top-result relevance

### Why not redesign kinds completely?

Because a full taxonomy rewrite would:

- create migration ambiguity
- require large observer prompt changes
- make remediation much riskier
- overfit theory before evaluating it against real DB data

The role model solves the real problem with less upheaval.

## Recommended Role Mapping Heuristics

These heuristics are intended first for evaluation and later for remediation or
runtime weighting.

### Canonical recap mapping

- `session_summary` → `recap`
- legacy `change` rows with `metadata.is_summary = true` → `recap`

### Durable-first mapping

Default strong candidates:

- `decision`
- `bugfix`
- `discovery`
- `exploration`

Conditional durable candidates:

- `change` with strong topical specificity, useful structured fields, or durable
  lessons
- `feature` / `refactor` when query overlap is high and the memory is not just a
  recap surrogate

### Ephemeral candidates

Likely candidates include:

- generic `change` rows
- request/completed recaps from micro-sessions
- repetitive memory clusters with minimal additional signal
- low-specificity summaries with little durable content beyond procedural recap

### General candidates

Do not promote these aggressively by default. Candidate heuristics may include:

- weak project coupling
- repeated usefulness across multiple projects
- broadly reusable tool/process/debug lessons

This should begin as an evaluation label, not an immediate storage rewrite.

## Retrieval Implications

### Broad recap queries

Examples:

- `catch me up`
- `summary`
- `what happened`

Preferred order:

1. `recap`
2. selected `durable` support context

### Topical recall queries

Examples:

- `what did we decide about oauth`
- `how did we fix the callback issue`

Preferred order:

1. `durable`
2. `recap` as support
3. `ephemeral` only if strongly relevant and no better context exists

### Debugging / troubleshooting similarity queries

Examples:

- `have we seen this error before`
- `what fix worked for this failure`

Preferred order:

1. `durable`
   - especially `bugfix`, `decision`, `discovery`, `exploration`
2. `recap` only as contextual support

This use case should likely evolve into either:

- stronger recall heuristics for debugging/failure terms, or
- a dedicated problem-pattern retrieval mode

### Task / continuation queries

Examples:

- `what should we do next about auth`
- `continue the viewer health work`

Preferred order:

1. actionable `durable` / implementation memories
2. `recap` only as context
3. `ephemeral` should not outrank relevant actionable memory

## Long-Term vs Short-Term Memory

The recommended role model provides a practical bridge without requiring a new
schema immediately.

- short-term approximation: `recap` + `ephemeral`
- long-term approximation: `durable` + some `general`

This is sufficient for evaluation and remediation planning. A future persisted
retention tier can be added later only if the evidence supports it.

## Project-Local vs Cross-Project / General Knowledge

The current system is heavily project-scoped by default, but real DB inspection
showed that project labeling quality is imperfect and that cross-project/general
knowledge is not modeled distinctly.

Recommended approach:

- keep project-local retrieval as the default behavior
- introduce `general` as a conceptual evaluation/remediation role first
- only promote general knowledge into runtime retrieval once evaluated against
  snapshot-based benchmarks

Do not immediately hard-split the schema around project-local vs general
knowledge. That would be premature.

## Observer and Sessionization Implications

Real DB evidence showed that many summary-producing sessions are under one
minute, indicating micro-session or turn-like capture rather than human-scale
work sessions.

Implications:

- recap output quality is influenced by sessionization/tool boundaries
- micro-session summaries are likely a major source of `ephemeral` recap
- observer model quality matters, but model choice alone will not fix taxonomy
  or retrieval contract issues

This design does not attempt to solve sessionization immediately. Instead, it
defines a model that can tolerate current inputs while giving remediation a sane
target.

## Retroactive Remediation Implications

This design should directly shape the later remediation plan.

### Safe first-pass remediation targets

- normalize legacy summary representation conceptually (`change + is_summary` →
  recap-equivalent)
- identify recap-like `change` rows that should not behave like durable change
  memory
- identify low-value/repetitive `ephemeral` candidates for deactivation or
  demotion
- improve project normalization where values are empty, path-like, or clearly
  garbage

### Deferred remediation work

- destructive deletion of historical memories
- aggressive auto-merging of near-duplicate rows without strong evidence
- large-scale reclassification into a brand-new kind ontology

## Snapshot Evaluation Framework

Before retroactive remediation, candidate rules should be tested against one or
more real DB snapshots.

### Inputs

- local developer DB snapshot
- larger work-machine DB snapshot (if available and safe to inspect)

### Candidate rule families

Examples:

- reinterpret legacy summary rows as `recap`
- demote recap-like generic `change` rows
- infer `durable` from kind + specificity + structure
- infer `ephemeral` from micro-session context + genericity + repetition
- infer `general` conservatively for weakly project-bound durable memories

### Evaluation dimensions

#### 1. Composition metrics

- counts per inferred role
- counts of recap-like summaries by representation
- `change` split into recap-like vs durable-like vs ephemeral-like
- duplicate/repetition cluster counts
- project quality distribution

#### 2. Retrieval probes

Run realistic query suites across snapshot data:

- broad recap
- topical recall
- debugging/troubleshooting similarity
- task/continuation
- weak-query + working-set
- cross-project/general-style queries

#### 3. Before/after comparison

Measure whether candidate rules:

- reduce generic summary dominance
- improve durable detail retrieval
- improve debugging-like recall
- preserve useful catch-up behavior
- avoid over-pruning

### Recommended evaluation principle

Use snapshot-driven measurement before changing historical data. The question is
not whether a remediation rule looks clean on paper, but whether retrieval gets
better on realistic data.

## Recommended Roadmap

### Phase 1: design and role inference

- adopt this role model conceptually
- build an evaluation harness that infers roles on snapshot data
- measure rule candidates before touching historical data

### Phase 2: runtime weighting / retrieval alignment

- use the inferred role model to shape retrieval weighting where justified
- keep backward compatibility with current stored kinds while proving the rules

### Phase 3: remediation planning

- design dry-run tooling for historical DB remediation
- only propose destructive or irreversible cleanup after role inference and
  retrieval impact are understood

## Decision

Adopt a role-based memory-quality model while keeping the existing kind taxonomy
mostly intact.

### Recommended roles

- `recap`
- `durable`
- `ephemeral`
- `general`

Use this model as the design basis for:

- future retrieval refinement
- snapshot-based evaluation
- retroactive DB remediation planning

This is the smallest model that addresses the actual observed problems without
creating a taxonomy circus. 🔥
