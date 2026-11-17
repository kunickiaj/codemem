# Remove device and Block device: failing tests to write first

**Date:** 2026-11-16

**Design:** [Remove device and Block device permanently](2026-11-16-device-remove-and-block-design.md)

**Contract:** [Coordinator device revocations](../contracts/coordinator-device-revocations.md), section "Device removals (planned for 0.50)"

Each test below fails on the current code, because the table, routes, reply
fields, and local function it exercises do not exist. The implementer writes
the tests of a group before the code of that group, in the order of the groups.

Coordinator store tests live in one shared harness that runs against SQLite in
`packages/core` and against native D1 in `packages/cloudflare-coordinator-worker`,
as the revocation tests do. Tests use an injected clock and no real network.
"Device D with key K" means an enrolled Ed25519 device unless a test says
otherwise.

## A. Removal operation (SQLite and D1)

New harness `coordinator-device-removal-test-harness.ts`.

1. Removing D, enrolled in two groups, deletes both enrollments and both
   presence rows and inserts two tombstones with one `removal_id`, increasing
   `removal_seq`, the exact tuples, and the canonical `key_id`.
2. Removing two device IDs that share K in one request removes both. Two IDs
   with different keys return `removal_target_conflict` and write nothing.
3. The removal revokes each active scope membership of D with an advanced
   epoch and an audit row. A later grant at the old epoch grants nothing.
4. The removal revokes bootstrap grants that name D as seed or as worker,
   deletes its reciprocal approvals, and denies its pending join requests.
5. A commit whose enrollment changed key, appeared, or disappeared after the
   preview returns `removal_preview_stale` and writes nothing.
6. A failed statement in the middle rolls back every write. On D1 the batch is
   atomic and a malformed receipt returns `device_removal_incomplete`.
7. Removing a disabled enrollment and an enrollment in an archived group both
   work.
8. An opaque key produces a tombstone with a null `key_id` that matches by
   device ID and by exact key text.
9. Delete and update of a tombstone are rejected by trigger, except the single
   update that sets both lift columns on an active row.
10. A second active tombstone for the same group and device ID is rejected.
11. The legacy single-group removal writes a tombstone for that enrollment.
12. A new invitation records the current highest `removal_seq`. An invitation
    row from before the migration reads as null.
13. Every enrollment writer stores `key_id`. The migration fills existing rows,
    with an empty string for an opaque key.
14. Removing D with K also removes an enrollment of K under another device ID
    that the request did not name, including one whose key text differs.
15. An enrollment of K under a new device ID that is inserted between preview
    and commit returns `removal_preview_stale` and writes nothing. A fresh
    preview lists both device IDs and its commit removes both. (Review
    finding 2.)
16. While any enrollment has a null `key_id`, preview and commit return
    `device_removal_unavailable`.
17. A D1 membership grant that read the enrollment before the removal and
    writes after it creates no membership, no receipt, and no audit row, for a
    scope with no earlier membership and for a grant with a higher epoch.
    (Review finding 3.)

Enrollment triggers, run as raw SQL against a migrated database (review
finding 4):

18. The pre-0.50 enrollment insert, without `key_id`, aborts once any tombstone
    exists and succeeds before.
19. An insert of D or of K aborts while their tombstone is active and succeeds
    after a lift.
20. A plain delete of an enrollment aborts. The removal operation's delete
    succeeds.
21. Setting `enabled` to 1 aborts when an active tombstone of the same group
    matches the row.
22. An update that changes `public_key` and leaves `key_id` unchanged aborts.
23. After a single-group removal from group 1, an update that moves the
    surviving group 2 enrollment into group 1 aborts. No delete can then use
    the old tombstone. (Second review.)
24. With recursive triggers off, `INSERT OR REPLACE` and `UPDATE OR REPLACE`
    that collide with another enrollment by group and device ID or by row ID
    abort and leave that enrollment in place. The update case is repeated
    with the row ID named `_rowid_` and `oid`. (Second and third review.)
25. An insert of an opaque key whose text equals an active tombstone's key
    aborts.
26. Every 0.50 enrollment writer still works for a device that is already
    enrolled in the group, without an upsert.

## B. Removal checks on enrollment writers (SQLite and D1)

