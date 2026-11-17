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

## B. Removal checks on enrollment writers (SQLite and D1)

One test for each writer, each asserting `device_removed` and no changed row
after D was removed from every group:

1. Admin enroll and upsert of D with K.
2. Admin enroll of a new device ID with K.
3. Admin enroll of D with a new key.
4. `setDeviceEnabled(true)` on a row re-created by direct SQL.
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
    group 2: admin enroll into group 1 is refused, admin enroll into a third
    group succeeds, and an invitation that predates the removal is refused in
    every group.

Inviter rule:

13. An `add_device` invitation that D issued before its removal is refused for
    a device that was never removed.
14. A Project invitation that D issued before its removal is refused, and its
    bootstrap grant cannot authorize.
15. An invitation issued by a device that was removed and has rejoined is
    refused when it predates that removal, and accepted when it was issued
    after the rejoin.

## C. Lifting a removal (SQLite and D1)

1. A signed join by D with K and a `team_member` invitation created after the
   removal enrolls D in the invitation's group and sets `lifted_at` and
   `lifted_by_invite_id` on that group's active tombstones of D and K.
   Tombstones in other groups stay active, and admin enroll into those groups
   is still refused.
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
11. Two concurrent lifts with two valid invitations produce one enrollment and
    one consumed invitation.
12. After a lift, disable and enable work for D in the lifted group, and admin
    enroll works in a group where D has no tombstone.
13. A device with an ownership binding is refused with
    `device_ownership_requires_verified_identity`. This test changes with the
    owner's decision 1.

## D. Coordinator routes

1. Preview and commit require the admin secret and return 401 without it,
   before any body is read.
2. Preview rejects unknown fields, more than eight IDs, and malformed IDs.
3. Preview returns `removal_target_not_enrolled`, `removal_target_conflict`,
   and `removal_target_too_large` in their cases and writes nothing.
4. Commit returns the receipt with `removal_id`, `removal_seq`, and one entry
   for each removed enrollment.
5. `GET /v1/admin/devices/removals` lists active tombstones newest first,
   omits lifted ones and public keys, and sets `truncated` above 500.
6. A coordinator database without the table returns
   `device_removal_unavailable` from the new routes and from the legacy
   removal, and deletes no enrollment.
7. The routes work without the `deviceRevocation` operator context.

## E. Pinned-peer check

1. The reply always has `revoked`, `removed`, and `removal_seq`.
2. D is `removed` after removal from all groups, by device ID with any key and
   by K under an unknown device ID.
3. D removed from one group and still enrolled in another is not `removed`.
4. D is not `removed` after a lift.
5. A blocked and removed device appears only in `revoked`.
6. An entry without `public_key` is checked by device ID.
7. Twenty-five entries stay within the D1 query budget.

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
3. A lifted tombstone with no current enrollment is not evidence.
4. After the block, a signed join with a new invitation returns
   `device_revoked`, and the tombstone stays unlifted.
5. Viewer route: Remove, then Block from the removed-device list, succeeds end
   to end.

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
11. After applying a reply the next presence update carries
    `applied_removal_seq` and the `peer_removal_check` feature.
12. An ended binding is absent from the reconciler's device list, and the
    reconciler queues no grant for it.
13. A peer list fetched before the removal and applied after the local step is
    corrected by the next refresh.
14. On the removed device, `device_removed` from every configured group stops
    outbound sync to coordinator-discovered peers and deletes nothing.

## I. Viewer server

1. Remove preview and commit for an enrolled device call the coordinator
   routes, then the local function, and return the list of devices that have
   and have not applied the removal.
2. Remove for a device with no enrollment and no tombstone runs the local-only
   path and returns the notice flag.
3. Remove for a device with an active tombstone runs the local step and reports
   it as already removed.
4. Without the admin secret, a device in the signed peer listing returns
   `coordinator_admin_required` and changes nothing.
5. Without the admin secret, a device absent from a successful peer listing
   runs the local-only path.
6. An unreachable coordinator returns an error and changes nothing.
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

## M. End-to-end

ADR 0007 flow 3, "Remove a device I no longer use, and bring it back later",
with three devices and one coordinator, without Advanced or the CLI:

1. Remove B on A. C drops B at its next refresh. B's sync with A and C fails,
   and B shows that it was removed.
2. B accepts a stale invitation and is refused.
3. A creates a new invitation. B accepts it, is enrolled, pairs again, and
   receives the Projects shared with its Identity under current policy.
4. Block B. A new invitation on B is refused, and A and C record the block.
