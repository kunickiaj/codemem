# Legacy Team candidate authority design

## Goal

Ensure every legacy Team candidate has one authoritative current setup attempt and that replacement decisions cannot race with another discovery or refresh writer.

## Decision

Use SQLite immediate transactions and insertion-order authority rather than adding schema-level generations or partial unique indexes.

Each candidate read/decision/write sequence runs under an immediate transaction. Creating a replacement marks a mutable attempt stale and records `superseded_at`. A completed attempt retains its historical `completed` state and receives `superseded_at`; insertion order makes the replacement authoritative without revoking completion-bound migration evidence. Completion replay remains bound to the immutable `legacy_team_setup_completions` row.

Draft mutation validates both conditions in one locked read:

1. The attempt is `needs_setup` or `in_progress`.
2. No newer attempt exists for the same candidate by SQLite `rowid`.

An older attempt therefore cannot mutate even if legacy data incorrectly leaves its state mutable.

## Alternatives rejected

### Partial unique indexes

A partial unique index could prevent two mutable rows, but it would not model replacement of completed attempts or make the preceding read/decision sequence atomic. It would also require a schema migration for an invariant already expressible through the existing insertion-order authority rule.

### Generation-based optimistic concurrency

An explicit generation column would make authority visible but would expand the schema and every mutation contract. Immediate transactions provide the required serialization without changing public or persisted contracts.

## Transaction boundaries

- `refreshLegacyTeamSetupDraft` acquires an immediate transaction before selecting the current attempt, deciding reuse or replacement, and writing child rows.
- Candidate discovery evaluates and mutates each candidate in its own immediate transaction. One blocked or oversized candidate does not hold a transaction across unrelated groups.
- Direct candidate refresh performs its Ready/replacement decision under one immediate transaction.
- Existing nested draft transactions remain savepoints when called inside candidate transactions.

## Compatibility

- Public draft and candidate response shapes remain unchanged.
- Existing exact completion replay remains valid.
- Completed setup remains valid historical migration evidence after supersession.
- Label-only refresh continues reusing the current attempt.
- Stale attempts remain immutable and completed attempts remain selectable only until explicitly replaced.

## Verification

Focused tests must prove:

- Replacing a completed attempt explicitly supersedes it.
- A non-current attempt cannot accept device assignments, decisions, or Project mappings even if its state is mutable.
- Candidate-layer coverage in the next stacked PR proves competing refresh writers serialize and leave one authoritative current attempt.
- Existing label-only reuse and completion replay behavior remain intact.
