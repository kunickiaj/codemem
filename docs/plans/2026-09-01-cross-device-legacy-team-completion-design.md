# Cross-device legacy Team completion design

## Decision

Legacy Team migration completion becomes coordinator-owned so every enrolled device converges on one canonical result. The first valid completion wins, exact retries are idempotent, and conflicting later completions fail closed.

## Problem

Finishing legacy Team setup currently writes terminal state only to the local database. Another device can load the same coordinator roster, rediscover the same candidate, and ask the user to repeat a migration that already produced canonical Sharing policy elsewhere.

Hiding the candidate alone is unsafe because the second device would lack the Team, memberships, device decisions, and Project-recipient policy created by the migration. Peer-to-peer propagation alone is also insufficient because the finishing device may be offline when another device checks setup.

## Goals

- Make one completed migration authoritative across every device in a coordinator group.
- Apply the canonical Team policy locally before suppressing the setup candidate.
- Preserve the existing confirmation digests, bounded evidence, and fail-closed behavior.
- Recover migrations completed before this protocol ships.
- Avoid per-device or per-Project coordinator query loops.

## Non-goals

- Move memory payload sync through the coordinator.
- Allow later devices to revise a completed migration.
- Merge unrelated legacy groups that happen to share a display name.
- Make coordinator group membership grant Team or Project access automatically.

## Coordinator contract

The coordinator stores a versioned, bounded completion manifest keyed by group and legacy candidate identity. The manifest contains only the canonical policy facts required to reproduce the confirmed migration:

- candidate, Team, source, finish, and access-delta digests;
- Team display metadata and policy revision;
- reviewed identity memberships and device decisions;
- canonical Project mappings and Team recipient edges;
- completion time and manifest version.

The payload excludes local paths, raw coordinator credentials, and browser-only opaque labels. Existing identifier and collection limits apply before any write.

Creation is compare-and-set:

1. The first valid manifest is inserted.
2. A byte-equivalent semantic replay returns the stored completion.
3. A different manifest for the same candidate returns `409 completion_conflict`.
4. Reads return the immutable stored manifest or an authoritative absence.

The D1 store uses one indexed lookup for a candidate and one bounded batch lookup for the same configured and active scope-backed group union used by candidate discovery. This keeps normal setup polling within the coordinator's free-tier query budget.

## Finish flow

The coordinator is the distributed commit point.

1. The viewer validates the current draft, roster, preview, and submitted confirmation digests as it does today.
2. It derives the bounded completion manifest from the confirmed preview.
3. It creates or replays that manifest at the coordinator.
4. It applies the returned canonical manifest to the local policy tables in one SQLite transaction, without re-deriving or revalidating mutable preview state after publication.
5. It records the local setup draft as completed and returns the existing completed response.

If coordinator publication fails, local activation does not proceed. If coordinator publication succeeds but the local transaction fails, retrying fetches the same manifest and safely reapplies it.

The final freshness check happens before publication. Once accepted, the immutable manifest is the application input rather than a hint for a second preview pass, so local changes during the coordinator request cannot invalidate the winner after it becomes canonical. Application rebases local assignment compare-and-set evidence onto current state, applies the coordinator-owned device decisions, and bounds the actual derived access delta before writing.

## Reconciliation flow

Team setup summary and detail loading fetch completion manifests with the same bounded coordinator read used for current roster evidence. For each completion not yet represented locally, the viewer:

1. validates the manifest version, bounds, identifiers, digests, and coordinator group;
2. applies the Team, memberships, device decisions, Project mappings, and recipient edges atomically;
3. records terminal local migration evidence;
4. omits the candidate from pending setup results.

A completion is never hidden before successful local application. Invalid, conflicting, partial, or unavailable completion evidence leaves setup blocked and returns a safe retryable error.

During rolling upgrades, a coordinator winner also supersedes a different pre-protocol local completion. The viewer atomically replaces compatible local policy with the canonical manifest and makes old completion evidence ineligible for replay. If local evidence cannot safely host the winner, it deactivates the divergent Team policy, revokes setup-owned Project recipient edges, invalidates old replay evidence, and keeps setup blocked rather than continuing to enforce different access. A later successful reconciliation reactivates the canonical Team and restores only the winner's recipient edges.

## Existing completions

An upgraded device with an existing canonical local completion reconstructs its manifest from immutable setup evidence and policy rows, then publishes it opportunistically during Team setup loading. Publication follows the same compare-and-set rules.

This makes prior migrations converge once any completed upgraded device contacts the coordinator. A stale device remains pending until that publication occurs; it never guesses that another device finished.

## Errors and observability

Coordinator completion failures use stable categories rather than collapsing into roster unavailability:

- `team_setup_completion_unavailable` for retryable coordinator failures;
- `team_setup_completion_conflict` when another manifest already won;
- `team_setup_completion_invalid` for malformed or untrusted evidence.

Server logs retain the safe upstream category and status without credentials or manifest contents. The UI continues to show recovery-oriented copy and never renders raw coordinator responses.

## Compatibility

Older coordinators that do not expose the completion API cannot provide cross-device completion. New viewers detect that capability and fail closed at finish rather than create another local-only completion. Existing locally completed migrations remain usable and publish when connected to an upgraded coordinator.

Older viewers ignore the new coordinator records and retain their current behavior. Upgrading those viewers enables reconciliation without changing their local database format beyond existing schema initialization.

## Validation

- Coordinator store contract tests cover create, exact replay, conflict, bounds, group isolation, and batch reads.
- D1 runtime and Worker tests cover the new API and migration.
- Core tests cover manifest derivation, validation, idempotent local application, divergent completion replacement and containment, replay invalidation, bounded access deltas, and rollback.
- Viewer tests cover publish-before-apply, immutable application after publication-time drift, retry after local failure, existing-completion publication, remote reconciliation, suppression after apply, and safe errors.
- Cross-device E2E finishes on one node, loads setup on another, verifies identical canonical policy, and confirms the candidate disappears.
- Each stack layer runs focused tests; the stack tip runs `pnpm run check` and the legacy Team migration E2E.

## Delivery stack

1. Coordinator schema, store, API, actions, and contract tests.
2. Viewer finish publication, local reconciliation, and existing-completion recovery.
3. Cross-device E2E, user documentation, and error-copy coverage.
