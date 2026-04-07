# Track 3: Injection-First Memory Policy

**Status:** Draft
**Date:** 2026-04-07

## Context

The merged 0.23.0 candidate stack fixed a severe sessionization and retrieval quality
problem:

- raw-event session reconciliation now repairs detached fragmented sessions
- retrieval no longer blindly ORs low-signal filler words into candidate queries
- recap-heavy fallbacks are demoted for non-summary retrieval
- legacy summary handling is more consistent on the read path

Those changes improve the system substantially, but they do not yet answer the
deeper policy question:

**What kinds of memories and summaries should automatic context injection prefer,
emit, suppress, or demote so codemem materially reduces rediscovery effort during
normal work?**

Track 3 is the policy/model follow-up to the merged retrieval and reconciliation
fixes.

## Core Objective

Codemem should reduce **rediscovery, scouting, and rework effort** during automatic
transform-hook injection by surfacing the prior decisions, outcomes,
implementation context, and troubleshooting knowledge most useful for the current
work.

Success is not defined primarily by explicit prompt-time Q&A. Explicit prompting
is useful for evaluation and debugging, but the product succeeds or fails on
whether automatic injection improves normal work without requiring the user to ask
for perfect recap prompts.

## Product Success Criterion

Automatic injection should help the agent more quickly:

- locate relevant prior code, files, modules, or workstreams
- understand previous decisions and the tradeoffs behind them
- reuse prior outcomes, successful fixes, and debugging paths
- avoid repeated context scouting and manual session archaeology
- make better next decisions with less rediscovery cost

Codemem should allow the agent to say, implicitly:

- "I already know where to look."
- "I already know what we decided and why."
- "I already know what worked last time."
- "I do not need to re-scout half the repo or revisit five old sessions first."

## Failure Modes

Track 3 should explicitly defend against these common failures:

- recap blobs dominate injected context instead of durable evidence
- wrong-session or wrong-thread summaries are injected because they look similar
- micro-session turn noise produces low-value summary artifacts
- the agent still has to manually scout files/sessions to find the real answer
- prior decisions are discoverable only as isolated snapshots without rationale,
  causality, or outcomes

## Scope

Track 3 consists of three related policy/model workstreams:

1. **Sessionization and summary emission policy** (`codemem-1y5q`)
2. **Recap emission and weighting policy** (`codemem-izlc`)
3. **Memory quality model and taxonomy evolution** (`codemem-euue`)

These are separate concerns, but they form one coherent track and should be
developed in order.

## Injection-First Design Principles

### 1. Automatic injection is the primary product path

The most important question is not "can codemem answer a direct prompt?" It is:

**Does codemem inject the right context during normal work without flooding the
prompt with recap sludge or wrong-session noise?**

### 2. Reduce rediscovery effort, not just retrieve relevant text

High-value memory is not merely text that matches a query. High-value memory
reduces effort in one or more of these ways:

- it helps find relevant code or implementation patterns faster
- it helps understand previous decisions and tradeoffs
- it helps reuse past outcomes and troubleshooting paths
- it helps orient the agent within the correct workstream/session lineage

### 3. Progressive disclosure beats giant memory dumps

Longer-term, codemem should favor a model where injection starts with a compact
index and expands only when deeper context is needed. Candidate index data may
include:

- title
- type/kind
- timestamp
- session/workstream hint
- compact rationale or outcome tags
- file/module or concept hints

Then the system can selectively fetch full observations, neighbors, related
decisions, or causal context.

### 4. Causality matters more than isolated snapshots

Useful memory should preserve more than a static fact. The system should favor
memories that help answer:

- what led to this decision?
- what changed because of it?
- what happened afterward?
- what work is downstream of this result?

### 5. Explicit recap requests and automatic injection are different modes

Some recap material is acceptable when the user explicitly asks for summary, but
too noisy for default automatic injection. Track 3 should keep those modes
distinct.

## Track 3 Workstream Definitions

### A. `codemem-1y5q` — Sessionization and Summary Emission Policy

#### Key Question

What should count as a meaningful work session, and when should a summary artifact
exist at all?

#### Desired Output

A policy matrix that distinguishes:

- micro sessions
- working sessions
- durable work sessions

For each class, define:

