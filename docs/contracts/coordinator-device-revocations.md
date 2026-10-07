# Coordinator device-revocation admission

**Scope:** Internal revocation storage and signed-request admission. No public
revocation action, automatic backfill, owner enrollment, or live migration is
enabled. Enrollment-writer guards and discovery/bootstrap closure are required
before a management route can expose this capability.

## Subjects and scope

`coordinator_device_revocations` keeps immutable subjects of two kinds:

- `device_id`: prevents that identifier from regaining access through a new key.
- `ed25519_key`: the canonical key ID prevents the same key from regaining access
  through another device ID or SSH text representation.

Subjects apply to the whole coordinator database. Legacy groups, enrollments and
nonces already share that database and have no coordinator-ID tenant boundary.
Browser-auth coordinator namespaces do not partition these records. There is no
caller-selected coordinator, group or Project scope that bypasses the check.

Records retain exact enrollment evidence, an audit actor when supplied, a
server-generated revocation ID and creation time. Audit metadata is not ownership
proof. Records have no foreign keys, expiry, update or deletion operation; the
first record for a subject remains unchanged.

The [canonical key metadata path](coordinator-ed25519-key-identity.md) uses the
standard Buffer decoder in both server runtimes. Legacy text fingerprints and
signature-verifier acceptance remain unchanged.

## Internal recording and queries

`createDeviceRevocation` requires the exact current group/device/public-key/
legacy-fingerprint tuple, including disabled enrollments. It records the device
subject and, for a recognized Ed25519 key, the key subject in one transaction.
An opaque fixture or unsupported key can produce only a device subject.

The method is a trusted internal capability, not an authenticated endpoint.
Future management callers must authorize the operator separately; an enrollment
actor hint is not sufficient ownership proof. Removal of the current tuple
prevents creation and exact retry. Already-removed device evidence needs a
separately reviewed path; retained records can still be queried.
Legacy identifiers longer than the 256-character subject limit remain eligible
for signed admission, but this primitive cannot create their device-ID tombstone.
Management must define a reviewed key-only or equivalent path before claiming
such devices can be revoked; it must not silently report success.

`listDeviceRevocations` matches only the supplied subject filters:

- `{deviceId}` returns matching device-ID subjects, not an implicit lookup of keys.
- `{publicKey}` derives the canonical key ID and returns matching key subjects.
- Both fields return their union. An empty query is rejected.

Queries are not permission checks and do not discover all aliases or historical
keys automatically. Future management and discovery code must use the relevant
key as well as the device ID and implement the separately tracked closure rules.

## Atomic signed-request admission

First-party signed coordinator requests must call `recordAuthorizedNonce`, not
the retained low-level `recordNonce` compatibility primitive. Signature validation
occurs first; unsigned or invalid signatures cannot probe revocation status.
Custom coordinator stores must implement the new required storage methods; there
is no optional fallback to the old nonce primitive.

Nonce insertion checks the current exact enrollment key, enabled state,
unarchived group and both revocation subjects in one guarded SQL operation.
SQLite and D1 execute insertion and denial classification in one transaction.
The insertion is the admission point: a prior committed revocation denies the
request; already-admitted work is not retroactively cancelled.

Successful insertion returns `recorded`. Denials distinguish replay, revocation,
missing or changed enrollment, disabled device, and missing or archived group.
A zero-row insertion never becomes success through a later read. A valid
signature on a revoked device returns `403 device_revoked` on legacy signed
routes. Account-link routes preserve their existing masked
`auth_link_unavailable` denial instead of exposing this detail. Bad signatures
retain their existing rejection behavior.

Backend exceptions or incomplete results reject with the fixed error
`device_revocation_incomplete`. This prevents raw database diagnostics from
crossing the boundary. An unconfirmed write is not proof that nothing changed;
the caller must reconcile rather than claim success or rollback.

