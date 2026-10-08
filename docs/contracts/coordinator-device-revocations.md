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
Current authorization of both participants is required in signed/admin lookup
paths; raw issuance guards alone do not close bootstrap access.
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

Both single-grant API lookup routes authenticate before this read. The signed
route constrains the decision to the actual key and fingerprint used during
request verification; the admin route independently checks both participants.
No optional raw-getter fallback can substitute for the authorization decision.

Successful lookup responses require `authorization_version: 1`, `grant`,
`seed_enrollment`, and `worker_enrollment`. The viewer checks the version, both
enabled enrollment tuples and fingerprints, group/device bindings, strict expiry,
and its freshly read local seed key before recording a nonce or trusting the peer.
Malformed or unversioned responses fail closed with the existing generic peer 401.

Older coordinators must be upgraded before a new viewer can admit a new bootstrap
connection. Ordinary local use and already configured direct-peer authentication
do not require this response version. Raw grant listing and explicit revocation
remain separate from authorization.

Lookup denial statuses are 404 for missing grants, missing/disabled participants,
or mismatched seed constraints; 403 for grant revocation, expiry, or device
revocation; 409 for group archival; and 503 for unavailable or unconfirmed
authorization. Invalid signed requests retain their existing admission errors and
never invoke the authorization read.

## Revocation-aware peer discovery

`listGroupPeers` omits candidates with a coordinator-wide device-ID or canonical-key
revocation. Omission includes their key, fingerprint, addresses, and capabilities;
raw enrollment inspection and retained grant/history records are unchanged.

Discovery captures enabled candidate tuples and derives key IDs from their actual
public keys. The final SQL read pins those tuples and checks current revocations,
then joins current presence by both group and device ID. Changed or removed
candidates are omitted rather than silently authorizing replacement keys. SQLite
keeps capture, synchronous hashing, and the final read in one transaction; D1
copies every tuple before hashing and uses a single guarded final read.

Healthy enabled peers with missing or expired presence remain visible as stale,
with empty addresses. Results retain device-ID ordering. Opaque legacy keys retain
device-ID-only checks. One JSON parameter carries captured tuples without a new
schema or a variable bind count for large groups. Backend per-value size limits
still apply; oversized reads fail closed rather than silently truncating peers.

The public route authenticates and rate-limits the requester before discovery.
Unconfirmed backend responses or discovery failures return the fixed
`peer_discovery_unavailable` error with HTTP 503, without database diagnostics.
This is a fresh discovery snapshot, not a permanent permission or immediate
revocation of already cached direct-peer trust. Project membership authority,
removed-device ownership evidence, and public revocation management remain separate.

## Current scope authorization foundation

`getScopeAuthorization({ groupId, scopeId })` is a required internal store
decision, separate from raw scope and membership inspection. Both stores return an
`authorizationVersion: 1` snapshot containing the scope and effective members,
each with its captured membership, current enrollment, and canonical key ID.

The scope must have `authority_type: coordinator`, be active, and be explicitly
bound to the requested unarchived group.
Active membership epochs must meet or exceed the scope epoch. Null legacy member
source fields inherit the scope source; conflicting source fields omit the member.

Legacy coordinator scopes may retain a null coordinator ID when their group is
explicitly bound. That metadata is neither a tenant boundary nor owner proof.
Local scopes cannot produce coordinator authorization through this method.

Only enabled enrollments in that group with usable Ed25519 keys can contribute
authority. Missing, disabled, revoked, or changed member tuples are omitted.
Opaque legacy keys remain inspectable but cannot substitute for current key evidence.

SQLite captures the entire roster before synchronous hashing inside an immediate
transaction. One final SQL statement pins every captured scope, membership, and
enrollment field and checks current device-ID and canonical-key revocations.

It never replaces a captured key with a newer unchecked key.

Empty presentation names or Identity hints do not invalidate otherwise eligible
members. Inactive membership history cannot authorize and is omitted before
validating its other fields; malformed active authority still rejects the snapshot.

Missing or inactive scopes, source mismatch, and archived groups have fixed
rejection codes; malformed storage or unconfirmed reads return
`scope_authorization_unavailable` without database diagnostics. The snapshot is
not account-owner proof or a permanent permission.

D1 copies scope, membership, and enrollment DTOs before asynchronous canonical-key
hashing. Its final atomic SQL read uses two JSON parameters and checks the same
captured fields and revocation subjects as SQLite, without refreshing changed keys.

D1 captures matching enrollments in one query, so a successful snapshot uses five
reads regardless of roster size. This avoids per-member queries exceeding the
Worker invocation query quota.

A missing or malformed roster receipt is unavailable, not an empty authorized
roster. Final results must match the captured scope and contain only exact captured
member tuples; validated members sort by device ID in both stores.

Neither backend falls back to raw membership getters.

### Signed scope responses

`GET /v1/scopes` returns `{ version: 1, items: scope[] }` as a discovery catalogue.
Its metadata is not member or key permission; consumers must fetch the current
authorization snapshot for each scope before using it as cache authority.

