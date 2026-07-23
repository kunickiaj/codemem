# Fresh recipient invitation bootstrap design

**Date:** 2026-07-23
**Status:** approved
**Scope:** Team-member and add-device invitation review and acceptance on fresh recipients

## Goal

Let a fresh codemem installation review and accept a Team-member or add-device invitation without already containing the Team, Identity, Project-recipient, or membership facts that the invitation establishes. The reviewed access must remain exact, coordinator-owned, key-bound, and fail-closed.

## Root cause

The inviter currently reviews recipient access from its local policy database, but the coordinator stores only a digest and target identifiers. During inspection and acceptance, the recipient rebuilds the review from its own database. A fresh recipient does not yet have the invited Team or target Identity, so Team review fails with `team_not_found`, add-device review fails with `identity_not_found`, and the viewer collapses both to `invite_invalid`.

The digest alone cannot reconstruct the reviewed Team, Project sources, exclusions, display names, or memory counts. Pre-seeding those facts would preserve the same bootstrap inversion.

## Reviewed intent snapshot

Recipient invitations store a canonical, versioned reviewed-intent snapshot alongside its digest. The snapshot contains only access intent and presentation facts owned by the inviter:

- journey kind;
- Team identifier, display name, and future-Project inheritance for Team invitations;
- target Identity identifier and display name for add-device invitations;
- included Projects with display names, existing-memory counts, future-memory behavior, and direct or Team sources;
- explicitly excluded Projects for add-device invitations, where the recipient is adopting the same Identity.

Team-member snapshots omit non-Team Project identifiers, names, and memory counts. The included Project list fully defines the Team grant without disclosing unrelated private Projects to an invitation bearer.

The snapshot excludes the eventual recipient device identifier, public key, fingerprint, and display name. Those values are unknown at invitation creation and remain bound locally during inspection and acceptance.

The invitation URL continues to carry only immutable target metadata and the reviewed-intent digest. It does not embed the snapshot.

## Data flow

### Creation

1. The inviter computes the access review from inviter-owned policy facts.
2. The viewer derives a canonical reviewed-intent snapshot, excluding the inviter's local device binding.
3. The coordinator validates the snapshot shape, kind, target metadata, and digest.
4. The coordinator stores the canonical snapshot JSON and digest with the invitation.

### Inspection

1. The recipient sends the bearer token to `/v1/invites/inspect`.
2. The coordinator returns the stored reviewed intent and immutable invitation metadata.
3. The viewer verifies the returned kind, target, and digest against the invitation payload.
4. The viewer combines the reviewed intent with the recipient's stable local device binding and computes a recipient-specific onboarding digest.
5. The UI renders that combined review without querying recipient-local Team or Identity policy rows.

### Acceptance

1. The recipient submits the caller-supplied, recipient-specific onboarding digest and key-bound device data; imports without that reviewed digest fail before the invitation is consumed.
2. The coordinator revalidates expiry, revocation, target Identity, token binding, and device-key fingerprint before consuming or replaying the invitation.
3. The acceptance response returns the same stored reviewed intent and digest.
4. The recipient verifies both again, then atomically materializes the minimum local Identity, Team, membership, and device facts required by the journey.
5. Acceptance enables local sync with safe defaults so the reviewed Projects can arrive; when the sync runtime is currently disabled, the viewer explicitly asks for a restart.
6. Repeated acceptance remains idempotent. Conflicting existing policy or device bindings fail closed.

For add-device onboarding, a pristine bootstrap Identity may be replaced by the invitation's fixed target Identity. A non-pristine or differently bound local Identity remains a conflict; the invitation cannot silently reassign an established profile.

## Storage and compatibility

Add a nullable reviewed-intent JSON column to both coordinator stores. Existing legacy, exact-Project, and pre-migration recipient invitations remain readable. A recipient invitation without a valid stored snapshot cannot use the fresh-recipient path and returns a safe recreate-invitation error rather than inventing access intent.

The TypeScript coordinator and Cloudflare Worker use the same validation and canonicalization contract. Invalid or oversized snapshots are rejected at the admin API boundary.

## Error handling

- Payload, coordinator target, and reviewed-intent digest mismatches return `recipient_invite_intent_mismatch`.
- Missing or invalid stored snapshots return `recipient_invite_review_unavailable`.
- A non-pristine local Identity that conflicts with an add-device target returns `invite_identity_conflict`.
- Expired, revoked, replay-conflicting, or key-conflicting invitations retain their existing fail-closed behavior.
- The viewer maps safe codes to contextual guidance and does not collapse every recipient-review failure to `invite_invalid`.

## Validation

- Core unit tests cover canonical intent normalization, digest validation, snapshot-based preview, atomic commit, conflicts, and idempotency.
- Both coordinator store implementations pass the shared contract suite for create, inspect, accept, and replay.
- Coordinator API and Worker tests cover malformed, mismatched, missing, and valid reviewed intent.
- Viewer integration tests create invitations on an owner and inspect/accept them on recipients with empty policy tables for both journeys.
- Existing exact-Project and legacy invitation tests remain unchanged and green.
- A rebuilt disposable sandbox proves Team and add-device review and acceptance before broader sharing isolation is re-evaluated.

## Delivery

Ship as one additional Graphite PR on top of the sharing dogfood stabilization stack:

`fix(sharing): bootstrap fresh recipient invitations`

Copy/IA cleanup and the separate Project-isolation leak remain outside this PR.
