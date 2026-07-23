# Sharing dogfood stabilization design

**Date:** 2026-07-23
**Status:** approved
**Scope:** exact-Project onboarding correctness and recipient-facing UX

## Goal

Make the disposable three-peer sandbox prove a truthful, understandable sharing journey: direct exact-Project access, Team inheritance, and add-device inheritance. A fresh recipient must never see fallback identity values, a completed state must mean the intended data can sync, and normal invitation acceptance must not require manual navigation through Advanced controls.

## Confirmed failures

- A profile created before device identity initialization leaves a fallback `local:local` actor, then projects a second device-backed local Identity.
- Invite inspection and import can reuse that stale fallback Identity, exposing internal values and causing `recipient_actor_conflict` on the inviter.
- Exact-Project acceptance can enroll coordinator presence while inviter-side setup remains `needs_attention`; the recipient receives no Project data but sees an apparently healthy state.
- The acceptance action promises to start syncing while the recipient remains configured with sync disabled.
- Sharing can inspect exact-Project invitations but redirects users to an inaccurate Advanced Team administration dead end.
- Recipient dialogs use an inconsistent close control and present review/result content as dense, repetitive text.

## Design

### Stable identity bootstrap

Device identity is established before a local actor profile is persisted or projected. If a long-lived viewer store began with the fallback device, invite inspection/import refreshes and adopts the ensured device identity before deriving recipient identity or display defaults. Dogfood fixtures seed human-readable profile names against the stable Identity and assert that each peer has exactly one distinct active local Identity.

### Truthful distributed acceptance

Coordinator token consumption remains the durable acceptance boundary, but it is not described as completed Project delivery. Exact-Project onboarding reports a pending setup state until inviter-side acceptance, recipient-policy persistence, trust, and initial sync converge. Terminal failures remain actionable and visible instead of being hidden behind coordinator presence.

An action labelled “Accept and start syncing” must enable the recipient data plane. If enabling cannot complete, the response and UI remain pending or failed rather than claiming success.

### Normal invitation journey

Sharing → Invitations owns preview and acceptance for Team-member, add-device, and current exact-Project invitations. Exact-Project review explicitly says the recipient receives direct access to the listed Projects and does not join a Team. Advanced retains legacy compatibility and manual pairing controls only.

### Health semantics

Coordinator presence, peer trust, sync enablement, onboarding progress, and data-plane health are separate signals. The primary Sync state is healthy only when sync is enabled and no onboarding or reconciliation blocker outranks it. Presence alone is labelled as enrolled/reachable, not Online.

### Dialog hierarchy

Recipient dialogs reuse the shared themed close control. Review states emphasize three answers: what is shared, with whom, and whether devices receive it now. Counts and write details become secondary. Result states use a completion-specific title and one success summary.

## Delivery stack

1. Stable identity bootstrap and dogfood fixture invariants.
2. Truthful exact-Project acceptance and sync activation.
3. Exact-Project acceptance in Sharing.
4. Sync status truthfulness.
5. Recipient dialog close treatment and information hierarchy.

## Error handling

- Identity refresh fails closed if a stable device identity cannot be established.
- Acceptance distinguishes pending setup from terminal conflict.
- Partial coordinator enrollment cannot render as completed Project delivery.
- UI errors use actionable, non-internal language while safe codes remain available to diagnostics.

## Validation

- Focused core, viewer-server, UI, and dogfood fixture tests for every layer.
- Full `pnpm run check` on the completed stack.
- Fresh three-peer sandbox validation covering direct Project access, Team inheritance, add-device inheritance, selected/unrelated future memories, offline recovery, and restart persistence.
- Independent code and test review before submission.
