# Coordinator enrollment reconciliation issue lifecycle

## Decision

Persist row-level coordinator enrollment reconciliation issues in a dedicated local SQLite table. Issues resolve automatically only after a successful reconciliation for the same coordinator and group no longer reproduces them.

Manual dismissal is intentionally unsupported. A user must not be able to hide a conflict that still prevents the coordinator snapshot from matching local recipient policy.

## Why

Enrollment reconciliation currently returns issue details only in memory. Maintenance can report the number of issues, but the affected coordinator boundary, row, and error code disappear after the pass. That makes conflicts visible as a failed maintenance count without leaving enough durable evidence to diagnose whether the next pass fixed them.

Recipient-policy review resolutions are not a suitable store. Those records capture user decisions about legacy access migration, while enrollment issues report coordinator-owned data that reconciliation could not safely apply. Combining the models would imply that a user decision can override coordinator authority.

## Local state

An additive `coordinator_enrollment_reconciliation_issues` table records:

- coordinator and group IDs;
- issue kind, reference ID, and safe code;
- lifecycle status (`open` or `resolved`);
- first-seen, last-seen, resolved, and updated timestamps;
- occurrence count.

The composite issue identity is `(coordinator_id, group_id, kind, reference_id, code)`. If one row changes from one safe code to another, the old issue resolves and a distinct issue opens. No remote payload or secret is persisted.

## Reconciliation lifecycle

For each successfully fetched coordinator/group snapshot, policy writes and issue lifecycle updates occur in one SQLite transaction:

1. Reconcile consumed Team invitations and enabled device enrollments using the existing fail-closed rules.
2. Derive the exact issue set for the snapshot.
3. Mark previously open issues for that coordinator/group as resolved.
4. Upsert the current issue set as open:
   - a new issue stores its first and last observation;
   - a repeated issue preserves `first_seen_at`, advances `last_seen_at`, and increments `occurrence_count`;
   - a resolved issue that reappears reopens and clears `resolved_at`.
5. Commit policy and lifecycle changes together.

A failed coordinator fetch or failed reconciliation transaction leaves prior issue state unchanged. Absence is authoritative only in a successfully reconciled snapshot for the exact coordinator/group boundary.

## Visibility

`GET /api/sync/status` includes summary counts for open and resolved enrollment issues. When `includeDiagnostics=true`, it also includes a bounded list of open issues followed by recently resolved issues with their safe metadata and timestamps.

The normal redacted response does not expose coordinator, group, or reference IDs. There is no mutation endpoint because resolution is evidence-driven by a clean retry, not a user acknowledgement.

## Compatibility and migration

- The local schema change is additive and requires no backfill.
- Coordinator storage and APIs do not change.
- Existing maintenance result counts remain compatible.
- Older databases receive the table through normal bootstrap and compatibility repair.

## Validation

- Core tests prove initial persistence, deduplication, automatic resolution, reopening, and coordinator/group isolation.
- A failed transaction proves policy and issue state roll back together.
- Viewer maintenance tests prove fetch failures do not resolve prior issues.
- Sync status tests prove redacted counts and diagnostic detail behavior.
- Schema upgrade and bootstrap tests prove additive, idempotent creation.