One test for each writer, each asserting `device_removed` and no changed row
after D was removed from every group:

1. Admin enroll and upsert of D with K.
2. Admin enroll of a new device ID with K.
3. Admin enroll of D with a new key.
4. `setDeviceEnabled(true)` for D changes no row.
5. Join approval of a request created before the removal.
6. Join approval of a request created after the removal from an enrollment-only
   code.
7. An enrollment-only code with automatic admission.
8. Owner enrollment. Rebinding and device-claim binding create no enrollment
   for D.
9. A recipient invitation and a Project invitation created before the removal,
   as first acceptance and as bound retry.
10. On D1, a tombstone that is inserted between an acceptance's pre-read and
    its write still denies the write.
11. A blocked and removed device returns `device_revoked`.

Per-group cases:

12. D removed from group 1 by the single-group removal and still enrolled in
    group 2: admin enroll into group 1 and into a third group are both
    refused, enable and disable still work in group 2, and an invitation that
    predates the removal is refused in every group.

Claims that mix a removed device with another enrollment (review finding 1).
D with K is removed from every group, and X with key L stays enrolled:

13. An enrollment-only code for a group where D has no tombstone, presented as
    device ID D with key L, is refused and changes no enrollment.
14. The same code presented as a new device ID with key K is refused.
15. After both attempts the lookup still reports D with K as `removed`.

Old codes after a lift (second review). D is removed from groups 1 and 2 and
rejoins group 1 with a new invitation:

16. An enrollment-only code for group 2 that predates the removal is refused
    and writes no enrollment.
17. A join request for group 2 made from such a code is refused at approval.
18. An enrollment-only code for group 2 created after the removal enrolls D.

Inviter rule:

19. An `add_device` invitation that D issued before its removal is refused for
    a device that was never removed.
20. A Project invitation that D issued before its removal is refused, and its
    bootstrap grant cannot authorize.
21. An invitation issued by a device that was removed and has rejoined is
    refused when it predates that removal, and accepted when it was issued
    after the rejoin.

## C. Lifting a removal (SQLite and D1)

1. A signed join by D with K and a `team_member` invitation created after the
   removal enrolls D in the invitation's group only and sets `lifted_at` and
   `lifted_by_invite_id` on every active tombstone of D and K, in all groups.
2. The same with an `add_device` invitation from an enrolled device of the same
   Identity.
3. The lift restores no scope membership and no enrollment in another group.
4. An unsigned join with a valid new invitation returns `device_removed` and
   leaves the invitation unconsumed.
5. A signature from a different key, a header device ID that differs from the
   body, and a timestamp outside the freshness window are each refused.
6. D with a different key than its tombstone records is refused.
7. The invitation that lifted removal 1 cannot lift removal 2 of the same
   device.
8. A repeated signed join after a successful lift returns the existing
   acceptance and changes no tombstone.
9. After removal 2, a bound retry of the invitation that lifted removal 1 is
   refused and writes no enrollment.
10. An `add_device` invitation whose inviter was disabled or blocked after
    issuing cannot lift.
11. Two concurrent lifts with two valid invitations for one group produce one
    enrollment, and each tombstone is lifted once.
12. After a lift, disable, enable, and admin enroll into another group work
    for D as for any enrolled device. An invitation that predates the removal
    is still refused.
13. A new invitation presented as device ID D with another key, signed by that
    key, is refused. A new invitation presented with K and signed by another
    key is refused.
14. A removed device with an ownership binding is refused by a signed join
    with a new `team_member`, `add_device`, or Project invitation, with
    `device_ownership_requires_verified_identity`. No tombstone is lifted.
    This includes an `add_device` invitation from an inviter that was enrolled
    through a Project invitation with `recipient_actor_id` set to the device's
    Identity. (Second review.)

## C2. Rejoining by sign-in (SQLite and D1, owner decision 1)

These wait for the ceremony's protocol and its security review. D has an
ownership binding to Identity I under coordinator ID A and was removed from
groups 1 and 2. I has an active Identity-group grant in both groups and a
plain device-claim account link.

1. A sign-in that resolves to I's account link, a signature by K over the
   attempt, and the browser confirmation lift every active tombstone of K,
   enroll D with Identity I in groups 1 and 2, set `lifted_by_attempt_id`, and
   write one audit event. The binding row is unchanged, and no scope
   membership is written.
