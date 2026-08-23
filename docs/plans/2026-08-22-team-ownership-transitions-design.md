# Team Ownership Transitions Design

**Status:** Approved on 2026-08-22
**Bead:** codemem-1jqh

## Problem

Three core writers independently decide whether guided setup or an invite owns a
Team membership or device decision. The repeated provenance lists and SQL
conditions have already drifted across activation, onboarding, and coordinator
reconciliation, multiplying the review surface for authorization-sensitive code.

## Goals

- Define one internal policy for setup-owned and invite-owned rows.
- Express allowed membership and device-decision transitions as pure functions.
- Make activation, onboarding, and coordinator reconciliation consume that policy.
- Preserve all current SQL transaction boundaries, metadata, fingerprints,
  revisions, counters, and fail-closed behavior.

## Non-goals

- A generic state-machine framework.
- Schema or public API changes.
- Consolidating the writers' SQL or digest formats.
- Changing lifecycle behavior pinned by existing integration tests.

## Ownership Model

Setup owns membership or decision rows whose provenance is
`reviewed_active`, `reviewed_team_candidate`, or `reviewed_team_setup`. Invite
flows own rows whose provenance is `team_invite` or `coordinator_invite`.
Unknown provenance is deliberately classified as other and receives no implicit
authorization transition.

The new `team-ownership-transitions.ts` module remains internal to the core
package. It exposes typed, pure classifiers and transition planners rather than
executing SQL. Writers continue to own persistence and caller-specific metadata.

## Membership Transitions

For a setup activation, a desired setup-owned row may be written or reactivated.
An invite-owned row remains invite-owned, including its invite metadata, while a
reviewed Team may normalize its active status to `reviewed_active`. Setup cleanup
may revoke setup-owned rows only; invite-owned and unknown rows are preserved.

For an invite, an absent row may be inserted. An active setup-owned row may be
adopted by the invite, and a revoked setup-owned row may be explicitly
reauthorized by a newly consumed invite. A reviewed Team may normalize a legacy
invite-owned `active` row to `reviewed_active`. Already-correct invite rows are
unchanged. Other rows fail closed.

## Device-Decision Transitions

Setup activation may write setup-owned decisions. When an invite already owns a
decision, activation may update the reviewed decision and assignment version but
must preserve invite provenance and revision. Setup cleanup may delete only
setup-owned decisions. Invite-owned decisions removed from the actionable roster
settle to non-granting `excluded` where current behavior requires it.

Invite onboarding and coordinator reconciliation may adopt a setup-owned decision
while preserving its reviewed decision. Newly reauthorized coordinator
memberships retain the existing behavior of replacing non-setup decisions with an
invite-owned unresolved decision. Unknown rows otherwise remain unchanged.

## Validation

Add table-driven tests for ownership classification and each pure transition
matrix. Keep the existing activation, onboarding, and coordinator reconciler
tests as integration coverage, then run core type checking, lint, and the core
test suite.

## Implementation Order

1. Add the internal policy module and transition-matrix tests.
2. Replace activation's repeated ownership conditions with planned actions.
3. Replace onboarding's adoption conditions with planned actions.
4. Replace coordinator reconciliation's branching with planned actions.
5. Run focused tests, core gates, and review the resulting diff.