The actual Worker entry now uses the standard `node:buffer` metadata bridge.
Only that supported builtin is added to the bundle import policy; other blocked
Node modules, native packages and assets remain blocked. Node compatibility flags
are unchanged, and native tests and bundle checks gate this integration.

## Direct enrollment and re-enable guards

Direct enrollment/upsert and `setDeviceEnabled(..., true)` now check device-ID
and canonical-key subjects in the statement that changes the enrollment. A
separate pre-read is not permission to write. SQLite direct enrollment runs in
an immediate transaction; D1 uses a guarded insert/upsert.

D1 captures enrollment input values before asynchronous hashing. Enabling also
pins the public key read for that device and compares it in the guarded update;
revocation or key drift cannot enable a different unchecked key. An enable denial
returns `false`, while an enrollment denial uses the fixed `device_revoked` error.
Existing authenticated admin/join acceptance paths translate that error to 403
where the shared enrollment primitive can reject it.

Disabling, removal, raw fingerprints, and existing Identity-conflict checks retain
their behavior. With no revocation subjects, ordinary enrollment remains unchanged.
Removing an enrollment does not remove retained revocation subjects.

The shared synchronous SQLite enrollment primitive also protects callers already
inside a transaction. This is not proof that every invitation/join path is guarded:
their D1 batch consumption and retry predicates still need the next writer slice,
as do bootstrap/controller/link/group-grant authority writes.

## Recipient invitation guards

Team-member and add-device invitation acceptance checks both the recipient and
the recorded inviter. Each check uses the device ID and the canonical key derived
from its actual public key. Inviter key evidence comes from the current enrollment,
including disabled rows; no historical invitation-time key is inferred after removal.
A retained inviter device-ID subject still denies acceptance after removal.

SQLite checks participants inside an immediate transaction, guards enrollment and
identity repair at their writes, and rechecks before returning. A denial rolls back
the invitation binding, enrollment, and any grant created in that transaction.
D1 pins the inspected invitation and current inviter tuple in each sensitive
statement, including binding, enrollment, identity repair, and grant recovery.
A zero-row binding cannot authorize a downstream statement by itself.

Already-bound retries must pass the same participant checks. Missing or disabled
inviters retain the existing no-grant behavior unless a revocation subject applies.
Changed D1 evidence fails closed instead of silently switching to a different seed.
Recipient acceptance maps `device_revoked` to 403 after normal invitation validation;
inspection responses remain unchanged.

D1 acceptance and later repair/recovery can span separate commits. A revocation
that arrives after a successful batch prevents later protected writes and success,
but does not undo that earlier batch. Callers must not describe such rejection as
proof that no state changed. Existing grants and their history remain intact.

## Project invitation guards

Project invitation consumption and bound retries check recipient and current
inviter device-ID/canonical-key subjects too. The write predicates pin the reviewed
Project intent, operation, invitation evidence, current inviter tuple, and exact
recipient binding. Changed evidence cannot silently authorize a different seed
or recipient. Each D1 binding, enrollment, grant, and identity-repair statement
owns its guard; a zero-row binding is not permission for later writes.

SQLite uses an immediate transaction and final participant checks, so denial rolls
back its acceptance effects. D1 can reject after a prior batch committed; later
denial is not proof of rollback. Existing grants and historical records remain
untouched. Missing/disabled inviters retain no-grant behavior unless revoked, and
removed historical inviter keys are not inferred. Existing Project acceptance
maps `device_revoked` to 403 after normal invitation validation.

D1 denial checks the pinned revocation subjects before inspecting fresh state.
Revoking that captured inviter key still produces `device_revoked` if the
enrollment is removed or rotated before execution; it does not become a generic
incomplete response merely because the current enrollment no longer holds that key.

## Join approval guards

Pending join approval checks the requested device's ID and canonical key and,
when issuing a bootstrap grant, the current enabled seed's ID and canonical key.
Seed authority remains current enrollment in the same group with a different
device ID; a reviewer name or actor hint does not prove ownership.