2. A sign-in without the signature, a signature without the sign-in, and both
   without the confirmation each write nothing.
3. A sign-in that resolves to another Identity, or to no active link, is
   refused.
4. A signature by a key other than the tombstone's is refused.
5. A binding that belongs to coordinator ID B is refused under A, and a
   coordinator with no trusted coordinator ID refuses. (Second review.)
6. A device with a binding and no active tombstone is refused. A device with a
   tombstone and no binding is refused.
7. A blocked device is refused with `device_revoked`.
8. With one archived and one unarchived group, only the unarchived group gets
   an enrollment and both tombstones are lifted. With every group archived
   the ceremony is refused, no tombstone is lifted, the device stays in the
   removal listing, and a block from its tombstone succeeds. (PR review.)
9. An exact retry returns the same receipt. A status read resolves a lost
   reply.
10. A block recorded between the confirmation and the commit makes the commit
    fail and write nothing.
11. The rejoin above the daily limit for I is refused.
12. The Identity's other devices show the rejoin with a Remove action after
    their next sync.
13. I's grant for group 2 is revoked before the confirmation: only group 1
    gets an enrollment. It is revoked between confirmation and commit: the
    commit fails and writes nothing. With no qualifying group the ceremony is
    refused. (Third review.)
14. D also has an active tombstone under an older key K0 from a single-group
    removal: the ceremony is refused and enrolls nothing. (Third review.)
15. Device ID E shares K and has its own tombstone: that tombstone is lifted
    and E is not enrolled. (Third review.)
16. A plain device-claim link, an attestation-backed link, and a qualified
    device-claim link each succeed. A revoked link and a link of another
    Identity are refused. (Owner decision 7.)
17. An attempt confirmed for removal 1 cannot lift removal 2 after the device
    rejoined and was removed again. A link replaced after the attempt started
    makes the commit fail. (Third review.)
18. A retry of a finalized attempt returns the stored receipt, writes nothing,
    and does not lift a later tombstone. Status reads write nothing.
19. A signed coordinator request that returns `device_removed` is not accepted
    as the rejoin signature.
20. A group that never had a grant row for I gets an enrollment when D's
    tombstone there records Identity I. A grant row for that group that
    appears between confirmation and commit, active or revoked, makes the
    commit fail. (Owner decision 8.)
21. A plain device-claim link still cannot authorize owner enrollment of a
    fresh device, an Identity-group grant, or an invitation. (Owner decision
    7.)
22. D is enrolled under Identity J in groups 1 and 2, is removed from group 1,
    J's grant for group 1 is revoked, D rebinds to I, and D is removed from
    group 2. Sign-in rejoin under I does not enroll D in group 1, and reports
    it as `identity_changed`. (Fourth review.)
23. A key-only attempt that was started and abandoned does not stop a second
    attempt for the same device. With 20 open attempts, a new start expires
    the oldest one that has not reached `oidc_verified` and never one that
    has. (Fourth review.)
24. A link whose Identity has an earlier revoked link is refused at the
    callback, at confirmation, and at finalize, even though the current link
    is not revoked. (Fourth review.)
25. An attempt past `expires_at_ms`, or started under an earlier
    `auth_config_revision`, cannot finalize.
26. `rejoined_at_ms` is still returned eight days after the rejoin. The events
    route returns the event to a device with an ownership binding to I that
    was offline for eight days, returns nothing to a device without a binding,
    and returns nothing new after the stored cursor. (Fourth review.)

## D. Coordinator routes

1. Preview and commit require the admin secret and return 401 without it,
   before any body is read.
2. Preview rejects unknown fields, more than eight IDs, and malformed IDs.
3. Preview returns `removal_target_not_enrolled`, `removal_target_conflict`,
   and `removal_target_too_large` in their cases and writes nothing.
4. Commit returns the receipt with `removal_id`, `removal_seq`, and one entry
   for each removed enrollment. Preview reports `rejoin` as `invitation`,
   `sign_in`, or `none` for a device without a binding, with a binding and a
   qualifying link and group, and with a binding and neither.
