# Coordinator Identity-group grant storage

**Scope:** Internal storage prerequisite for the [reviewed device-registration
boundary](coordinator-identity-enrollment.md). No public route, automatic issuance,
device enrollment, Project permission, or live migration is enabled by this slice.

## Why this record is separate

An enrollment's actor hint is not verified ownership. A transport grant records
reviewed permission for an Identity to enroll devices into a coordinator group.
It is independent of the original device, so removing that device does not erase
the Identity's transport permission. Groups remain distinct from Teams and Projects.

`coordinator_identity_group_grants` has one record per coordinator, Identity and
group. It records `status`, monotonic `revision`, `source_kind`, `source_receipt_id`,
`created_at`, and `revoked_at`. Revoked records remain tombstones; there is no
foreign key that cascades from a device or controller record.

Revoking the source controller attestation does not revoke grants already issued
from it. Operators must revoke the Identity-group grant separately; there is no
cascade. Future management UI must distinguish these actions rather than imply
that ending a device's controller authority ends the Identity's transport grant.

## Supported internal operations

- `issueIdentityGroupGrantFromControllerAttestation({coordinatorId, attestationId})`
  derives the Identity and group from current server-owned evidence. The caller
  cannot select their replacement values. The attestation must be active and
  match an enabled enrollment's device, key, fingerprint and captured Identity;
  the group must not be archived. Issuance records the controller's review receipt.
- `listIdentityGroupGrantRevisions({coordinatorId, identityId})` returns active and
  revoked records in group-ID order. It does not revalidate the original device
  or truncate the authority set.
- `revokeIdentityGroupGrant({coordinatorId, identityId, groupId, expectedRevision})`
  changes only an active record at that exact revision. It increments the revision
  and records revocation. There is no automatic reactivation operation.

Issuance returns `created`, `existing`, or a fixed rejection. SQLite checks and
writes inside an immediate transaction. D1 inserts with a guarded statement and
checks exact retries against current evidence and the active grant in one read.
A retained grant is not proof that a later issuance retry still has valid authority.

`compareIdentityGroupGrantRevisions` compares complete canonical snapshots without
mutating their order. It rejects empty, malformed, duplicate, mixed-scope, or
over-limit sets; the comparison limit is the existing 50-group coordinator limit.
Matching revoked snapshots can compare equal. Equality is **not** authorization
and does not provide the atomic compare-and-write needed for future enrollment.

The 50-row comparison limit includes retained revoked records. An Identity with
more than 50 historical groups cannot compare a complete snapshot with this helper.
It fails closed, not by truncating history. The future enrollment contract must
resolve how active eligibility and retained history participate in its atomic check.

## Deliberate limits

This slice supports only reviewed-controller issuance. It does not backfill from
`enrolled_devices.identity_id`, legacy or Project-share enrollment, or historical
`add_device` receipts. Trusted `team_member` issuance belongs to the invitation
work and is not exposed through a generic caller-selected source kind.

Issuance is idempotent only for the original review receipt. A different valid
controller receipt for the same already-granted Identity/group does not replace
the source or revive the row; it currently receives the fixed authority rejection.

Store methods are internal capabilities, not authenticated management endpoints.
Any future caller must enforce operator authority before invoking them. This slice
does not mount such a caller or automatically issue grants after an owner review.
The Worker migration is source only; applying it remotely needs separate approval.

## Verification boundary

Tests must cover issuance and exact retries, current-evidence rejection,
grant-specific revision checks, retained tombstones, and persistence after removal
of the old device. SQLite, D1-compatible fixtures, and native Worker D1 must agree.
These tests do not certify the future enrollment endpoint or live Google flow.
