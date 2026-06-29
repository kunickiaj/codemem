# Derived-Fact Derivation Design

**Status:** Deferred / superseded (2026-06-29) — see refocus note below
**Date:** 2026-06-29
**Tracking:** `codemem-ovk2`
**Related:**

- `docs/plans/2026-06-28-memory-worthiness-policy.md` (dual-artifact policy)
- `docs/plans/2026-04-06-memory-quality-taxonomy-design.md` (role taxonomy)
- `docs/plans/2026-04-07-track-3-injection-first-memory-policy.md` (injection-first)
- `docs/plans/2026-04-07-recap-policy.md` (recap vs default injection)
- `codemem-ovk2.10` (classifier rework — sibling)
- `codemem-ovk2.12` (retrieval routing — sibling)
- `codemem-ovk2.7` (eval harness + baseline)

## Refocus Note (2026-06-29) — read first

**This design is deferred. The derivation/materialization pass it specifies was
prototyped and then scrapped.** It is retained only as the reference bar that any
future materialized derived-fact pass must clear.

Why it was deferred, from an empirical audit of the live database:

- `stored_derived_fact_share = 0.0%` — no materialized derived facts existed in
  practice.
- The prototype pass (`runDerivePass` / `store.upsertDerivedFact`, originally
  PR #1301) mostly **sentence-copied already-durable non-summary observations**
  into new rows. That is duplication, not synthesis.
- It added storage, sync (`dedup_key`), and dedup surface for **no measured
  retrieval lift**. The retrieval-routing boost built on top of it (PR #1302)
  became dead code once materialization was abandoned.
- Reference model: claude-mem stores observations and session summaries as
  distinct first-class artifacts composed at context time. It does not duplicate
  observations into derived-fact rows.

What replaced it (see `docs/plans/2026-06-28-memory-worthiness-policy.md`,
Refocus Note): **`derived_fact` is an in-place classification/role over durable
non-summary observations, not a materialized duplicate row.** The durable layer
is the non-summary observation itself.

**The bar for reviving this design:** a materialized derived-fact row is justified
only when it performs real **multi-source synthesis** — compressing or merging
several source memories into stable cross-session knowledge that does not already
exist as a single observation — and only when an eval demonstrates measurable
retrieval lift over in-place classification. Single-source sentence copying is
explicitly out of scope.

The remainder of this document (idempotency model, dedup, provenance/trust
inheritance, tombstone handling, claim-key stability) remains a sound reference
for that future synthesis pass, but none of it is currently implemented or
scheduled.

### Required corrections before revival (from review)

Code review of this design surfaced concrete defects that any future
materialization implementation MUST fix. They are captured here so a revival does
not re-introduce them. None are actionable now (no code exists), but each is
blocking for the eventual `upsertDerivedFact`/derive helper:

1. **Reuse `store.remember` side effects in the insert helper.** A direct insert
   that writes only `memory_items.dedup_key` + a replication op skips side
   effects `store.remember` performs: `populateMemoryRefs`
   (`packages/core/src/store.ts`) which fills the `memory_file_refs` /
   `memory_concept_refs` junction tables, and vector enqueueing. Without them,
   derived rows carrying `files_read`/`files_modified`/`concepts` are invisible to
   the indexed locator queries in `ref-queries.ts`, and have no embeddings.
   Requirement: the derived helper MUST share the `remember` pipeline or
   explicitly perform every equivalent side effect (refs + vectors).

2. **Add provenance to the dedup lookup, not just `scope_id`.** `resolveProjectScope`
   can assign the same `scope_id` to private and shared memories from one repo
   (git remote/cwd take precedence over `workspace_id`). A `claim_key` lookup
   scoped only by `scope_id` can union a private derivation into an existing
   *shared* derived fact. Requirement: include the inherited
   `visibility`/`workspace_id` (provenance tuple) in both the lookup and the merge
   predicate before updating an existing derived fact. (Was flagged P1.)

3. **Stamp the local clock device on cross-peer provenance unions.** When peer B
   unions new provenance into a derived fact originally created on peer A, a
   metadata update can leave `metadata_json.clock_device_id` = A while
   `recordReplicationOp` runs on B. `recordReplicationOp` prefers the stored
   metadata clock device over `opts.deviceId`, and inbound scope validation
   rejects ops whose `device_id` ≠ `clock_device_id`, so the op is dropped.
   Requirement: stamp `meta.clock_device_id = this.deviceId` (or pass
   `clockDeviceId`) before recording the op, matching existing store mutations.

4. **Demote/mark the old row when superseding.** Writing only a `supersedes`
   pointer on the new row leaves the stale row active; any routing that prefers
   active `artifact_class = "derived_fact"` rows keeps boosting the superseded
   fact unless every read does a reverse `supersedes` scan. Requirement: mark the
   old row with a superseded/demotion marker (stable import key + replication) or
   otherwise exclude it from derived-fact ranking.

5. **Qualify no-finding outcomes / next-step phrasing if reusing the classifier.**
   Any extraction gating that reuses `classifyMemoryWorthiness` inherits the
   precision rules now hardened in `memory-quality.ts` (no-finding investigations
   demote; personal/next-step modals are not contracts). A revival MUST keep those
   guards rather than re-loosening them.

## Context

The dual-artifact policy (`docs/plans/2026-06-28-memory-worthiness-policy.md`)
splits memory into three artifact classes: `session_summary` (what happened),
`derived_fact` (what future work should remember), and `telemetry` (what merely
occurred). The policy already describes *what* a derived fact is and how it
should be routed. It does not describe *how* derived facts get produced,
identified, deduped, or consumed downstream. This document fills that gap.

The current ingest path (`packages/core/src/ingest-pipeline.ts`) emits two
artifact shapes from `observeStructuredOutput`:

1. typed observations — stored via `store.remember()` with one of
   `discovery | change | feature | bugfix | refactor | decision | exploration`
   (see `ALLOWED_KINDS` in `ingest-pipeline.ts` and `ALLOWED_MEMORY_KINDS` in
   `packages/core/src/store.ts`).
2. session summaries — stored via `store.remember()` with kind
   `session_summary` and `metadata.source === "observer_summary"` (see the
   `summaryToStore` branch and `supersedePriorObserverSummaries`).

Observations conflate two roles today: they can be durable contracts (good
derived-fact candidates) and they can be ephemeral progress narration
(telemetry-shaped). The classifier in `packages/core/src/memory-quality.ts`
(`classifyMemoryWorthiness`) tries to label `keep | demote | drop` *after the
fact*, which is the framing the dual-artifact policy explicitly supersedes.

The baseline captured under `codemem-ovk2.7` shows recap rows sitting at ~43%
of active memory and telemetry dominating telemetry probes. Generating a
distinct, retrieval-preferred `derived_fact` artifact is the only path to
shifting those numbers without deleting useful summaries.

There is no `distill.ts` in this worktree yet — Distill / `selectDistillCorpus`
is an unmerged downstream consumer. This design treats Distill as a forward
seam and specifies what it should consume, not what it currently does.

## Goal

Define a derivation pass that:

- Produces `derived_fact` artifacts that are durable, atomic, and
  retrieval-preferred for default/task/debug modes.
- Leaves `session_summary` artifacts untouched and intact — recap quality must
  not regress.
- Reuses `memory_items` without a schema rewrite.
- Is idempotent across re-runs and extractor-version changes.
- Records provenance back to source rows so Distill, retrieval routing, and
  audits can reason about grounding.
- Is sync-compatible with peers that do not understand derived facts.
- Lets Distill (forthcoming) prefer derived facts as its corpus.

## When To Derive: inline, batch, or both

The dual-artifact policy notes that observer-time extraction is correct for
session summaries but tends to over-record durable claims. This design adopts
a **two-pass model**, with the inline pass operating in a strict tag-only
mode and the batch pass doing the real derivation work.

### Pass A — Inline tagging at ingest (lightweight)

Runs inside `ingest()` immediately after `observationsToStore` and
`summaryToStore` are built, before `store.db.transaction(...)` persists them.

Inline responsibilities:

- For each observation already destined for `store.remember`, evaluate
  `classifyMemoryWorthiness`-style positive keep-signals on
  `(title, narrative, body)`.
- When the observation is a strong durable candidate, attach a
  `metadata.derivation` block (see *Representation*) describing it as a
  candidate, **without** creating a separate row.
- Annotate the session_summary row with a counter of candidate facts
  (`metadata.derivation.candidate_count`) so the batch pass can prioritize
  sessions with high candidate density.

Inline does **not**:

- Create new `memory_items` rows tagged `derived_fact`.
- Mutate observation text or kind.
- Suppress observations.
- Run any LLM call beyond what the observer already produced.

This keeps the hot path cheap, deterministic, and safe to ship before the
batch pass exists. It also gives the batch pass an indexable signal
(`json_extract(metadata_json, '$.derivation.candidate') = 1`) instead of
forcing it to re-scan every row.

### Pass B — Batch derivation (the real pass)

Runs out of band (maintenance worker, scheduled job, or explicit
`codemem derive run`). This is where derived facts are actually created.

Batch responsibilities, in order:

1. **Select corpus** — pull recent (or unprocessed-since-extractor-version)
   sessions with at least one candidate observation or one summary whose
   `narrative`/`completed`/`learned` text matches positive keep-signals.
2. **Cluster sources** — group observations + the session_summary for a
   session into a per-session bundle. The bundle keeps `narrative`, `facts`,
   `concepts`, `files_modified`, and the structured summary fields available
   together so a derivation step can ground each claim in something concrete.
3. **Extract atomic claims** — produce one derived fact per durable rule,
   contract, gotcha, locator-with-reason, or bugfix lesson. Multi-claim
   sources fan out to multiple derived rows.
4. **Dedup against existing context** — for each candidate, compute the
   identity key (see *Dedup*) and reject if a live derived fact with the
   same key already exists for the same scope.
5. **Persist** — call `store.remember(sessionId, "discovery", title, body, …)`
   (or `"decision"` / `"bugfix"` depending on claim type) with metadata
   markers that make the row a derived fact. Kind stays in the legacy allow
   list so older peers still accept it during sync (see *Upgrade Safety*).
6. **Record provenance** — link the new row to its source memory ids and
   session id via metadata.
7. **Optionally demote source observations** — only annotate them as
   `metadata.derivation.superseded_by_derived = <new_id>`; never delete or
   soft-delete originals. Retrieval routing (ovk2.12) decides what to do
   with the annotation.

### Why prefer batch over pure-inline

Validate the policy doc's lean: batch wins, but inline still does work.

- **Observer over-records.** Inline-only derivation amplifies that — every
  marginal observation would race to become a "fact." Batch can apply a
  higher confidence bar because it sees more context.
- **Cross-session dedup is impossible inline.** `store.remember` already
  performs title-based same-session and cross-session dedup
  (`findExistingDuplicateMemory`), but it uses `getMemoryDedupMatchText`,
  which is title-normalization. Derived-fact dedup needs claim-level
  identity (see *Dedup*), which requires looking at existing rows of the
  same artifact class. That is cheap in batch, expensive inline.
- **Clustering helps.** Many durable facts only become atomic after pulling
  together `obs.narrative` + `obs.facts[]` + summary `learned`/`completed`.
  Inline sees one observation at a time.
- **Determinism.** A batch job keyed on `(session_id, extractor_version)`
  is trivially re-runnable; inline derivation muddies the audit trail.
- **Cost and latency.** Ingest is on the user's critical path. Batch is not.

### Why also keep an inline tagging step

- It costs effectively nothing because the observer output is already in
  memory.
- It gives the batch pass an indexable shortlist instead of forcing it to
  rescan history.
- It records the "no candidate here" signal too, which the batch pass can
  trust as a fast skip instead of re-evaluating signal balance from scratch.

## Derived-fact representation (no schema rewrite)

Derived facts live in `memory_items`. The schema (`packages/core/src/schema.ts`)
already exposes everything needed: `kind`, `title`, `subtitle`, `body_text`,
`facts` (nullable JSON text), `narrative` (nullable TEXT), `concepts`
(nullable JSON text), `files_read`/`files_modified` (nullable JSON text),
`metadata_json`, `active`, `dedup_key`, `import_key`, `rev`, `scope_id`,
`visibility`, `workspace_id`, `actor_id`, `origin_device_id`, `origin_source`,
`trust_state`, `deleted_at`, `project`. No new column is required.

### Identification

A derived-fact row MUST be identifiable from metadata alone, with no kind
change required. The marker is the `derivation` block in
`metadata_json`:

```json
{
  "derivation": {
    "artifact_class": "derived_fact",
    "extractor": "derive-batch",
    "extractor_version": "v1",
    "claim_type": "implementation_contract",
    "claim_key": "<see Dedup>",
    "candidate": true,
    "source": {
      "session_ids": [12345],
      "memory_ids": [678, 690],
      "summary_memory_id": 701
    },
    "grounding": {
      "concepts": ["viewer-server", "static-assets"],
      "files": ["packages/viewer-server/src/index.ts"],
      "must_appear_tokens": ["packages/viewer-server", "static/index.html"]
    },
    "derived_at": "2026-06-29T00:00:00.000Z",
    "confidence": 0.7
  }
}
```

### Kind choice

Choose `kind` from the **existing** `ALLOWED_MEMORY_KINDS` set
(`discovery | change | feature | bugfix | refactor | decision | exploration`)
to keep sync working with older peers (see *Upgrade Safety*).

Mapping:

- contract / invariant / source-of-truth → `decision`
- gotcha / failure-mode / regression / bugfix lesson → `bugfix`
- new locator-with-reason / "look in X because Y" → `discovery`
- non-goal / preferred-approach / tradeoff → `decision`

The artifact class is *not* encoded in `kind`. `kind` stays a syntactic
hint; `metadata.derivation.artifact_class` is the authoritative classifier.
This intentionally avoids adding a new `kind = "derived_fact"` value, which
would (a) require coordinated updates across `store.ts`, `mcp-server`, UI
feed, and (b) be rejected by older `validateMemoryKind` on peers running
the previous TS.

### Title and body

- `title` — one-sentence durable rule. Past tense or imperative, ≤120 chars.
  Examples (from policy doc): "Viewer-server validation requires generated
  UI assets" or "CLI handlers must return structured errors".
- `subtitle` — optional file or component scope.
- `body_text` — body of the rule + minimal justification + grounding refs.
  Multi-paragraph allowed but discouraged; prefer atomic facts.
- `narrative` — one short sentence (used by ranking).
- `facts` — JSON array containing the single atomized claim line(s); reuses
  the existing structured-facts column already populated by observer output.
- `concepts` — concept tags carried from sources; reuses the existing
  `memory_concept_refs` projection.
- `files_read` / `files_modified` — carried from sources so file refs are
  populated for retrieval (`populateMemoryRefs` runs inside `store.remember`).
- `confidence` — set from `derivation.confidence` (default 0.7); lower than
  observer-derived `0.5` ONLY if grounding is weak.

### Provenance

Provenance is split across the standard provenance columns
(`actor_id`, `origin_device_id`, `origin_source`, `trust_state`) and the
`metadata.derivation.source` block.

- `origin_source = "derive-batch"` so retrieval and UI can distinguish
  derived facts from observer output (`origin_source = "observer"` or
  `"observer_summary"`).
- `metadata.derivation.source.session_ids[]` — sessions the claim came from.
- `metadata.derivation.source.memory_ids[]` — observation rows that
  contributed.
- `metadata.derivation.source.summary_memory_id` — the session_summary row
  the claim was extracted from, if any.
- Scope/visibility/workspace inherit from the source session row through
  the existing `resolveProvenance` and `resolveSessionScopeId` paths in
  `store.remember`.

This makes it possible to render "from session N" links and to back out
derived facts wholesale if a future evaluation says the extractor regressed.

## Dedup / idempotency identity key

Derived-fact dedup must be stronger than the title-based dedup used by
`store.remember`'s `findExistingDuplicateMemory` /
`getMemoryDedupMatchText`. Two paraphrases of the same contract must
collapse to one row; two genuinely different contracts that share a verb
must not.

### Identity key

`claim_key` is a stable string stored in `metadata.derivation.claim_key`
**and** mirrored to the existing `dedup_key` column. Format:

```
df:v1:<claim_type>:<scope_key>:<normalized_claim>
```

Where:

- `claim_type` — one of `implementation_contract`, `gotcha`, `decision`,
  `locator`, `non_goal`, `preference`.
- `scope_key` — sorted, lowercased, slash-normalized intersection of
  `files_modified ∪ files_read ∪ concepts` (capped at 3 entries) so the same
  contract about the same files collapses regardless of session.
- `normalized_claim` — `normalizeMemoryDedupTitle(title)` only. (See **C12**:
  grounding `must_appear_tokens` are intentionally excluded from the identity key
  because they can vary across reruns; they live in
  `metadata.derivation.grounding` for anti-fabrication only.)

### Lookup

Before inserting a derived fact, the batch pass MUST check:

```sql
SELECT id FROM memory_items
WHERE active = 1
  AND scope_id = ?
  AND dedup_key = ?
  AND json_extract(metadata_json, '$.derivation.artifact_class') = 'derived_fact'
LIMIT 1
```

If a row matches:

- Update the existing row's `metadata.derivation.source.session_ids` and
  `source.memory_ids` to union the new contributor.
- Bump `rev` and `updated_at`, record a replication op.
- Do **not** create a second row.
- Do **not** rewrite `title`/`body_text`. The original phrasing wins.

### Re-runs and extractor-version changes

`extractor_version` is part of the derivation block but **not** part of
`claim_key`. Re-running with a newer extractor against the same sources
finds the existing row by `claim_key` and only mutates the
`derivation.extractor_version` and `derivation.derived_at` fields. This is
how idempotency holds across version bumps.

If an extractor genuinely needs to replace a prior claim wholesale
(rephrasing, semantic shift), it must do so by emitting a *new* `claim_key`
and recording `metadata.derivation.supersedes = <old_id>` while leaving the
old row active. Demotion is a retrieval-routing concern (ovk2.12), not a
delete.

### Grounding (anti-fabrication)

claude-mem's commit-hash idea is the right shape but the wrong substrate
for this repo — codemem is not commit-anchored. The equivalent anti-
fabrication rule here is: **every derived fact must include at least one
verifiable token that appears in the source memory text**.

Concretely, `metadata.derivation.grounding.must_appear_tokens[]` MUST be
non-empty, and every token MUST appear (case-insensitive) in the body of
at least one row in `derivation.source.memory_ids`. The batch pass rejects
candidates that fail this check. This is cheap, idempotent, and detectable
in tests without any LLM verification step.

When/if commit anchoring later becomes desirable (e.g., for facts tied to
`files_modified`), a future extractor version MAY set
`metadata.derivation.grounding.commit` and continue to satisfy the
must-appear rule alongside it. The contract is forward-compatible.

## Distill seam

There is no `distill.ts` or `selectDistillCorpus` in this worktree yet. The
seam below describes the shape Distill should adopt when it lands, so this
design does not lock us into a flawed contract.

`selectDistillCorpus` SHOULD return rows in this priority:

1. Active rows where
   `metadata.derivation.artifact_class === "derived_fact"` and
   `metadata.derivation.grounding.must_appear_tokens` is non-empty.
2. Active observations (`origin_source = "observer"`) whose
   `metadata.derivation.candidate === true` (the inline-tagged shortlist),
   used as raw input the next derivation pass should chew on, NOT as
   distill output.
3. Active session_summaries — only when the caller explicitly asks for
   chronology context (matches the recap-policy contract).

Distill MUST NOT promote observer summaries into its primary corpus. The
dual-artifact policy already calls that out as a failure mode; derived
facts are the replacement input.

Distill MUST treat rows without a `metadata.derivation` block as legacy
content (see *Upgrade Safety*). Legacy rows MAY still appear in Distill
output via existing heuristics, but they MUST NOT outrank a derived fact
with grounding.

## Boundaries: ovk2.10 (classifier) and ovk2.12 (retrieval routing)

This pass intentionally does not own classification or routing. Sharing a
clear seam prevents the three beads from regressing each other.

### What ovk2.9 (this) owns

- Reading source memory rows.
- Producing/updating `derived_fact` rows in `memory_items`.
- Writing `metadata.derivation` blocks (including grounding and provenance).
- Mirroring `claim_key` into `dedup_key`.
- Idempotency, re-run safety, and cross-extractor-version behavior.

### What ovk2.10 (classifier rework) owns

- Deciding per artifact class whether to `store`, `store_demoted`, or
  `suppress`, per the dual-artifact policy.
- Replacing today's global `classifyMemoryWorthiness` with the
  per-artifact decisions.
- Fixing the M1/M2 false negatives by checking signal balance.
- Exposing the signal scoring that this pass reuses for inline tagging
  (so two implementations of "is this a candidate?" don't drift).

ovk2.9 depends on ovk2.10's signal scorer, but only as a function call. If
ovk2.10 lands later, ovk2.9 can inline a stub that uses the existing
keep-signals from `memory-quality.ts` (`hasContractLanguage`,
`hasImplementationLocator`, the `troubleshooting_gotcha` regex set).

### What ovk2.12 (retrieval routing) owns

- Choosing which artifact class to prefer per retrieval mode (default,
  task, debug, recap, audit) — the table in the dual-artifact policy.
- Wiring `pack.ts` / `search.ts` to recognize
  `metadata.derivation.artifact_class === "derived_fact"` and weight it.
- Updating `isSummaryLike` callers in `packages/core/src/pack.ts` so the
  presence of a derived fact does not get suppressed by summary-like
  filtering.

ovk2.9 produces the rows; ovk2.12 decides how they rank. ovk2.9 MUST NOT
hard-code retrieval boost values. The only retrieval-facing commitment
this pass makes is the `metadata.derivation.artifact_class` marker and a
populated `origin_source = "derive-batch"`.

## Upgrade safety

This pass must be safe on older databases and on peers that have not yet
deployed derivation. The dual-artifact policy already enumerates the
upgrade-safety contract; this section maps each rule to concrete behavior.

### Additive only

- No new columns. Everything lives in existing nullable columns
  (`metadata_json`, `facts`, `narrative`, `concepts`, `dedup_key`) and
  reuses the existing `derivation` JSON sub-tree.
- No new tables. (If a future optimization wants a `derived_fact_provenance`
  index table, it MUST be additive, MAY be rebuilt from `metadata_json`,
  and MUST NOT be required for correctness.)
- No new `kind` value. Derived facts use existing kinds in
  `ALLOWED_MEMORY_KINDS`.

This satisfies "Allowed additions: nullable/defaulted artifact type fields"
and "Avoid: required non-null fields with no default for legacy rows" from
the policy doc.

### Version-marker gated

- Everything derivation-specific is gated on the presence of
  `metadata.derivation`. Code paths that don't see the block treat the row
  as legacy.
- The extractor identity is `metadata.derivation.extractor_version` (start
  at `"v1"`). Future versions can detect downgrade scenarios.
- The schema gate (`SCHEMA_VERSION = 8`, `MIN_COMPATIBLE_SCHEMA = 6` in
  `packages/core/src/db.ts`) does **not** need to move for this pass. If
  some future cleanup wants a real schema bump, it must follow the
  existing `ensureAdditiveSchemaCompatibility` pattern.

### Legacy rows

- A row without `metadata.derivation` is `artifact_class = "unknown"`,
  treated as legacy. It remains retrievable, syncable, and rankable under
  existing heuristics.
- Legacy `kind = decision | bugfix | discovery` rows that *look like*
  derived facts MUST NOT be silently rewritten. The batch pass MAY emit a
  separate derived fact with the same claim_key; if that row already
  matches a legacy row by `dedup_key`, the batch pass MUST take the
  conservative path of leaving the legacy row alone and skipping
  creation, recording a reason for the skip in a usage event.
- Legacy summaries continue to behave as recap.

### Idempotency

- `claim_key` identity guarantees re-runs collapse.
- `extractor_version` changes do not duplicate.
- Re-running the batch over the same session range produces the same set
  of `derived_fact` rows (modulo source-list union updates).
- The batch pass MUST be reversible by ignoring its output, not by
  deleting source rows. Source observations and summaries are never
  modified beyond optional `metadata.derivation.superseded_by_derived`
  annotation.

### Sync compatibility

- Derived facts replicate via the same `recordReplicationOp` path used by
  `store.remember`. No new op type.
- Older peers see them as normal `decision | discovery | bugfix` rows
  with extra metadata; they ignore the `derivation` block harmlessly.
- Newer peers see legacy rows from older peers and continue to treat them
  as `artifact_class = "unknown"`. No bidirectional schema change is
  needed for sync to keep working.
- `scope_id`, `visibility`, `workspace_id`, and `dedup_key` follow the
  same rules as any other memory write.

### No hard delete

- Source observations and summaries are never deleted by derivation.
- Failed/superseded derived facts are demoted via metadata, not deleted.
- `forget()` remains the only path that flips `active = 0`, and only by
  explicit user action.

## Evaluation

This pass MUST hook into the ovk2.7 harness. Evals fall into four buckets.

### 1. Derived-fact precision

Against the captured ovk2.7 baseline (where recap is ~43% of active and
telemetry dominates telemetry-probes):

- Run the batch pass on the baseline corpus.
- For each produced `derived_fact`, hand-label (or fixture-label) whether
  it represents a real durable rule.
- Precision target: ≥0.8 on the M1/M2 fixtures from the dual-artifact
  policy and ≥0.7 across the broader baseline.

Reuses `packages/core/src/pack-eval-fixtures.ts` and adds a fixture set
under `packages/core/src/derive-eval-fixtures.ts` (or equivalent name) so
both eval suites and unit tests share inputs.

### 2. Derived-fact recall

For each of the ovk2.7 fixture sessions, manually identify the durable
contracts/gotchas/decisions in the source observations and summary, then
measure how many the batch pass produces.

Recall target: ≥0.6 v1. Lower than precision is acceptable because
recall improves with extractor-version bumps, but precision is hard to
take back once a fact is in `memory_items`.

Required regression coverage:

- M1 contract: "Handlers must return structured errors instead of throwing
  uncaught exceptions." → MUST produce a derived fact.
- M2 embedded contract: "CI passed after confirming handlers must return
  structured errors." → MUST produce the contract fact and MUST NOT
  store the "CI passed" telemetry as a derived fact.

### 3. Idempotency

- Run batch twice over the same source set. Diff outputs:
  - Same `dedup_key` set
  - Same `metadata.derivation.claim_key` set
  - `metadata.derivation.source.memory_ids` may union (allowed) but no new
    rows.
- Run batch under an artificially bumped `extractor_version`. Confirm no
  duplicate rows; only `derivation.extractor_version` field changes.

### 4. Upgrade safety

Use the ovk2.7 pre-change DB snapshots:

- Load snapshot. Run derivation. Confirm legacy rows remain readable,
  syncable, untouched.
- Replicate from a "no derivation" peer DB to a "with derivation" DB.
  Confirm no schema errors and no lost ops.
- Replicate from a "with derivation" peer DB to a "no derivation" peer DB.
  Confirm derived rows arrive as normal `decision|bugfix|discovery` rows
  and remain queryable.

### 5. Cross-impact with recap and telemetry shares

To validate the dual-artifact policy's promise:

- Re-run the ovk2.7 summary-domination probe with derived facts present.
  Expect default/task/debug top-N share of `session_summary`/recap-like to
  drop (the exact threshold belongs to ovk2.12).
- Re-run the telemetry-share probe. Expect it to remain low — derivation
  should not inflate it. If telemetry share rises, ovk2.9 leaked
  candidates that should have been suppressed.
- Recap quality probe (chronology + next steps) MUST remain flat or up.

These cross-impact metrics depend on ovk2.12 doing the routing work; this
pass is responsible for not making them worse.

## Non-goals

- No new schema columns. No new tables. No new kind values. No
  `SCHEMA_VERSION` bump.
- No auto-writing to project/user context files. Derivation produces
  `memory_items` rows; it does not edit docs or AGENTS.md.
- No hard deletion of source observations, summaries, or prior derived
  facts. Supersession is metadata-only.
- No inline LLM derivation in the hot path. Inline only tags candidates.
- No commit-hash anchoring at v1. The grounding contract leaves room for
  it later but does not require it.
- No retrieval routing or ranking changes. That is ovk2.12.
- No classifier rewrite. That is ovk2.10.
- No silent rewriting of legacy "looks durable" rows. Legacy is left alone.
- No solving session-boundary quality. Derivation operates on whatever
  session boundaries the ingest pipeline produced.

## Open questions

1. **Confidence default.** Should derived-fact `confidence` default to
   `0.7` (chosen here) or be a function of grounding strength
   (number of must-appear tokens, number of sources)? Recommendation: hold
   at `0.7` for v1 and let ovk2.12 own ranking; revisit once retrieval
   routing has data.
2. **Demote-source behavior.** Should the batch pass mark source
   observations as `derivation.superseded_by_derived` by default, or only
   when explicitly enabled? Recommendation: emit the annotation but leave
   the routing impact off until ovk2.12 wires it; this lets us measure
   without changing behavior.
3. **Cross-session vs same-session-only derivation v1.** v1 design says
   per-session bundles. A claim that *clearly* recurs across sessions
   could be derived once and reuse `claim_key` to merge sources. Should
   we attempt cross-session clustering in v1, or defer? Recommendation:
   defer cross-session clustering; rely on `claim_key` dedup catching it
   naturally when the same claim is re-emitted from a later session.
4. **MCP/UI surfacing.** Should the viewer feed (`packages/ui/src/tabs/feed.ts`)
   render derived facts differently, or wait until ovk2.12? AGENTS.md
   requires `store.ts`, `mcp-server`, and `feed.ts` to move together when
   kinds change. Since this design *does not* introduce a new kind, the
   three-surface rule is not triggered, but a follow-up to expose
   `metadata.derivation.artifact_class` in the UI may be desirable.
5. **Scheduler.** Should batch run on a maintenance-worker cadence (see
   `packages/core/src/maintenance/`), via an explicit CLI subcommand under
   the `docs/cli-design-conventions.md` two-level rule (e.g.
   `codemem derive run`), or both? Recommendation: ship a CLI first,
   wire maintenance second.
6. **Multi-claim fan-out limits.** A single observation could in principle
   produce many derived facts. Should there be a per-source fan-out cap
   (e.g., ≤5)? Recommendation: cap at 5 for v1 to keep precision honest;
   expose via config.
7. **Vector population.** Derived facts go through `store.remember`, which
   already enqueues vector writes via `enqueueVectorWrite`. Confirm that
   the embedding cost on retroactive batch runs is acceptable; if not,
   defer vectorization to a follow-up flag.

## Write-path corrections (review findings)

Review surfaced four places where this design, as originally written, conflicts
with how `MemoryStore.remember` actually behaves today
(`packages/core/src/store.ts`). These are binding corrections for the
implementation (`codemem-ovk2.11`); the conceptual model above is unchanged.

### C1 (P1) — Derived facts MUST inherit source visibility/scope

`resolveProvenance` only reads the metadata it is handed and otherwise defaults
to `visibility = "shared"` / `workspace_id = "shared:default"`
(`packages/core/src/store.ts:822-845`); `resolveSessionScopeId` derives scope
from that workspace. A fact derived from a private/personal source memory would
therefore be written as **shared** and leak through sync/search.

Requirement:

- The batch pass MUST copy `visibility`, `workspace_id`, and `scope_id` from the
  source rows, not rely on session defaults.
- Mixed-provenance bundles (sources spanning different visibility/workspace/scope)
  MUST take the most-restrictive value or be rejected — never widened. v1
  default: **reject mixed-provenance bundles** and record a skip reason.
- Eval/upgrade-safety suite MUST include a private-source fixture asserting the
  derived fact is not written as shared.

### C2 (P2) — A write path MUST set `dedup_key` to `claim_key`

`store.remember` ignores caller metadata for `dedup_key` and always stores
`buildMemoryDedupKey(safeTitle)` (a SHA-256 title hash;
`packages/core/src/store.ts:640,727`). The idempotency lookup in this design
compares `dedup_key = <claim_key>`, so as written, reruns/extractor-version
bumps would never match and would insert duplicates.

Requirement (pick one, decided at implementation):

- Add an explicit `dedupKey` option to `remember` (preferred: small, reusable,
  keeps replication bookkeeping centralized), OR
- A derived-fact insert/upsert helper that writes `dedup_key = claim_key` and
  records the replication op.

Either way, the `claim_key` MUST land in the `dedup_key` column and the
idempotency test (run batch twice; no new rows) MUST cover it.

### C3 (P2) — Grounding MUST include the summary row

For summary-only sessions, the durable claim often lives in the summary, which
this design stores as `summary_memory_id` separately from
`source.memory_ids`. The must-appear grounding check would then reject every
summary-only derived fact even when the token appears in the summary body.

Requirement:

- The grounding check MUST scan `source.memory_ids` **plus**
  `summary_memory_id`. Equivalently, include the summary row id in the set of
  rows whose body is searched for `must_appear_tokens`.
- Recall fixtures MUST include a summary-only durable claim that passes
  grounding.

### C4 (P2) — Derived inserts MUST bypass legacy title dedup

`store.remember` runs `findExistingDuplicateMemory` before insert, filtering by
session/kind/visibility/workspace/title — not by
`metadata.derivation.artifact_class` (`packages/core/src/store.ts:286-370,676`).
When a source observation already has the durable title and a matching mapped
kind, the derived insert could return the existing observation id instead of
creating a derived row, or later provenance updates could mutate the source row.

Requirement:

- Derived-fact creation MUST use a derived-specific insert/upsert path, or pass a
  flag that bypasses legacy title dedup, so the derived row is always distinct
  from its source observation.
- Derived-fact dedup is governed solely by `claim_key`/`dedup_key` + the
  `artifact_class = "derived_fact"` predicate (see *Dedup*), never by legacy
  title dedup.
- Test MUST cover: a source observation sharing the derived title + kind still
  yields a separate derived row, and provenance updates never mutate the source.

### C5 (P2) — Modal-contract detection MUST NOT be a verb whitelist

Implemented in the classifier (`codemem-ovk2.10`) and mirrored in the eval
metric (`codemem-ovk2.7`): modal-contract detection matches
`(?:must|should|shall)\s+(?:not|always|never )?<verb>` for any verb, not an
enumerated list, gated against personal-task phrasing (`I/we/you must`,
`must remember`). The inline candidate-tagger MUST reuse that same signal helper
so derivation candidacy and retrieval classification cannot drift. Recorded here
so the derivation pass does not reintroduce a narrower contract check.

### C6 (P2) — Dependency/outcome phrasing is a keep-signal

Also implemented in the classifier/metric: `depends on`, `relies on`,
`only after/works when/if` register as durable keep-signals before telemetry
suppression. The derivation candidate set MUST treat dependency-lesson phrasing
as derivable so asset/build dependency lessons are not lost.

### C7 (P2) — Provenance MUST survive sync (stable IDs, not local row IDs)

`metadata.derivation.source.{memory_ids,summary_memory_id,session_ids}` as
written are local SQLite row IDs. Replication identifies rows by `import_key`
(`recordReplicationOp` uses it as the entity id;
`packages/core/src/sync-replication.ts:815,894`) and inbound rows are inserted
under a freshly synthesized local session
(`packages/core/src/sync-replication.ts:3279-3284`). On a receiving peer the
numeric IDs point at nonexistent or unrelated rows, so grounding/audit/backout
would validate against the wrong sources.

Requirement:

- Provenance MUST store stable identifiers: `import_key` for source memories and
  the summary row, and a stable session identifier (e.g. session `import_key` or
  the existing stable session key), not local numeric IDs.
- Local numeric IDs MAY be retained as a non-authoritative convenience for the
  origin device only.
- Grounding/backout MUST resolve sources via the stable keys (remap on apply).
- An eval MUST replicate a derived fact to a second peer and assert provenance
  still resolves to the correct source rows.

### C8 (P2) — Replication payload MUST carry `dedup_key`

The current replication payload includes fields through `scope_id` but not
`dedup_key` (`packages/core/src/sync-replication.ts:855-884`), and the apply
path does not write a payload dedup key. A peer would then receive
`metadata.derivation.claim_key` but an empty/derived-mismatched
`memory_items.dedup_key`, so the idempotency lookup (C2) misses and a later
batch run on that peer inserts duplicate derived facts.

Requirement:

- Extend the replication payload + apply path to carry and persist `dedup_key`.
- This is a prerequisite for declaring derived-fact sync idempotency; the
  cross-peer idempotency eval (run batch on peer B after replicating from peer A;
  no duplicates) MUST cover it.
- This payload extension is itself additive and version-marker-safe: older peers
  that omit `dedup_key` fall back to current behavior; newer peers populate it.

### C9 (P2) — `decision`-kind rows are durable even without a decision word

Implemented in the classifier (`codemem-ovk2.10`): a `kind: "decision"` row
always contributes a `durable_decision` keep reason, so a decision that also
mentions "tests passed" is not suppressed as telemetry. Mirrored note here so the
derivation candidate set treats decision-kind rows as derivable.

### C10 (P2) — Investigations with confirmed outcomes are durable

Implemented in the classifier: the investigation-without-outcome demotion now
excludes confirmation verbs (`confirmed`, `determined`, `found that`,
`discovered`, `learned`) in addition to `resolved`/`fixed`. A discovery like
"Investigated search.ts and confirmed reranking uses recency decay" is kept.

### C11 (P2) — Idempotency lookup MUST honor forgotten tombstones

`MemoryStore.forget()` leaves an inactive row (`active = 0`, `deleted_at` set)
rather than hard-deleting. The dedup lookup in *Dedup* filters `active = 1`, so a
rerun would miss a forgotten derived fact and recreate it — silently undoing the
user's forget.

Requirement:

- The idempotency lookup MUST also check for an inactive row with the same
  `scope_id` + `dedup_key` + `artifact_class = "derived_fact"` whose
  `deleted_at` is set, and treat it as a tombstone: **skip recreation**.
- Re-deriving a forgotten fact requires an explicit restore path, never an
  implicit rerun.
- Test MUST cover: forget a derived fact, rerun the batch over the same source,
  assert it is not recreated.

### C12 (P2) — Grounding tokens MUST NOT be part of `claim_key`

The *Dedup* `claim_key` format included `must_appear_tokens`. Those tokens are
extractor-chosen grounding evidence and can legitimately vary across reruns or
extractor-version bumps for the same claim, which would change `claim_key` and
defeat idempotency.

Correction to the identity key:

```
df:v1:<claim_type>:<scope_key>:<normalized_claim>
```

- `normalized_claim` = `normalizeMemoryDedupTitle(title)` only.
- `must_appear_tokens` are stored in `metadata.derivation.grounding` for
  anti-fabrication checks but are **excluded** from `claim_key`.
- If a future extractor needs claim-text to influence identity, it MUST use a
  deterministic canonicalization that cannot vary across reruns.

### C13 (P2) — Inline candidates MUST NOT carry the `derived_fact` marker

The inline tagging pass (Pass A) must not set
`metadata.derivation.artifact_class = "derived_fact"`, or ovk2.12 retrieval would
boost ungrounded raw observations as if they were real derived facts.

Requirement:

- Inline tagging sets a candidate-only marker, e.g.
  `metadata.derivation.candidate = true` with **no** `artifact_class` (or
  `artifact_class = "candidate"`).
- Only the batch pass (Pass B), after splitting + grounding, writes
  `artifact_class = "derived_fact"`.
- Retrieval routing (ovk2.12) MUST treat only `artifact_class = "derived_fact"`
  as a derived fact; candidate markers get no boost.

### C14 (P2) — Candidate shortlist needs a real index (or a bounded scan)

The inline-candidate shortlist is described as indexable via
`json_extract(metadata_json, '$.derivation.candidate') = 1`, but
`memory_items.metadata_json` has no expression/partial index in
`packages/core/src/schema.ts`, so SQLite would full-scan.

Requirement (implementation choice at ovk2.11):

- Add an additive partial/expression index on the candidate predicate (e.g.
  `CREATE INDEX ... ON memory_items(active) WHERE json_extract(metadata_json,
  '$.derivation.candidate') = 1`), following the existing additive-index pattern
  and version gate, OR
- Bound the batch scan by `created_at`/session range so it never scans whole
  history.
- Do not describe the predicate as "indexable" without one of these.

### C15 (P2) — Candidate-negative state MUST be explicit

The design claims the inline pass records a trustworthy "no candidate here"
signal, but only specifies positive `candidate: true`. Absence of a marker is
indistinguishable from legacy/unprocessed rows, so the batch pass cannot trust it
as a skip.

Requirement:

- The inline pass MUST write an explicit evaluated marker, e.g.
  `metadata.derivation.candidate = false` plus
  `metadata.derivation.evaluated_extractor_version`, so "evaluated, no candidate"
  is distinguishable from "never evaluated".
- The batch pass only treats `candidate = false` at the current extractor version
  as a trusted skip; missing markers are treated as unprocessed.

### C16 (P2) — Derived rows MUST inherit (not launder) source trust_state

C1 covers visibility/workspace/scope, but `resolveProvenance` also defaults a
missing `trust_state` to `trusted`. A fact derived from a shared but
`unreviewed`/`legacy_unknown` source would become `trusted` and gain search
trust it never earned.

Requirement:

- Derived rows MUST carry the **least-trusted** `trust_state` among their
  sources, never upgrade it.
- Mixed-trust bundles follow the C1 rule (most-restrictive or reject).
- Eval MUST assert a derived fact from an `unreviewed` source is not written as
  `trusted`.
- A **missing/NULL** source `trust_state` (nullable column on legacy/replicated
  rows) MUST degrade to the least-trusted tier (`legacy_unknown`), never default
  to `trusted`.

### C17 (P2) — Grounding must search all structured source fields

The grounding `must_appear_tokens` check MUST search source titles, bodies, and
structured `facts` (and may use `files`/`concepts` locators), not bodies alone.
Durable content frequently lives in the title (e.g. title "Handlers must return
structured errors" / body "Use them instead of throwing") or in `facts`. A
body-only check would reject valid file/concept-locator-grounded facts.

### C18 (P2) — Summary provenance is a list, not a singleton

`metadata.derivation.source.summary_memory_import_key` MUST be a list
(`summary_memory_import_keys`). When the same `claim_key` is merged across later
sessions, a singular field cannot represent multiple contributing summaries; union
the keys like `memory_import_keys`/`session_import_keys`.

### C19 (P2) — Source-demotion annotations use stable identifiers

When source-demotion is enabled, `metadata.derivation.superseded_by_derived` MUST
reference a **stable** identifier (the derived fact's `import_key`), not a local
numeric row id, so the annotation resolves correctly on a peer after sync (same
rationale as C7).

### C20 (P2) — Canonicalize `claim_key` inputs

`claim_key` must be deterministic across sessions for the same claim. The
`scope_key` is derived from `files_modified ∪ files_read ∪ concepts`; this set
MUST be canonicalized (lowercased, slash-normalized, sorted, deduped, capped)
**before** hashing, and the normalized title MUST come from
`normalizeMemoryDedupTitle` only. Two sessions that mention different incidental
file sets for the same durable claim should not produce divergent keys; if
source-set drift is a concern, restrict `scope_key` to the most stable locator
(e.g. primary `files_modified`) rather than the full union.
