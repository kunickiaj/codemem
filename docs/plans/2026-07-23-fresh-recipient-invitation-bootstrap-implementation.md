# Fresh recipient invitation bootstrap implementation plan

**Date:** 2026-07-23
**Design:** `docs/plans/2026-07-23-fresh-recipient-invitation-bootstrap-design.md`
**Bead:** `codemem-wosg`

## 1. Contract and pure validation

- Add a versioned recipient reviewed-intent type in core.
- Add pure normalization, canonical serialization, and digest helpers.
- Separate access intent from recipient-specific device binding in onboarding previews.
- Add failing unit tests for Team and add-device snapshots, malformed inputs, target mismatches, ordering, and digest mismatches.

## 2. Coordinator persistence

- Extend the coordinator invite contract with nullable reviewed-intent JSON.
- Add the additive SQLite and Cloudflare D1 schema migrations.
- Update both store implementations and the shared store harness.
- Prove valid snapshots survive create, inspect, acceptance, and idempotent replay.
- Prove missing or malformed snapshots fail closed for current recipient invitations.

## 3. Coordinator API and actions

- Send reviewed intent during recipient invitation creation.
- Validate kind, target metadata, size, canonical form, and digest at the admin API boundary.
- Return reviewed intent from inspect and acceptance responses.
- Keep invitation links digest-only.
- Add API/action regressions for tampering, expiry, revocation, target mismatch, key mismatch, and replay.

## 4. Fresh-recipient local onboarding

- Build inspection previews from coordinator-reviewed intent plus the stable local device binding.
- Add snapshot-based atomic commit for Team membership and add-device binding.
- Materialize missing Team/Identity facts only from validated reviewed intent.
- Allow safe add-device adoption only from a pristine bootstrap Identity; reject established conflicting profiles.
- Preserve idempotency and existing device-key conflict protections.

## 5. Viewer and UI integration

- Stop rebuilding recipient invitation intent from recipient-local policy rows.
- Preserve kind, target, and digest checks across payload, inspect, and acceptance.
- Return safe contextual review errors instead of a blanket `invite_invalid`.
- Keep the current Team and add-device review layout, now populated from coordinator-owned facts.
- Add owner-create to fresh-recipient inspect/accept integration tests for both journeys.

## 6. Validation and review

- Run focused core onboarding, coordinator store/API/action, Worker, viewer-server, and invitation UI tests.
- Run `pnpm run tsc`, `pnpm run lint`, and the affected package tests.
- Run `pnpm run check` before submission.
- Run CodeReviewer, TestEngineer, and pragmatic maintainability review.
- Rebuild and reset the disposable sandbox, then repeat Team and add-device onboarding on fresh recipients.
- Create the PR with `gt create`, submit the stack, populate the PR template, mark it ready, and verify PR metadata.
