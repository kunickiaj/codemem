# Scoped Memory Retrieval Design

**Status:** Draft
**Date:** 2026-04-11
**Related docs:**
- `docs/plans/2026-04-07-memory-quality-model.md`
- `docs/plans/2026-04-07-recap-policy.md`
- `docs/plans/2026-03-12-adaptive-widening-personal-to-shared-retrieval.md`
- `docs/plans/2026-03-01-memory-explain-contract.md`
**Primary bead:** TBD

## Purpose

Define how codemem should represent and retrieve memories that operate at
different scopes:

- **project-scoped** memory tied to one repository or codebase
- **personal-scoped** memory tied to a specific user's working preferences
- **general-scoped** memory that captures a reusable lesson across projects

The goal is not just to add a `scope` field. The goal is to make retrieval more
reliable by ensuring the system can answer three different questions without
mixing them together:

1. what rules or facts apply to **this project**?
2. how does **this user** usually prefer to work?
3. what **generalizable lesson** is relevant here?

## Problem

Current memory retrieval largely assumes that durable memories live in one pool
and can be ranked mostly by textual relevance plus a small set of heuristics.

That breaks down once we want to preserve lessons such as:

- project-specific release or workflow rules
- user-specific working preferences
- cross-project debugging or tooling lessons

If these all live in one flat ranking pool, the system will eventually produce
bad retrieval behavior such as:

- a broad general lesson outranking a concrete project rule
- a user preference being treated like a universal truth
- noisy cross-project material polluting project-local injection
- useful general lessons being under-ranked because they lack exact project terms

In short:

> scope-free memory storage leads to scope-confused retrieval

## Core Principle

Memory retrieval should be **scope-aware, applicability-aware, and precedence-aware**.

That means:

- memories should declare or infer **what scope they belong to**
- retrieval should evaluate **when a memory applies**, not just whether it shares words
- ranking should enforce **scope precedence** so local truth beats generic truth

## Goals

1. represent project, personal, and general memory explicitly
2. retrieve candidates per scope rather than from one flat pool
3. add lightweight applicability metadata so retrieval can reason about when a
   memory matters
4. preserve project-local rules as stronger than user preferences, and user
   preferences as stronger than generic lessons
5. support cross-project durable lessons without letting them dominate unrelated work
6. create a design that can be implemented incrementally without reworking the
   entire memory system at once

## Non-goals

This design does **not** try to:

- solve memory authoring UX completely
- build a full ontology or knowledge graph first
- infer perfect applicability from raw text alone
- make every memory manually annotated with detailed rules
- replace existing search/rerank logic in one step

## Scope Model

### 1. Project scope

Project-scoped memory is true because of this repository, architecture, or local
workflow contract.

Examples:

- codemem uses Graphite stack workflow in this repo
- codemem release procedure requires branch/PR/tag ordering
- codemem recap policy demotes recap-like material in default injection
- sync visibility semantics for this project

#### Retrieval posture

- highest default precedence when the active project matches
- should dominate personal and general memories for local workflow or system behavior

### 2. Personal scope

Personal-scoped memory reflects a user's stable preferences across projects.

Examples:

- prefers terse PR bodies that still satisfy the template
- prefers stacked PRs when tooling supports them
- prefers direct execution over plan-only responses

#### Retrieval posture

- second precedence after project scope
- should never override explicit project policy
- useful when tailoring style, workflow, or defaults

### 3. General scope

General-scoped memory captures reusable lessons that apply across many projects.

Examples:

- optional extensions should fail closed during schema bootstrap
- in stacked PR workflows, submit the full stack or descendants may remain stale
- task-intent retrieval should not demote procedural memories

#### Retrieval posture

- lowest precedence of the three scopes
- should contribute when topical or operational pattern matches exist
- should not override specific project-local evidence when that exists

## Scope Classification Rules

### Project if

- the memory depends on repo-local architecture, naming, or workflow
- the memory references project-specific behavior that could be wrong elsewhere
- the memory is effectively a local rule or contract

### Personal if