5. `GET /v1/admin/devices/removals` lists active tombstones newest first and
   omits lifted ones and public keys. With more than 500 it returns
   `next_before_seq`, and paging with `before_seq` reaches the oldest one.
   `device_id` returns one device's tombstones. Tombstones of a blocked device
   are omitted unless `include_blocked=1`. (PR review.)
6. A coordinator database without the table returns
   `device_removal_unavailable` from the new routes and from the legacy
   removal, and deletes no enrollment.
7. The routes work without the `deviceRevocation` operator context.

## E. Pinned-peer check

1. The reply always has `revoked`, `removed`, `enrolled`, and `removal_seq`.
2. D is `removed` after removal from all groups, by device ID with any key and
   by K under an unknown device ID.
3. D removed from one group and still enrolled in another is not `removed`.
4. D is not `removed` after a lift.
5. A blocked and removed device appears only in `revoked`.
6. An entry without `public_key` is checked by device ID.
7. Twenty-five entries stay within the D1 query budget.
8. An enrollment of device ID D under another key, inserted by fixture, does
   not keep D with K out of `removed`.
9. `removal_seq` and the entries come from one statement batch.
10. A device with only a disabled enrollment, a device enrolled only in a group
    the caller is not in, and a device enrolled only in an archived group are
    each `enrolled`. A device with no enrollment is not. (PR review.)
11. The route issues the same number of statements for 1 entry and for 25.

## F. Signed requests from a removed device

1. A validly signed presence request from removed D returns `403 device_removed`
   and records no nonce.
2. The same request with a bad signature returns `unknown_device`.
3. A device that was never enrolled returns `unknown_device`.

## G. Block from a tombstone (closes `codemem-e3iox`)

1. Remove D, then preview and commit a block for the same group and device ID.
   The block succeeds and returns both subjects.
2. A preview made against the enrollment, committed after the removal, returns
   `revocation_preview_stale`.
3. After a lift, a block request for a group where the device has a lifted
   tombstone and no enrollment returns `revocation_target_unavailable`.
4. After the block, a signed join with a new invitation returns
   `device_revoked`, and the tombstone stays unlifted.
5. Viewer route: Remove, then Block from the removed-device list, succeeds end
   to end.
6. Viewer route: Block on an enrolled device previews the block, runs the
   removal, previews the block again against the tombstone, and commits that
   second preview. No enrollment row is left.
7. Viewer route: when the removal succeeds and the block commit fails, the
   reply says removed and not blocked, and the device is in the removed list.
8. Viewer route: when the block preview is unavailable, nothing is removed.
9. With more than 500 newer active tombstones, Devices still finds D through
   paging or the `device_id` filter and blocks it. (PR review.)

## H. Local pairing removal and binding (closes `codemem-l4dd`)

New function in `packages/core`, for example `removePairingState`.

1. It deletes the pairing and its rows in `replication_cursors` and
   `replication_cursors_v2`, sets the binding status to `removed`, and retains
   retirement trust, for every ID given.
2. A failure in any statement leaves the pairing, both cursor tables, and the
   binding unchanged.
3. Per-Team device decisions for the device survive, because the binding row is
   not deleted.
4. It records no retired alias for a removed device and records one for a
   revoked device.
5. The coordinator-policy cleanup deletes both cursor tables and leaves the
   binding active.
6. `sync_attempts` and `sync_scope_rejections` rows stay.
7. Remove, then pair the same device ID again: both sides exchange the full
   history and no operation is skipped.
8. A device ID with an active binding and no pairing is sent in the lookup, and
   its binding ends when the reply says `removed` or `revoked`.
9. A reply without `removed` or `removal_seq` is invalid and keeps every
   pairing.
10. IDs the client did not send are ignored.
11. After a complete lookup the next presence update carries
    `applied_removal_seq` and the `peer_removal_check` feature.
12. An ended binding is absent from the reconciler's device list, and the
    reconciler queues no grant for it.
13. A peer list fetched before the removal and applied after the local step is
    corrected by the next refresh.
14. On the removed device, `device_removed` from every configured group stops
    outbound sync to coordinator-discovered peers and deletes nothing.
15. With 30 pairings, a removal recorded between the first and second request
    leaves `applied_removal_seq` below that removal's number until the next
    complete lookup. A lookup whose second request fails leaves it unchanged.
    (Review question.)
