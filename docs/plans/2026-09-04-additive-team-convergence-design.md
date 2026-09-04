# Additive Team Convergence

## Decision

Completed Team setup reconciliation will materialize only canonical Projects that become locally resolvable after the initial completion. It will not replay device assignments, memberships, existing Project mappings, or cleanup during this additive pass.

## Why

A full activation is correct for the first canonical apply because the coordinator winner defines the reviewed policy. After completion, users can legitimately rebind devices and edit or delete Project mappings. Replaying the full activation when another canonical Project becomes resolvable would overwrite those later user actions.

## Data flow

Reconciliation compares the reconstructed completed manifest with the coordinator winner and resolves the winner's locally supported Projects. When the only difference is newly resolvable Projects, it rewrites the completed draft with those new Project rows and passes their refs to a project-only activation path. That path validates and writes only those mappings and Team recipients while intentionally preserving the original completion record.

Initial completion, replacement-draft recovery, and divergent canonical policy continue through the existing full activation path.

## Failure handling

Project-only convergence remains transactional. Invalid scope evidence, conflicting selected mappings, or completion-history collisions roll back the new Project rows and writes without containing the already-valid completed Team policy.

## Verification

Regression coverage will start from a partial canonical completion, apply a post-completion device rebind and mapping deletion, make another canonical Project resolvable, and verify that only the new Project is materialized. Existing canonical replay and replacement-draft tests must continue to pass.
