# Dual-Artifact Memory-Worthiness Policy

**Status:** Draft (refocused 2026-06-29)
**Date:** 2026-06-28
**Tracking:** `codemem-ovk2`
**Related:**

- `docs/plans/2026-04-06-memory-quality-taxonomy-design.md`
- `docs/plans/2026-04-07-track-3-injection-first-memory-policy.md`
- `docs/plans/2026-04-07-recap-policy.md`

## Refocus Note (2026-06-29)

An empirical audit of the live database changed this policy in one important way:
**`derived_fact` is an in-place classification/role applied to durable non-summary
observations, not a separately materialized duplicate row.**

The audit found `stored_derived_fact_share = 0.0%`, and the prototype derivation
pass (`runDerivePass` / `store.upsertDerivedFact`) mostly sentence-copied
already-durable non-summary observations into new rows with no synthesis. That
adds storage, sync, and dedup surface for no measured retrieval lift.

What changed:

- **Scrapped:** derived-fact materialization (generating new `derived_fact` rows
  from existing memories). This was a path, not a product requirement.
- **Kept:** the three-artifact *vocabulary* (`session_summary`, `derived_fact`,
  `telemetry`) as a classification/role over existing rows, plus role-based
  retrieval routing that already exists (`DURABLE_ROLE_BONUS`, recap penalties,
  `preferSummary`).
- **Redirected effort to:** observation extraction quality, summary quality
  classification, and empirical ranking/feed calibration.

Reference: claude-mem stores observations and session summaries as distinct
first-class artifacts composed at context time. It does not duplicate observations
into derived-fact rows. Codemem follows the same model: non-summary observations
are the durable layer, classified in place.

A future materialized `derived_fact` row is justified only when it performs real
multi-source synthesis (compressing/merging several source memories into stable
cross-session knowledge), not single-source sentence copying.

## Context

The earlier policy used one global `keep | demote | drop` decision for all memory
candidates. That was too blunt.

Recent inspection and review feedback exposed three problems:

- **Summary domination:** useful summaries can crowd out durable implementation
  knowledge in default/task/debug retrieval.
- **Telemetry bloat:** review pass notes, green CI/lint/test status, context-load
  notes, and bootstrap/runtime events can repeat until they look important.
- **Single-signal false negatives:** classifier shortcuts can drop real contracts
  because one phrase looks like telemetry.

The Codex M1/M2 feedback made the last problem concrete:

- **M1:** ordinary implementation contracts such as "handlers must return
  structured errors" are durable facts and must be kept.
- **M2:** validation/CI language can contain an embedded decision or contract; the
  telemetry wrapper should be suppressed, not the durable lesson.

The fix is not "delete summaries." The fix is to model different artifacts with
different storage and retrieval behavior.

## Goal

Separate memory output into three artifact classes:

1. `session_summary` — what happened
2. `derived_fact` — what future work should remember
3. `telemetry` — what merely occurred

Each artifact gets its own worthiness policy and retrieval role. This keeps recap
useful for handoff while protecting default injection from recap sludge and
telemetry sawdust.

## Artifact Classes

### `session_summary`

**Meaning:** what happened.

Session summaries preserve continuity, handoff context, chronology, and workstream
state. They answer:

- what was requested?
- what was investigated?
- what was completed?
- what was learned?
- what should happen next?

**Retrieval role:**

- preferred for explicit recap, catch-up, and continuation chronology
- useful as supporting context for task continuation
- not the primary source for topical implementation facts

Example:

```text
The session investigated viewer build failures, confirmed static assets were
missing, rebuilt the UI bundle, and left follow-up work to add a smoke test.
```

### `derived_fact`

**Meaning:** what future work should remember.

> **Implementation note (2026-06-29):** `derived_fact` is a *role/classification*
> applied to durable non-summary observations as they already exist. It is **not**
> a separately generated row. The durable layer is the non-summary observation
> itself; this class just marks and routes it. See the Refocus Note above.