`GET /v1/scopes/:scope_id/members` requires signed admission and rate limiting
before calling `getScopeAuthorization` once. It returns
`{ authorization_version: 1, scope, items: [{ membership, enrollment, key_id }] }`.

The requester must appear in the current snapshot with the exact group, device,
public key, fingerprint, and Identity captured before signature verification.
Removal, disablement, revocation, or a principal change cannot grant access through
a newly read enrollment. Failure returns `403 scope_membership_required`.

Missing, inactive, foreign-source, or archived scope decisions return the masked
`404 scope_not_found`. Unconfirmed snapshots and storage failures return fixed
`503 scope_authorization_unavailable`, without database diagnostics.

Raw admin listings remain inspection-only, and bootstrap responses are unchanged.
Older cache clients that expect raw membership rows cannot consume this format;
deploy the wire and cache changes together.

### Current-authority cache refresh

Remote refresh always uses the runtime device's signed requests, including when
an admin secret is configured. An admin secret alone cannot populate access
caches: a runtime without an enrolled signing device keeps its cache stale.
Raw admin APIs still support inspection and management.

Local refresh reads `getScopeAuthorization` directly from coordinator storage.
`coordinatorDbPath` selects that database separately from the memory/signing
database selected by `dbPath`. This local read uses the store's current decision;
it does not add a new browser, account-owner, or signed-request ceremony.

Both paths require numeric version 1 and complete current scope/member/key
evidence. Malformed, unversioned, duplicate, foreign-source, or superseded
snapshots fail rather than falling back to raw history or an empty roster.
The cache validates each enrollment's usable key, device/group tuple, fingerprint
field shape, and canonical key ID. Legacy stored fingerprints remain unchanged
tuple evidence; the decoder does not require them to equal a newly computed hash.
Validated key evidence is retained with the cache as described below; it is not
a new signed permission or account-owner proof.

The current snapshot's scope metadata replaces catalogue metadata. The configured
cache authority can be a URL rather than the server's coordinator ID; source
tuples are checked before mapping them into that cache namespace.

Refresh gathers and validates every scope in a group before committing scope
rows, members, omissions, and successful freshness together. Malformed snapshots
and source or epoch conflicts preserve that group's prior cache and success time
and record it as stale. Other groups can still refresh independently.

Member epochs are compared only when the current snapshot includes that member.
A validated omission revokes its cached row even when the member epoch is newer
than the unchanged scope epoch, without lowering the cached epoch.

If a snapshot re-adds a cached revoked device at the same epoch, refresh grants
nothing but still applies validated omissions and scope archiving in one
transaction. The group stays stale and keeps its last success time, while other
members' removal still takes effect. The coordinator must advance the re-added
device's membership epoch before that group can become fresh again.

The cache keeps its existing freshness lifetime and monotonic revocation rules.
Version 1 is a format, not a new lease. Coordinator-managed reader adoption,
including direct-SQL consumers, remains a separate slice; ordinary local and
direct-peer authentication is unchanged.

### Retained managed-key evidence

Successful refresh retains version-1 scope, membership, enrollment, and canonical
key evidence in `scope_membership_authorization_evidence`. Evidence replacement,
cache rows, omissions, and freshness commit in the same group transaction.
Only known public DTO fields are stored, not unknown fields or provider secrets.

Refresh captures the group's local `refresh_revision` before fetching snapshots.
The transaction compares it before writing and advances it with committed state.
A superseded response cannot restore an older key or archived scope, or move the
latest success time backward. The revision is write ordering, not a lease or
membership epoch; cold schema upgrades preserve legacy history without proof
backfill, and effective reads still perform no schema writes.

A delayed failure also leaves newer committed state unchanged. If the revision
cannot be read or failure state cannot be written, the refresh returns a stale
result for that group without changing its stored state; other groups continue.
Raw compatibility reads also perform no schema writes, including on legacy
read-only databases that lack the revision column.

`getEffectiveCachedScopeAuthorization` requires matching retained evidence for
coordinator-managed scopes. Old or unproven rows cannot grant access through this
helper until a successful current refresh; timestamps and pinned keys do not
backfill proof or infer a historical server-ID-to-URL alias.

The helper compares authority-relevant fields, not presentation labels or dates.
Missing, malformed, or mismatched evidence denies without creating tables or
writing during the read. Its optional `expectedPublicKey` checks the canonical
key blob, accepting text aliases of the same key while rejecting another key.

Previously verified evidence keeps the existing offline behavior; this helper
adds no expiry or freshness requirement. Unmanaged/manual scopes keep their
existing behavior. Removal-only refreshes can prune evidence but cannot mint
proof or grant access.

The raw cached helper remains available for history and compatibility. Network
and local direct-SQL consumers still require separate adoption of the effective
decision; retaining evidence alone does not complete reader enforcement.

Scoped request admission and scope advertisement require retained evidence for
both devices and compare the local signing key and the authenticated peer key.
Manual and direct-peer scopes retain their existing rules. Coordinator-derived
peer trust, replication, snapshot selection, and remaining local consumers still
need adoption before end-to-end enforcement is complete.

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