- the memory expresses a user preference rather than a repository requirement
- it should follow the user across projects
- another contributor in the same project could reasonably prefer differently

### General if

- the memory describes a reusable lesson, pitfall, or debugging heuristic
- it remains useful when rewritten without project-specific baggage
- it would still be valid in many unrelated repositories

## Proposed Schema

This schema should be treated as a logical design target, not necessarily the
exact first database migration.

```ts
type MemoryScope = "project" | "personal" | "general";
type MemoryShareability = "private" | "team" | "public-safe";

interface ScopedMemoryMetadata {
  scope: MemoryScope;
  owner?: string;
  project?: string;

  applicability?: {
    activities?: string[];
    intents?: string[];
    tools?: string[];
    domains?: string[];
    repo_patterns?: string[];
    excludes?: string[];
  };

  precedence?: number;
  confidence?: number;
  shareability?: MemoryShareability;

  source?: {
    type: "observed" | "user-stated" | "derived" | "imported";
    reference?: string;
  };
}
```

### Minimal first slice

If we want the smallest useful implementation, we can start with:

- `scope`
- `owner`
- `project`
- `applicability.activities`
- `applicability.intents`
- `applicability.tools`
- `applicability.domains`
- `precedence`
- `confidence`
- `shareability`

## Applicability Metadata

Scope alone is not enough. A general memory can still be wrong for the current
turn, and a project memory can still be irrelevant to the immediate request.

Applicability metadata should remain lightweight and operational rather than
trying to encode deep world knowledge.

### Recommended applicability dimensions

#### Activities

What the agent is doing right now.

Examples:

- `implementation`
- `debugging`
- `review`
- `release`
- `docs`
- `stacked-pr`

#### Intents

What kind of question or request is being answered.

Examples:

- `what-next`
- `fix-failure`
- `implement`
- `plan`
- `explain`
- `recap`

#### Tools

Concrete tooling or platforms mentioned or inferred.

Examples:

- `git`
- `graphite`
- `sqlite`
- `cloudflare`
- `vitest`

#### Domains

Topical domain or subsystem categories.

Examples:

- `retrieval`
- `sync`
- `ui`
- `schema`
- `release`
- `memory-quality`

#### Repository patterns

Useful structural contexts.

Examples:

- `monorepo`
- `stacked-pr`
- `migration`
- `optional-extension`

#### Excludes

Simple negative constraints for obvious non-applicability.

Examples:

- `single-branch-workflow`
- `docs-only`
- `explicit-recap`
- `unrelated-project`

## How Applicability Should Be Produced

We should not require fully manual metadata authoring for every memory.

Use three sources of truth:

### 1. Explicit metadata

Used for high-value curated memories or imported policy docs.

Good for:

- project rules
- user preferences
- intentionally authored general lessons

### 2. Derived metadata

Inferred from memory text, kind, surrounding context, or source event.

Good for:

- tool mentions
- likely domain labels
- likely activity or intent class
- whether the memory behaves like a rule, preference, or lesson

### 3. Observed usefulness signals

Learned from retrieval behavior over time.

Good for:

- which memories repeatedly help in similar contexts
- which memories get retrieved but ignored
- which memories correlate with successful outcomes or fewer retries

## Retrieval Algorithm

The retrieval design should not query one flat memory pool.

### Step 1: infer current context

Build a lightweight context object for the current turn.

Example:

```json
{
  "project": "codemem",
  "user": "adam",
  "activity": "implementation",
  "intent": "what-next",
  "tools": ["git", "graphite"],
  "domains": ["retrieval", "memory-quality"]
}
```

### Step 2: retrieve candidates by scope bucket

Retrieve separately from:

- matching project memories
- matching personal memories for the active user
- matching general memories

This can still use hybrid search, but candidates should remain tagged by scope.

### Step 3: score applicability within each bucket

Boost for:

- matching activity
- matching intent
- matching tools
- matching domains
- matching repo patterns

Demote or suppress for:

- explicit excludes
- mismatched project/user scope
- contradictory context

