# Sharing dogfood stabilization implementation plan

**Date:** 2026-07-23
**Design:** `docs/plans/2026-07-23-sharing-dogfood-stabilization-design.md`

## PR 1 — Stable identity bootstrap

- Add regressions for fallback actor adoption and unique local Identity projection.
- Ensure viewer invite inspection/import uses a stable ensured device Identity.
- Initialize dogfood peer identities before profile fixture records.
- Assert one distinct human-named local Identity per peer.
- Validate focused core, viewer-server, and dogfood unit tests.

## PR 2 — Truthful exact-Project acceptance

- Add failure and success tests around coordinator acceptance versus inviter-side completion.
- Enable data sync when exact-Project acceptance promises to start it.
- Represent post-consumption Project setup as pending until convergence.
- Surface terminal acceptance/provisioning failures to recipient and owner.
- Prove selected existing data arrives and unrelated data remains absent.

## PR 3 — Sharing invitation acceptance

- Extend the normal invitation dialog to review exact-Project intent.
- Accept the reviewed exact-Project invitation without repasting or Advanced navigation.
- Explain direct access versus Team membership.
- Preserve legacy-only fallback under Advanced.
- Add Preact interaction, focus, and API request tests.

## PR 4 — Sync status truthfulness

- Derive primary status from sync enablement, onboarding/reconciliation blockers, trust, and presence in that order.
- Replace false Online/no-work states with explicit pending, disabled, or needs-attention guidance.
- Add status/view-model and rendered UI regressions.

## PR 5 — Recipient dialog UX

- Replace raw close buttons with the shared dialog close control.
- Refactor review and result content into concise semantic summaries.
- Remove repeated mutation/write messages from normal completion copy.
- Verify keyboard, screen-reader, dark/light theme, long-name, and responsive behavior.

## Final gate

- Run focused tests after each PR slice.
- Run `pnpm run check` on the full stack.
- Run CodeReviewer, TestEngineer, and pragmatic maintainability review.
- Reset and run the disposable sandbox from merged stack code.
- Complete the full manual dogfood checklist and capture safe diagnostics before submission.
