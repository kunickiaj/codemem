# Subagent Memory Improvements Execution Plan

Follow-up A keeps verified delegated briefs as transient context instead of
learning them as human decisions. Follow-up B is deferred. This plan records
technical readiness; it does not approve a release or accept release risk.

## Status and Branches

The ranking PRs #1683 and #1684 and capture-lifecycle PR #1675 are already on
`main`. The ranking-only `0.44.3` candidate is separate from A: it needs no A
port and no V2 runtime work.

| Branch/work | Current state | Next gate |
|---|---|---|
| `0.44.3` ranking-only candidate | Full check freshly passed: **6,619 tests**, **3 TODOs**; an earlier full build passed | Explicitly fix or accept and document the three relevance losses |
| Follow-up A | Uncommitted and unmerged; full check passed: **6,844 tests**, **3 TODOs** | Integrate onto current `main`, resolve documentation overlap, then run CI |
| Follow-up B | Deferred in `codemem-3k54h.2` | Harness research only; no branch prerequisite |

A started from `c6c58d9c7`. Remote `main` is now one commit ahead at
`074a5ac1f4c1bd62a2a09bd5befd5ef301f973e9` because of pnpm updater #1686.
The production changes are disjoint, but A overlaps `README.md`, the plugin
reference, and the user guide; integrate final A onto current `main` and use
CI as the integration gate. Being merged on `main` is not proof that work is
released or safe to release.

The approved cleanup deleted **210 generated artifacts**; zero remnants
remain.

## Follow-up A: Preserve Delegated Briefs Without Learning Them

Bind message-specific host provenance before extraction. A confirmed
parent-created task input is a delegated brief, not proof of a human decision.
Keep synthetic results and mixed or unknown origin distinct.

- Retain raw context for every batch.
- Finish a proven brief-only child batch as context-only: no observer call and
  no durable memory.
- Recover earlier briefs only for a later substantive batch.
- Continue extracting primary user decisions and real tool or assistant
  findings.
- Preserve actor ownership, visibility, requester scopes, and event IDs.

**Tests must prove:** a brief-only child batch creates neither an observer call
nor durable memory; its raw context remains available; later substantive content
can qualify; primary decisions and tool/assistant findings still extract; unknown
provenance is not promoted; and identity/event fields survive unchanged.

### OpenCode 1 contract

The production adapter requires a complete `chat.message` hook snapshot, live
task metadata, and bounded SDK reads of the exact child session and message.
SDK-only snapshots may be partial, so incomplete, late, or missing metadata
leaves provenance unknown rather than inferring human approval.

The exact original message/parts, parent and child IDs, timestamps, requested
and current child agent, task start, and one ordinary non-ignored matching text
part must agree. Tasks that started before this plugin instance remain unknown.
Disposal waits for pending capture preparation, cancels active host lookups, and
releases timers/controllers on every completion path.

| Contract bound | Limit |
|---|---|
| Live task bindings and replay guards | 128 entries; 10-minute lifetime |
| Matching brief | One ordinary text part; at most 64,000 characters |
| Host lookup | 200 ms total; failure or disposal aborts reads |
| Prior context | Latest 4 provenance-bearing events; 800 appended characters total |

Optional provenance remains outside the hashed payload in `capture_context` and
the additive nullable `capture_context_json` column. Old rows stay unknown, and
duplicate ingestion cannot replace existing provenance. Brief-only batches keep
raw events through the completed-batch cursor; later batches recover bounded
prior instructions after new evidence. Sanitization precedes truncation, and
the aggregate cap preserves the original evidence prefix.

### Core reader and replay contracts

Core uses one raw-row hydration path for store reads, backfill, and replay.
Recovered briefs are transient; they are not copied to durable session metadata.

- `hydrateRawEvent(row, { source, streamId })` validates optional sidecar data
  and keeps missing or invalid provenance unknown.
- `rawEventCaptureContextProjection(db)` uses `NULL AS capture_context_json`
  on legacy databases.
- `loadPriorDelegatedBriefEvents(...)` reads bounded provenance-bearing rows
  from the exact OpenCode stream in chronological order.
- `ContextOnlyReplayError` rejects proven brief-only replay before observation;
  mixed input retains labels and bounded prior context.

Single replay reports `status: "context_only"`,
`code: "delegated_brief_context_only"`, and `evaluated: false` with exit status
zero. Benchmark summaries record those skips separately, include them in
scheduled work, and exclude them from observer, quality, latency, cost, and
output metrics.

### A validation

The actual strict adapter integration test now lives at
`packages/core/src/opencode-v1-delegation-adapter.test.ts`. It exercises the
exported V1 adapter from strict hook snapshot through SDK, envelope, Core ingest,
and brief-only flush. Missing, mutated, partial, mixed, and timestamp-mismatched
input remains unknown.

| Check | Result |
|---|---|
| A worktree full check | **6,844 passed; 3 TODOs** |
| Production test boundary | No boundary errors remain |
| Cleanup | **210 generated artifacts deleted; zero remnants** |

The suite covers additive old-database migration, retry integrity, spool
round-trip, delayed findings after restart, ambiguity, synthetic/mixed parts,
callback ordering, cancellation, and observer clipping. No hosted evaluation or
live-data migration ran.

## Follow-up B: Explicit Reviewer Automatic-Recall Opt-Out

`codemem-3k54h.2` remains deferred pending harness research. It neither blocks
A nor the ranking-only patch.

If implemented, B must read an exact request-bound operator policy, leave
unconfigured agents unchanged, and keep visible context, permitted explicit
tools, and capture available. Persisted capture provenance cannot authorize the
currently executing agent. Unknown identity must not inherit another session's
policy or silently bypass an enabled opt-out.

## Verification and Decision

Treat the ranking-only patch and A as separate decisions. The technical
ranking-only candidate is ready for release evaluation, but release acceptance
remains pending; earlier categorical “hold until A” reasoning is superseded.

| Scope | Required decision and gate |
|---|---|
| `0.44.3` ranking-only | Keep the candidate ranking-only. The three local relevance losses are real evidence, but a small screen without downstream task outcomes does not prove general harm or justify an automatic infinite veto. Explicitly choose and document either acceptance with limitations or a fix; do not silently waive the existing Bead gate. |
| A for `0.45` | Integrate A onto current `main`, resolve the three documentation conflicts, and pass CI. A is not a dependency of the ranking-only patch. |
| A on `0.44` (optional) | Deliberately port A into the monolithic plugin after pending-message and durable-disposal prerequisites, then include schema, Core, and replay changes in combined validation. This is separate scope, not a patch dependency. |

No port of A or V2 runtime work is needed for the `0.44.3` ranking-only patch.
Do not release, activate, bump a version, tag, or publish as part of this work.

## Explicit Non-Goals

- No new ranker, model, normalization, weight tuning, or hosted inference.
- No legacy deletion, reindex, provider-policy implementation, or bulk cleanup.
- No broader observer audit; `codemem-tuswg` remains separate.
- No attempt to classify arbitrary human phrasing; this scope is proven
  delegated-brief context only.

## Resume

```fish
bd show codemem-3k54h.1
bd show codemem-3k54h.2
bd show codemem-3k54h.3
```