16. The upgrade cleanup deletes cursor rows in both tables for a device with no
    pairing and leaves every row of a paired device. A failure deletes
    nothing. (Owner decision 4.)
17. A pairing or binding that is created or reactivated after a complete
    lookup sets the stored `applied_removal_seq` to 0 in the same transaction,
    and the next presence update advertises 0. A coordinator key rotation that
    changes an existing pairing's pinned key does the same. (Second and third
    review.)
18. A pairing created while a lookup is running stops that lookup from storing
    its number. (Second review.)
19. A checked device whose pairing another process restores from an older peer
    list is not advertised as applied, and the next lookup drops it again.
    (Second review.)

## I. Viewer server

1. Remove preview and commit for an enrolled device call the coordinator
   routes, then the local function, and return the list of devices that have
   and have not applied the removal.
2. Remove for a device the lookup lists in none of its arrays runs the
   local-only path and returns the notice flag.
3. Remove for a device the lookup lists as `removed` or `revoked` runs the
   local step and reports it as already removed.
4. Without the admin secret, a device the lookup lists as `enrolled` returns
   `coordinator_admin_required` and changes nothing. This holds for a disabled
   enrollment and for an enrollment in a group this device is not in, where
   the signed peer listing shows nothing. (PR review.)
5. With no coordinator configured, Remove runs the local-only path.
6. An unreachable coordinator, a 404 from the lookup, and a lookup that every
   group refuses each return an error and change nothing, with and without
   the admin secret.
7. A 404 from the coordinator's removal route returns
   `coordinator_update_required`, changes nothing locally, and never calls the
   legacy removal.
8. A lost commit reply is resolved from the removal listing before the local
   step runs.
9. Remove of the device the Viewer runs on is refused.
10. `DELETE /api/sync/peers/:peer_device_id` and the retire routes are gone.

## J. Viewer UI

1. Devices offers Remove device and Block device permanently, and no Retire.
2. Each confirmation renders the copy in Section 8 of the design, with the
   cancel button focused.
3. The older-version line appears only when such devices exist, and names them.
   The body ends with the invitation, sign-in, or cannot-be-added-back
   sentence that the preview's `rejoin` value selects. The removed
   device shows **Sign in to rejoin** only when it has an ownership binding.
4. The local-only confirmation and result name the other devices.
5. The removed-device list shows each tombstone with Block device permanently.
6. Coordinator administration has no Remove, Disable, Enable, or Rename, and
   Advanced has no Remove device or Save name.

## K. CLI

1. `codemem sync peers remove` deletes both cursor tables, ends the binding,
   and prints the notice. `--json` returns the counts.
2. `codemem coordinator device remove` writes a tombstone.
3. `codemem coordinator device enable` enables a disabled enrollment and is
   refused for a removed device.
4. `codemem coordinator device list --removed` lists active tombstones.
5. `codemem coordinator device revoke` succeeds after a removal.
6. `codemem coordinator device enroll` on a removed device exits nonzero with
   `device_removed`.

## L. Upgrade and mixed versions

1. A 0.49 database fixture migrates: the table exists, existing invitations
   have a null number, and existing enrollments are unchanged.
2. A peer fixture that never runs the lookup still loses the removed device
   from its scope membership cache at its next refresh.
3. The administrator's result lists a peer whose presence has no
   `applied_removal_seq` as older, and a peer whose value is below the
   tombstone's number as not yet checked in.
4. A join without signature headers from a removed device returns
   `device_removed`.
5. The 0.49 local-database forms of `codemem coordinator device enroll` and
   `remove`, replayed as their SQL against a migrated database with one
   tombstone, fail and change nothing.

## M. End-to-end

ADR 0007 flow 3, "Remove a device I no longer use, and bring it back later",
with three devices and one coordinator, without Advanced or the CLI:

1. Remove B on A. C drops B at its next refresh. B's sync with A and C fails,
   and B shows that it was removed.
2. B accepts a stale invitation and is refused.
3. A creates a new invitation. B accepts it, is enrolled, pairs again, and
   receives the Projects shared with its Identity under current policy.
4. Block B. A new invitation on B is refused, and A and C record the block.