SQLite reads pending state inside an immediate transaction. Enrollment, optional
grant, and the conditional status transition share that transaction. D1 requires
an atomic batch for approval, pins the request and seed evidence, and chains each
writer to the previous statement's affected-row count. An approved status with
the same timestamp is not proof that this invocation won the pending transition.
Lost transitions return the existing `_no_transition` result without granting
authority. Denial remains available for revoked pending devices and on D1 adapters
without batch support; already-reviewed requests retain their existing precedence.

The API returns fixed `503 join_review_unavailable` when atomic approval is not
available and `503 join_review_incomplete` for stale or unconfirmed outcomes.
Applicable device revocation retains `403 device_revoked`. SQL assertion failures
abort the batch for detected evidence drift; database diagnostics are not returned.
Malformed receipts and synthetic triggers that suppress a write without raising
a SQL error can produce an incomplete response after commit. That response is not
proof of rollback, and callers must reconcile current state rather than retry as
though nothing changed.

## Trusted Identity-group grant issuance

Issuance and exact retry derive a canonical key ID from the actual current
controller enrollment. Both SQL operations independently check device-ID/key
subjects and pin the enrollment key, fingerprint, Identity, and group alongside
the existing controller evidence. D1 cannot authorize a write from an earlier
pre-read after that tuple changes; SQLite derives the key inside its immediate
transaction.

A revoked or changed source returns the existing `grant_authority_unavailable`
rejection. Invalid input retains `invalid_grant_input`. Backend exceptions use
the fixed `identity_group_grant_write_incomplete` error rather than database
details; an unconfirmed write is not proof that no grant was committed.

Already-issued grants remain independent of their former source device. Listing,
revision comparison, and explicit grant revocation do not depend on that device's
current enrollment or revocation state. Source-device revocation blocks issuance
and success retries, but does not silently revoke transport grants or memberships.

## Current controller authority

Controller attestation creation, exact retries, snapshot-aware retries, and active
lookups now check device-ID and canonical-key revocation subjects. Each operation
derives the key from the actual enrollment and pins its group, device ID, key,
fingerprint, and Identity in the final SQL. A pre-read cannot authorize a later
insert or active result after that tuple changes.

Existing reviewed evidence and ownership requirements remain intact. Creation and
retry retain their existing rejection codes; unavailable active lookups return
`null`. Ordinary active-read Identity eligibility is unchanged, including an
unassigned enrollment later binding to the same attested Identity. Snapshot-aware
review retries still require the exact reviewed snapshot.

Stored attestations, account links, browser sessions, and already-issued grants
are not deleted or silently revoked. D1 can insert an attestation before a later
active lookup detects revocation; its incomplete result does not imply rollback
of that earlier insert.

Account-link creation/finalization reconstruct controller authority in separate
SQL; active-controller lookups alone are not permission for their later writes.

## Reviewed account-link authority

Existing first-account linking now guards attempt creation, exact creation retry,
and final consumption against device-ID/canonical-key subjects. Authority metadata
comes from the actual enrollment. The final SQL pins its group, device, exact key,
fingerprint, and nullable Identity alongside the controller Identity, attestation,
review receipt, and revision captured before hashing.

These checks add denial conditions; they do not replace ownership or completion
proofs. Both runtime-verifier and completion-secret hashes, exact signer binding,
confirmed state, configuration, expiry, and existing browser/OIDC proofs remain
required. Consumption, account-link insertion, and the redacted audit event remain
atomic, with downstream effects tied to this invocation's fresh link ID.

Revocation or tuple drift before the guarded write cannot create a new account
link. Existing masked errors and status codes remain unchanged. Already-finalized
receipts are historical results, not proof of current device authority; stored
links and browser sessions are not silently revoked or deleted. A write accepted
before later revocation is not retroactively undone.

## Standalone raw bootstrap issuance

