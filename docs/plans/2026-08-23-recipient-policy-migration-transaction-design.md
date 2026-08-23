# Recipient-policy migration transaction design

## Goal

Eliminate the read/validate/write race in `migrateRecipientPolicyIntent` without changing its per-project partial-success contract.

## Transaction boundary

Write-mode migration runs projection, review-state, resolution, plan, validation, and write work inside one outer `BEGIN IMMEDIATE` transaction. This acquires authority before the first migration read and keeps one SQLite snapshot across every Project.

Each Project executes inside a nested transaction/savepoint. A conflict rolls back only that Project and produces its existing blocked result; successful Projects remain pending in the outer transaction and commit together when iteration finishes. Unexpected failure of the outer operation rolls back all pending successful Projects.

Only recognized migration-domain conflicts may become per-Project blocked results. Unknown storage or programming failures propagate, and any error that ends the outer transaction stops iteration immediately so later Projects cannot run in autocommit mode.

Dry-run mode performs the same reads and validation in one deferred read transaction. It does not acquire the writer lock and performs no writes.

The HTTP migration boundary converts writer-lock contention to `503 {"error":"migration_busy"}` and other unexpected failures to `500 {"error":"migration_failed"}` without exposing SQLite details.

## Dynamic SQL boundary

All table and column identifiers used by the generic row helpers must match a static runtime schema allowlist before interpolation. Unknown tables, key columns, value columns, duplicate columns, and invalid key shapes fail with `intent_conflict` before preparing SQL.

## Authorizing evidence

New relationship revisions and idempotency keys use version-two metadata bound to:

- the relationship identity;
- migration provenance; and
- the source fingerprint that authorized the row.

Validation compares status/role plus provenance, source fingerprint, revision, and idempotency key. Released version-one metadata remains replay-compatible only when the stored provenance and source fingerprint also match the current plan. Setup-owned device assignments and recipient edges retain their existing completion-bound compatibility exceptions.

Identity-device assignment is global and may be authorized by multiple Project resolutions. Its metadata therefore binds the stable device/Identity relationship and provenance, while Project-specific source evidence remains stored for audit but is not treated as unique relationship identity. Project recipient rows continue to require an exact source-fingerprint match.

## Verification

- A competing SQLite writer cannot mutate migration evidence after migration starts reading it.
- A late conflict rolls back only its Project while another valid Project commits.
- Outer failure rolls back all pending Project writes.
- Dry runs do not write or acquire the immediate writer lock.
- Tampered provenance, source fingerprint, revision, or idempotency evidence blocks replay.
- Valid released v1 rows replay unchanged; new inserts carry evidence-bound v2 metadata.
- Invalid dynamic identifiers are rejected before SQL preparation.
