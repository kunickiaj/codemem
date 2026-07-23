# Exact-Project Local-Default Isolation Design

**Date:** 2026-07-23  
**Status:** Approved  
**Bead:** `codemem-l72f`

## Problem

Exact-Project invitation acceptance enables the sync runtime before inviter-side provisioning necessarily finishes. A recipient can therefore restart, pair, and run the legacy unscoped bootstrap while the selected Project is still waiting for its managed scope, grants, and source-memory reassignment. Dogfood reproduced an unrelated source memory arriving under `local-default` before provisioning completed. Later provisioning moved the selected memory but did not remove the unrelated row.

The race exposed a deeper invariant violation: an unscoped transport request was able to make `local-default` act like a replication authorization boundary. It is not one. `local-default` is local-only and must never replicate, including through legacy compatibility behavior.

## Invariants

1. A regular memory op or snapshot row with null or `local-default` scope never crosses a peer boundary.
2. Unscoped transport is not unscoped authorization. It may carry an explicitly authorized non-default scope, but it never widens access.
3. Exact-Project acceptance may make the recipient reachable, but Project data remains unavailable until managed-scope provisioning is authoritative.
4. Serving, sending, and receiving each enforce the local-only boundary independently.
5. Recovery deletes only rows proven to be remote-origin local-only data. Locally owned or ambiguously owned rows are retained.
6. A share operation becomes active only after its scoped initial sync succeeds.

## Considered approaches

### Control the data boundary at every sync surface — selected

Keep the existing sync runtime and transport compatibility, but deny null and `local-default` regular memory data when serving snapshots or ops, filtering outbound ops, and validating inbound ops. Continue to allow narrowly defined control operations such as targeted access cleanup and old-side reassignment.

This directly enforces the global invariant, closes the observed race without introducing another distributed lifecycle flag, and preserves explicitly scoped replication.

### Persist a per-invitation provisioning hold

Block the peer until inviter provisioning reaches `active`. This adds distributed state and another race-prone authorization mechanism, while still requiring the global local-only boundary fix for non-invitation peers. Rejected.

### Remove the unscoped transport lane

This is conceptually simple but unnecessarily disrupts authentication, cleanup delivery, reassignment compatibility, and existing transport sequencing. Rejected for this P0 fix.

## Data flow

```text
accept invitation
  -> persist pending setup and make recipient reachable
  -> status/authentication succeeds
  -> null/local-default regular data remains blocked
  -> inviter creates managed Project scope and grants devices
  -> inviter reassigns selected source memories
  -> recipient observes mutually authorized scope
  -> scoped snapshot/incremental sync transfers selected data
  -> successful scoped initial sync marks operation active
```

A pending or partially failed setup performs a safe zero-data exchange when no authorized Project scope is available. It never falls back to local-default data.

## Boundary enforcement

### Serving

Legacy/unscoped snapshot and op endpoints omit regular memory rows whose effective scope is null or `local-default`, even when project filters are broad. Explicitly scoped requests continue to require current sender and receiver authorization.

### Sending

Outbound filtering denies every regular null or `local-default` memory op. Project filters and legacy capability cannot widen this result. Targeted `access_cleanup` and valid old-side `reassign_scope` operations remain control-plane exceptions because they retract previously delivered data rather than grant access.

### Receiving

Inbound validation rejects regular null-scope memory ops as `missing_scope` and explicit `local-default` memory ops as `scope_mismatch` before any entity mutation. This local-only guard remains active even where broader legacy scope validation is disabled.

## Recovery cleanup

Before exchanging data with a peer, reconciliation inspects active rows associated with that peer. A row is safe to delete when:

- `origin_device_id` identifies the remote peer;
- the effective scope is null or `local-default`; and
- the row is not locally owned.

Cleanup physically removes the memory row, references, and vector work. It is idempotent and does not mint a recipient-authored deletion op. Rows with missing or ambiguous origin remain untouched and visible in diagnostics. Existing targeted access-cleanup behavior remains available for explicit scope changes and revocations.

This intentionally removes remote legacy local-default rows: compatibility cannot preserve data whose original transfer violated the local-only invariant.

## Error handling and diagnostics

- Null inbound scope: `missing_scope`.
- Explicit inbound `local-default`: `scope_mismatch`.
- Ambiguous cleanup ownership: retain the row and report it for review.
- No authorized Project scope: keep invitation/setup state pending; do not report Project access as active.
- Failed scoped initial sync: keep the share operation resumable and non-active.

Diagnostics must not expose memory payloads.

## Validation

### Unit tests

- Broad project filters cannot make null or `local-default` ops outbound-eligible.
- Unscoped snapshots omit null and `local-default` rows.
- Inbound null and `local-default` regular ops are rejected under both scoped and legacy capability paths.
- Targeted cleanup and valid reassignment control operations still apply.
- Reconciliation removes remote-origin null/default rows, retains local rows, retains ambiguous-origin rows, and is idempotent.

### Integration tests

Reproduce acceptance, recipient restart, and delayed inviter provisioning. Assert that unrelated existing data never appears, selected existing data arrives only after provisioning, selected future data arrives, unrelated future data never arrives, and partial setup never broadens access.

### End-to-end test

Exercise the real viewer acceptance, config/restart, background advancement, and scoped synchronization sequence from dogfood. The test must check for transient leakage before advancing provisioning, not only final state.

## Compatibility and rollout

The change deliberately ends replication of null and `local-default` memory data for every peer capability. Explicit non-default scopes continue to use the existing compatibility transport where authorized. No schema migration is required. Existing invalid remote-origin local-default rows are removed conservatively during peer reconciliation.

## PR structure

Land the design, implementation plan, tests, sync-boundary changes, cleanup, and end-to-end regression in one focused PR above the fresh-recipient onboarding fix. Splitting the defenses would temporarily leave an incomplete security boundary.