### Step 4: merge with scope precedence

Recommended default priority:

- project: `300`
- personal: `200`
- general: `100`

Then compute something like:

```ts
finalScore =
  retrievalScore +
  applicabilityScore +
  scopePriority +
  confidenceWeight -
  contradictionPenalty;
```

### Step 5: dedupe and diversity cap

Do not return several nearly identical memories that all encode the same lesson.

Prefer:

- one project rule
- one personal preference
- one or two general lessons

instead of many adjacent copies of the same idea.

## Precedence Rules

### Rule 1 — project beats personal

A project-scoped workflow rule must beat a user preference when they conflict.

### Rule 2 — personal beats general

A user preference should beat a generic lesson when choosing style or defaults.

### Rule 3 — general only wins when specific scopes do not apply

General lessons should fill gaps, not overwrite local truth.

### Rule 4 — explicit applicability beats weak textual similarity

A memory with a clear activity/intent/tool match should outrank a fuzzier lexical
match with the wrong scope.

## Reliability Requirements

The system should be designed against several predictable failure modes.

### Failure mode 1 — generic pollution

A broad general lesson matches many turns and contaminates project-local retrieval.

#### Mitigations

- scope-bucket retrieval
- strong precedence
- excludes
- result diversity caps

### Failure mode 2 — useful general memory never appears

A transferable lesson is phrased differently and misses exact keyword matching.

#### Mitigations

- semantic retrieval within the general bucket
- derived tool/domain tags
- reinforcement from observed usefulness

### Failure mode 3 — personal preference looks like universal policy

A user habit is shown without its scope label and treated as system truth.

#### Mitigations

- preserve scope in metadata and explain output
- rank personal below project
- never strip scope during explanation/debugging

### Failure mode 4 — stale applicability metadata

Memories continue to rank as if they still apply even after workflows drift.

#### Mitigations

- track usefulness over time
- allow superseding or replacement links
- decay low-confidence inferred applicability

## Relationship to Existing Retrieval Work

This design should extend, not replace, recent retrieval policy work.

### Memory quality model

The memory quality model already distinguishes durable, recap, ephemeral, and
general/cross-project value classes. Scope design complements that model by
adding **where a memory should apply**, not just **how durable it is**.

### Recap policy

Recap policy already uses explicit retrieval modes such as default injection vs
explicit recap. Scope-aware retrieval should follow the same pattern: a relevant
scope and a relevant mode should both matter.

### Adaptive widening

Existing personal-to-shared widening logic shows that retrieval already benefits
from searching in ordered tiers rather than a single undifferentiated pool. This
proposal generalizes that idea to project/personal/general memory scopes.

## First Implementation Slices

### Slice 1 — explicit scope metadata and bucketed retrieval

Add:

- scope field
- owner/project fields where relevant
- fixed precedence between project, personal, general

Do not solve full applicability inference yet.

### Slice 2 — lightweight applicability tags

Add small tag families:

- activities
- intents
- tools
- domains

Use direct matching and simple boosts.

### Slice 3 — usefulness reinforcement

Track:

- retrieval frequency in matching contexts
- whether the memory was surfaced into final context
- whether it was later reinforced or ignored

### Slice 4 — memory explain/debug support

Extend explain/debug output to show:

- scope bucket
- applicability matches
- precedence contribution
- suppression reasons

## Open Questions

1. should personal-scoped memories live in the same store with metadata labels,
   or in a separate user-profile layer?
2. how much explicit authoring do we want before we rely on derived tags?
3. should general memories be retrieved by default, or only when project/personal
   buckets are weak?
4. how should we represent superseded general lessons without deleting useful history?
5. do we want separate write-time policy for promoting a memory from project to
   general scope after repeated reuse?

## Recommendation

Start small:

1. add **scope**
2. retrieve by **scope buckets**
3. merge with **fixed precedence**
4. add a small set of **applicability tags**
5. instrument **memory explain** before adding heavier inference

That gives us a reliable foundation for scoped retrieval without prematurely
building a full graph or policy engine.