Derived facts preserve durable knowledge captured in a session, review, debug
path, or implementation. They answer:

- what decision was made?
- what invariant or contract must be preserved?
- what failure mode or gotcha recurs?
- what implementation lesson prevents rediscovery?

Typical derived facts include:

- decisions and rationale
- implementation contracts
- source-of-truth locations
- gotchas and failure modes
- bugfix lessons
- durable user/project preferences not already in active docs

**Retrieval role:**

- preferred for default automatic injection
- preferred for topical, task, and debug retrieval
- supports recap when the user asks why something happened

Example:

```text
Viewer-server validation requires generated UI assets; run the UI build before
testing paths that expect packages/viewer-server/static/index.html.
```

### `telemetry`

**Meaning:** what merely occurred.

Telemetry records operational events and process status. It is useful in logs and
debug traces, but it is not durable memory unless it embeds a real lesson.

Examples:

- review completed with no blockers
- CI, lint, build, or tests passed
- context files were loaded
- a session/bootstrap/runtime initialized
- a command ran successfully with no reusable outcome

**Retrieval role:**

- default: suppressed from durable memory retrieval
- allowed in raw logs, traces, and debug/audit views
- promotable only when it contains an embedded durable lesson

Example to suppress:

```text
Lint passed and the reviewer found no blockers.
```

Example to extract:

```text
The test passed only after rebuilding UI assets, confirming viewer-server checks
depend on generated static files.
```

Store the derived fact; keep the bare pass status as telemetry only.

## Per-Artifact Worthiness

Worthiness is no longer one global decision. Each artifact class has its own
`store`, `store_demoted`, and `suppress` criteria.

### `session_summary` worthiness

| Decision | Criteria | Behavior |
|---|---|---|
| `store` | Coherent working-session recap with request, investigation, outcome, lesson, or next step. | Store as recap/continuity. Prefer in explicit recap. |
| `store_demoted` | Useful chronology but weak durable value, broad progress narration, or short-lived handoff state. | Keep for recap/support; demote in default/task/debug retrieval. |
| `suppress` | Micro-session noise, empty summary, wrong-thread recap, or boilerplate with no useful chronology. | Do not store as durable memory; keep only in raw logs if needed. |

A summary can contain derived facts. Do not make the whole summary primary durable
memory just because one sentence is durable. Extract the fact separately.

### `derived_fact` worthiness

| Decision | Criteria | Behavior |
|---|---|---|
| `store` | Contains a reusable decision, invariant, implementation contract, gotcha, bugfix lesson, locating hint, or durable preference. | Store and allow normal/default retrieval. |
| `store_demoted` | Possibly useful but weakly evidenced, overly broad, or mostly local to a short-lived workstream. | Store with lower retrieval weight until reinforced. |
| `suppress` | No future-actionable content after telemetry/summary wrapper is removed. | Do not create a derived fact. |

Derived facts should be concise and atomic. Prefer one durable rule over a full
session narrative.

Good derived facts:

- CLI handlers must return structured errors instead of throwing uncaught errors.
- Changing memory kinds requires coordinated updates to store, MCP, and UI
  presentation surfaces.
- Build validation that touches viewer static assets requires generated UI output.

Bad derived facts:

- The session completed successfully.
- Tests passed.
- Context was loaded before implementation.

### `telemetry` worthiness

| Decision | Criteria | Behavior |
|---|---|---|
| `store` | Rare. Telemetry itself is needed for an explicit audit/debug feature. | Store as telemetry/log data, not durable memory. |
| `store_demoted` | Operational status may help immediate handoff but has no durable lesson. | Keep only in debug/trace/recap support, never primary retrieval. |
| `suppress` | Review pass/no blockers, green CI/lint/test status, bootstrap/runtime notes, context-load notes, or routine command success. | Suppress from durable memory. |

Telemetry with embedded durable content must be split:

1. suppress or log the telemetry wrapper
2. store the embedded `derived_fact`

Example:

```text
CI passed after adding the generated asset check; viewer-server validation fails
when static/index.html is missing.
```

Stored fact:

```text
Viewer-server validation fails when static/index.html is missing, so UI assets
must be built before that validation path.
```

Suppressed telemetry:

```text
CI passed.
```

## Signal-Balance Principle

Suppression is allowed only when keep-signals are absent.

Classifiers must not early-return on a single negative phrase such as `tests
passed`, `CI green`, `review approved`, or `no blockers` before checking for
embedded durable content.

### Positive keep-signals

Keep or extract a `derived_fact` when text includes:

- `must`, `requires`, `contract`, `invariant`, `source of truth`
- `fails when`, `throws if`, `root cause`, `gotcha`, `regression`
- `decided`, `chosen because`, `tradeoff`, `non-goal`
- file/module/API names paired with a rule or outcome
- future-actionable structure: "when changing X, update Y"

### Negative suppress-signals

Suppress only when these appear without positive keep-signals:

- review telemetry: `no blockers`, `approved`, `no findings`, `re-reviewed`
- validation telemetry: `tests passed`, `lint passed`, `CI green`, `build
  succeeded`
- runtime/bootstrap: `loaded context`, `session started`, `agent initialized`
- generic process narration with no decision, failure, contract, or next action

### Required fixes

- **M1:** ordinary "must `<verb>`" implementation contracts must become
  `derived_fact`, even if phrased plainly.
- **M2:** validation or CI language with an embedded contract/decision must extract
  and store the contract/decision.

Default rule:

> If a candidate contains both telemetry and a durable contract, suppress the
> telemetry and keep the contract.

## Retrieval Routing

Retrieval mode decides which artifact class should lead.

| Mode | Preferred artifacts | Notes |
|---|---|---|
| default automatic injection | `derived_fact` first, selected `session_summary` support | Optimize for reduced rediscovery. |
| task continuation | `derived_fact` first, recent relevant summaries second | Use summaries for workstream orientation. |
| debug/troubleshooting | `derived_fact` first | Prioritize failure modes, fixes, and gotchas. |
| explicit recap/catch-up | `session_summary` first, `derived_fact` support | Recap-first is expected here. |
| audit/debug traces | `telemetry` allowed | Keep separate from durable retrieval. |

This reconciles with the recap policy:

- recap is valid for `summary`, `catch me up`, and `what happened`
- recap is dangerous when it dominates default automatic injection
- summary domination should be fixed by routing, weighting, and evals, not by
  deleting useful summaries

## claude-mem Learnings to Borrow

Borrow these ideas:

- **Artifact split:** first-class observations/facts are distinct from session
  summaries.
- **Structured summaries:** summaries should expose stable fields:
  - `request`
  - `investigated`
  - `learned`
  - `completed`
  - `next_steps`
  - `notes`
- **Skip/suppress sentinel:** extraction should be able to say "nothing durable
  here" instead of manufacturing a memory.
- **Output validation:** generated artifacts should be schema-checked before
  storage.
- **Search → timeline → hydrate:** retrieval can start with compact matches, then
  expand to surrounding timeline and full observations when needed.

Avoid copying these weaknesses:

- keep-everything storage with no retention pressure
- weak distinction between durable memory and raw event history
- letting logs become the default retrieval corpus
- treating summaries as a substitute for extracted durable facts

## Upgrade Safety

Upgrade safety is mandatory. This policy must be implemented without making old
databases unreadable or unsyncable.

### Schema changes

Use additive schema evolution only.

Follow the existing `db.ts` pattern:

- `SCHEMA_VERSION` marks the newest local schema.
- `MIN_COMPATIBLE_SCHEMA` gates incompatible readers.
- migrations add nullable/defaulted fields before behavior depends on them.

Allowed additions:

- nullable/defaulted artifact type fields
- nullable/defaulted artifact role/status fields
- nullable extraction/version markers
- indexes that do not change existing row meaning

Avoid:

- destructive rewrites
- required non-null fields with no default for legacy rows
- hard deletion during migration
- changing existing kind semantics in place

### Version-marker gating

New behavior should be gated by explicit version markers.

Examples:

- only apply artifact-specific routing when the row has an artifact marker
- only trust derived-fact extraction when the extractor version is present
- treat older rows as `unknown`/`legacy`, not as invalid

### Legacy rows

Rows without artifact type are still valid.

Default behavior:

- remain retrievable
- remain syncable
- infer `unknown`/`legacy` artifact status on read
- apply conservative routing heuristics
- never assume absence of artifact type means telemetry

Legacy summaries can map to recap behavior. Legacy durable-looking rows can still
rank as durable when positive signals are present.

### Sync compatibility

Forward/back sync compatibility must hold during rollout:

- older clients should not lose rows because they do not understand artifact
  fields
- newer clients should tolerate rows produced by older clients
- unknown artifact values should degrade safely to `unknown`/`legacy`
- sync should not require all peers to migrate simultaneously

### In-place classification, not materialization

`derived_fact` is a role applied to existing durable observations. There is no
generated derived-fact row to keep idempotent.

Rules:

- classification must be re-runnable and deterministic: re-classifying a row must
  not create new rows or mutate source content
- classification/routing must read from stable signals (kind, role, artifact
  markers, extractor version) and degrade to `unknown`/`legacy` when absent
- a future materialized derived-fact row is in scope only when it performs real
  multi-source synthesis; such a pass must be idempotent and carry source/version
  metadata to detect repeats, but it is explicitly **not** required by this policy
- classification is reversible by ignoring the artifact role, never by deleting
  source observations or summaries

### No hard delete

No historical cleanup path starts with deletion.

Safe first steps:

- label
- report
- demote
- suppress from default retrieval
- expose debug reasons
- compare before/after evals

Hard deletion is out of scope for this policy.

## Evaluation

Behavior-changing work must include before/after evaluation. Unit tests prove the
mechanics; evals prove retrieval quality.

### Required gates

Measure at least:

1. **Summary domination**
   - share of `session_summary`/recap-like rows in top default/task/debug results
   - expected direction: down for non-recap modes

2. **Telemetry share**
   - share of review/validation/bootstrap telemetry in top default/task/debug
     results
   - expected direction: down hard

3. **Explicit recap quality**
   - recap answers still include coherent chronology and next steps
   - expected direction: flat or up

4. **Derived-fact precision**
   - top derived facts are real decisions, contracts, gotchas, or bugfix lessons
   - expected direction: up

5. **Upgrade safety**
   - pre-change database snapshots remain readable, retrievable, and syncable
   - legacy rows without artifact markers remain available

### Regression examples

Tests/evals should include the M1/M2 cases:

```text
Handlers must return structured errors instead of throwing uncaught exceptions.
```

Expected: stored as `derived_fact`.

```text
CI passed after confirming handlers must return structured errors.
```

Expected: suppress `CI passed`; store the embedded handler contract.

### Baseline rule

Any PR that wires artifact classification into capture, search, pack, recap,
distillation, or sync must capture a baseline before the behavior change and
compare the candidate behavior against it.

## Non-Goals

This policy does not require:

- a full schema rewrite
- a new memory-kind ontology
- materializing derived-fact rows from existing memories
- hard deletion of historical memories
- replacing explicit recap mode
- treating all summaries as bad
- treating all telemetry as durable memory
- solving session boundary quality by itself
- auto-writing project/user context files

## Supersedes

This document supersedes the prior single global `keep | demote | drop`
worthiness framing.

The replacement model is:

- classify artifact type first
- apply worthiness within that artifact class
- extract durable facts from summaries/telemetry when present
- route retrieval by mode instead of deleting useful recap
