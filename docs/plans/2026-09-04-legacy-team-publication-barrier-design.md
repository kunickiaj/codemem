# Legacy Team Publication Barrier

## Decision

Legacy Team completion publication will share one database-scoped mutation barrier with device-binding commits and Project-mapping writes. This prevents a successful local mutation from being overwritten by an immutable coordinator winner published concurrently.

## Lock order

Finish acquires locks in this order: candidate claim, publication barrier, sorted actor locks, Team lock, then coordinator-group lock. Device-binding and Project-mapping routes acquire only the publication barrier, so they cannot introduce a lock cycle.

The barrier intentionally spans coordinator creation, conflict recovery, roster reload, and canonical local application. These operations are uncommon and correctness takes priority over cross-candidate write concurrency while publication is in flight.

## Scope

The barrier covers:

- legacy Team finish publication;
- device-binding commits;
- single and bulk Project-mapping upserts;
- Project-mapping deletion.

Read-only previews and mapping reads remain concurrent.

## Failure handling

Every route releases the barrier in `finally`, including validation, SQLite, coordinator, and response-construction failures. Existing route-specific error responses remain unchanged.

An interactive mutation can wait for the coordinator reconciliation budget of up to 60 seconds instead of reaching its SQLite-busy response while publication owns the barrier. This bounded availability cost is accepted to prevent a concurrent local write from being overwritten by the immutable coordinator winner.

## Verification

Route regressions will pause completion publication and assert that each affected mutation remains pending until publication finishes. Core tests will verify queue release after success and failure, and the full repository gate must pass before the existing PR stack is updated.