- whether to emit no summary, delayed recap, or durable `session_summary`
- what signals count as meaningful work
- how automatic injection should treat resulting artifacts

#### Why This Comes First

If session boundaries are mushy, recap policy and quality policy rest on sand.

### B. `codemem-izlc` — Recap Emission and Weighting Policy

#### Key Question

How should recap behave differently in automatic injection versus explicit recap
requests?

#### Desired Output

Rules for:

- when recap is allowed or suppressed at write time
- how recap is weighted/demoted at retrieval time
- how unmapped recap should behave
- how micro-session recap should be treated
- which metrics count as recap regression

#### Key Principle

Recap may be valid for `summary of X` while still being too dangerous for default
automatic injection.

### C. `codemem-euue` — Memory Quality Model and Taxonomy Evolution

#### Key Question

What kinds of memories deserve to exist and be prioritized because they reduce
rediscovery effort?

#### Desired Output

A model for memory categories such as:

- durable
- recap
- ephemeral
- general/cross-project

Evaluate them by:

- locating value (does this reduce code/context scouting?)
- decision value (does this preserve rationale/tradeoffs?)
- outcome value (does this preserve what worked/failed?)
- troubleshooting value (does this reduce repeated investigation?)
- future-decision value (does this help make better next choices?)

## Recommended Sequence

1. **`codemem-qd7h`** — investigate micro-session regression timeline and root
   causes so policy is evidence-based
2. **`codemem-1y5q`** — define session boundary and summary emission matrix
3. **`codemem-izlc`** — define recap policy and weighting for injection vs explicit
   recap
4. **`codemem-euue`** — formalize the broader memory quality/taxonomy model using
   outputs from the first two

## Track 3 Task Graph

Current concrete child tasks created from this track:

- `codemem-fbpg` — Define injection-first session boundary matrix
- `codemem-l92r` — Define recap policy for automatic injection vs explicit recap
- `codemem-gwez` — Define memory quality criteria around rediscovery reduction
- `codemem-24q2` — Add injection-first eval scenarios for Track 3

### Intended dependency flow

- `codemem-qd7h` informs `codemem-1y5q`
- `codemem-fbpg` is the first concrete output of `codemem-1y5q`
- `codemem-l92r` depends on the session matrix from `codemem-fbpg`
- `codemem-gwez` depends on the practical distinctions established in
  `codemem-fbpg` and `codemem-l92r`
- `codemem-24q2` should reflect and validate all of the above

## Evaluation Strategy

Track 3 should be evaluated primarily through automatic-injection usefulness,
not just explicit recall prompts.

### Questions to Answer

- Does codemem reduce code/context scouting for the next prompt?
- Does it surface prior decisions and tradeoffs quickly enough to help new
  decisions?
- Does it reduce repeated debugging and investigation effort when similar issues
  recur?
- Does it avoid flooding the prompt with low-value recap or wrong-session noise?

### Suggested evaluation classes

- locating relevant code or modules
- understanding prior decisions and rationale
- reusing prior outcomes and fixes
- troubleshooting recurrence or adjacent failures
- continuing an existing workstream without manual session archaeology

### Suggested metrics

- recap share in top injected context
- unmapped recap share in top injected context
- summary-only micro-session rate
- percentage of injected items with clear locating or decision value
- relative reduction in manual scouting for repeated or adjacent tasks

## Release Guidance

Track 3 is important, but it is not automatically a release blocker. The merged
0.23.0 candidate stack already fixes severe sessionization and retrieval issues.

Use Track 3 to shape post-release policy work unless dogfooding reveals a fresh
severe regression in automatic injection quality.

## Non-Goals

Track 3 does **not** yet require:

- a graph-native source of truth
- a full schema rewrite
- destructive retroactive cleanup of existing databases
- replacing current retrieval with a full knowledge graph implementation

Those are possible future exploration areas, but the current objective is to make
automatic injection materially better at reducing rediscovery effort.

## Future Directions

Once Track 3 policy stabilizes, codemem may benefit from:

- progressive disclosure retrieval
- graph-derived relationship context
- causal/neighbor expansion around observations
- file-path and concept-linked decision exploration

That work is explicitly separate from this policy draft and is currently tracked
as future exploration (`codemem-am33`).