Standalone grant creation checks both participant device IDs and canonical keys
from their current enrollments when available, including disabled enrollments.
The INSERT pins each captured key/fingerprint/Identity tuple or the absence of an
enrollment. D1 cannot silently use a participant that appeared or changed during
hashing; SQLite performs capture, hashing, and insertion in an immediate transaction.

Raw grant records are not authorization. Existing no-revocation creation behavior
for unenrolled, disabled, or identical participant IDs remains unchanged. No
historical key or ownership is inferred from a fingerprint, actor hint, or stored
grant. Retained device-ID revocation still denies creation after enrollment removal.

Subject denial uses `device_revoked`; stale evidence and unconfirmed failures use
the fixed `bootstrap_grant_write_incomplete` error. D1 returns only its own guarded
INSERT result, not success reconstructed from a later raw read. After a lost D1
receipt, neither an incomplete response nor a subsequent `device_revoked` denial
proves that no grant was committed; callers must reconcile current state.

Existing raw reads, history, and explicit grant revocation remain unchanged.
Current authorization of both participants in signed/admin lookup paths is the
next separate slice; raw issuance guards alone do not close bootstrap access.
These writer slices do not enable public revocation management, new owner
enrollment, durable ownership, or a live authentication configuration.

## Current bootstrap authorization read

`getBootstrapGrantAuthorization` is a required store capability, separate from raw
inspection. It accepts a grant ID, server-trusted time, and optional seed constraints
from verified request admission. Its authorized result carries version 1, the grant,
and both current enrollments from the final SQL decision—not from earlier snapshots.

The decision requires an unrevoked, unexpired grant, an unarchived group, both
participants currently enrolled and enabled in that group, and no device-ID or
canonical-key revocation. It derives both key IDs from actual enrollment keys and
pins the captured grant fields and participant tuples across hashing. Changed
evidence cannot silently authorize a replacement key. Invalid expiry dates fail
closed. Authorization requires an ISO timestamp with seconds and an explicit `Z`
or numeric timezone offset; timezone-less and free-form dates fail closed rather
than expiring at different instants on different hosts. Backend or unconfirmed
results use `bootstrap_authorization_unavailable`.
Calendar dates, clock times, and timezone offsets must have valid components;
overflow values such as February 30 or `24:00:00` are rejected before parsing
can normalize them into a later expiry.

Missing grants or mismatched seed expectations retain `grant_not_found`; missing
or disabled participants use `seed_enrollment_not_found` or
`worker_enrollment_not_found`. Other denials distinguish grant revocation, expiry,
group archival, and participant device revocation without database diagnostics.
Raw records, history, and explicit grant revocation remain independently readable.
Incomplete enrollment metadata, including empty fingerprints or creation times,
also fails closed as unavailable without changing raw inspection.

This slice does not yet change API or viewer behavior. Their next adoption slice
must authenticate before this read, pass the actual verified seed key, expose an
explicit authorization version, and reject older unversioned inspection responses.
No optional raw-getter fallback can substitute for the authorization decision.

## Activation limits

Existing group disable/removal does not create global subjects automatically.
Account links, browser sessions, Identity-group grants, memberships, and stored
memories are not rewritten. Revoking a signing key does not sign out Google or
revoke an account's browser session.

A global management caller must be a coordinator-wide operator or a current
OIDC-verified owner with exclusive server-verified ownership of the target
device ID and canonical key. Team/group authority alone is insufficient. Legacy
join can insert a public device ID/key without proving possession; a planted
enrollment row or actor hint cannot turn that group authority into global power.
Writer guards must preserve owner-bound ID/key uniqueness before the owner path
can activate. Ambiguous legacy targets go to the coordinator operator, not an
unverified owner or a new universal ownership framework.

This slice does not yet prevent every enrollment writer from re-enrolling a
subject or filter every discovery/bootstrap read. Those guards must land before
public revocation management. Direct-peer cached permissions and required-auth
enforcement remain separate; coordinator admission is not a claim of immediate
offline or direct-sync revocation.
