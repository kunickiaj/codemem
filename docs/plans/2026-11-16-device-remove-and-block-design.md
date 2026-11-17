# Remove device and Block device permanently

**Status:** Proposed. Waiting for owner approval. No production code exists for this design.

**Date:** 2026-11-16

**Implements:** [ADR 0007](../adr/0007-one-sync-and-sharing-model-per-concept.md) Decision 5, which amends [ADR 0005](../adr/0005-authenticated-identity-device-and-membership-lifecycle.md) Section 5

**Contract:** [Coordinator device revocations](../contracts/coordinator-device-revocations.md), section "Device removals (planned for 0.50)"

**Test plan:** [Failing tests to write first](2026-11-16-device-remove-and-block-test-plan.md)

**Tasks:** `codemem-lvgba.18`, `codemem-e3iox`, `codemem-l4dd`

## Proposal

The unreleased "Retire device" action becomes two actions in Devices.

- **Remove device** takes a device out of sharing and lets it come back. The
  coordinator deletes the device's enrollments in every group and records a
  removal tombstone for each one. Other devices delete their pairing and sync
  progress with it and end its Identity binding at their next coordinator
  refresh. The same machine returns by accepting an invitation created after
  the removal.
- **Block device permanently** is today's revocation of the device ID and key.
  Nothing lifts it. It also works on a device that was removed first.

Remove needs one new coordinator table, one column on invitations, two admin
routes, one admin listing, and two more fields in the lookup that peers
already run at each refresh. Block needs one change: it accepts a removal tombstone as
evidence when the enrollment is gone.

Six decisions need the owner. They are listed under
[Decisions requested](#decisions-requested).

## Terms

- **Enrollment:** the coordinator row that says a device key belongs to a group
  (`enrolled_devices`).
- **Pairing:** the row one device keeps about another device it syncs with
  (`sync_peers`), including the pinned key.
- **Sync progress:** the two cursor tables that record how far a pairing has
  synced (`replication_cursors` and `replication_cursors_v2`).
- **Binding:** the local row that says a device belongs to an Identity
  (`identity_devices`).
- **Removal tombstone:** a new coordinator row that records one deleted
  enrollment. It is **active** until an invitation lifts it.
- **Block:** the existing immutable rows in `coordinator_device_revocations`.

## 1. Coordinator record, route, and how peers learn

### Record

A new table, `coordinator_device_removals`, holds one row per deleted
enrollment.

| Column | Purpose |
| --- | --- |
| `removal_seq` | Integer primary key that only increases. It orders removals against invitations. |
| `removal_id` | One server-generated ID shared by all rows of one Remove action. |
| `group_id`, `device_id`, `public_key`, `fingerprint` | The exact enrollment at the moment of removal. Block uses this as evidence. |
| `key_id` | The canonical Ed25519 key ID. Null for a key that is not SSH Ed25519. |
| `identity_id`, `display_name`, `actor_id` | Listing and audit only. None of them is proof of ownership. |
| `removed_at` | Server time, for display. Never used to decide access. |
| `lifted_at`, `lifted_by_invite_id` | Null while the tombstone is active. Set once, together, when an invitation lifts it. |

At most one active tombstone exists for a group and device ID. Rows are never
deleted, and the only allowed update sets the two lift columns once. Triggers
enforce both rules, as they do for ownership bindings.

`coordinator_invites` gains `issued_after_removal_seq`. The statement that
inserts an invitation sets it to the highest `removal_seq` that exists at that
moment, or 0. Invitations created before the upgrade keep null.

### Removal route

`POST /v1/admin/devices/removal-preview` and `POST /v1/admin/devices/removal`
require the coordinator admin secret, like the other `/v1/admin/devices`
routes. They do not depend on the operator configuration that Block requires,
so every coordinator with an admin secret can remove a device.

- Preview takes `{ "device_ids": [...] }` with one to eight IDs. One machine
  can be enrolled under several device IDs that share a key, and the Viewer
  sends that whole set, as Retire does today. The coordinator reads every
  enrollment of those IDs in every group, including archived groups. It
  refuses with `409 removal_target_conflict` when they carry more than one
  key, and with `404 removal_target_not_enrolled` when none exists. The reply
  lists the enrollments and a digest over them.
- Commit takes the same IDs and the digest. In one transaction it checks that
  the enrollments still match the digest, then for each enrollment inserts a
  tombstone and deletes the enrollment and its presence row. In the same
  transaction it deletes the device's reciprocal approvals, revokes each of
  its active scope memberships through the existing revoke operation, revokes
  bootstrap grants that name it as seed or worker, and denies its pending join
  requests. A changed enrollment returns `409 removal_preview_stale` and
  writes nothing.
- A lost reply is resolved by reading `GET /v1/admin/devices/removals`, which
  lists active tombstones. The Viewer never reports success without the
  receipt or that listing.

The removal has to revoke scope memberships and advance their epoch. Peers
cache a revoked member at its epoch and refuse a snapshot that re-adds it at
the same epoch. A membership left active would authorize again when the device
rejoins, and it would leave that group's cache stale on every peer. After a
rejoin the device gets only what the reconciler grants from current recipient
policy.

The legacy `POST /v1/admin/devices/remove`, which older Viewers and the CLI
call for one group, uses the same store operation for that single enrollment.
From 0.50 no code path deletes an enrollment without writing a tombstone.

### How peers learn

Peers already call `POST /v1/peers/revocations` at the start of each
coordinator refresh, before any sync in that cycle. This check landed after
0.49.1 and no release contains it, so its reply can still change. The reply
becomes:

```json
{ "version": 1, "revoked": ["..."], "removed": ["..."], "removal_seq": 42 }
```

- A requested device is `removed` when an active tombstone matches its device
  ID or its key, and the coordinator holds no enrollment for that device ID or
  that key text in any group. A device removed from one group by an operator
  and still enrolled in another is not reported.
- `revoked` wins when both apply.
- `removal_seq` is the coordinator's highest removal number. The peer stores
  it after it has applied the reply, and advertises it in its next presence
  update as `applied_removal_seq`. Section 7 uses this to show which devices
  have applied a removal.
- An entry may omit `public_key`. The peer sends every pairing with a stored
  key, as today, and also every device ID that has an active local binding
  and no pairing.

The lookup already has the properties a removal signal needs. It runs before
presence and peer discovery, so a group that rejects this device cannot block
it. An enrolled, enabled device signs it. The peer acts only on IDs it sent.
Any failure keeps pairings and logs a warning, so a failing coordinator cannot
make devices drop each other. The one new exposure is that an enrolled device
can learn whether a device ID or key it names was removed. It can already
learn whether that device is blocked.

For each `removed` ID the peer runs one transaction: delete the pairing, both
cursor tables, and end the binding (Section 2). It keeps the pinned key for
memory retirement requests, as it does for a blocked device, and that key
never authorizes content sync. It does not record a retired alias, because an
alias would stop the device from pairing again after it rejoins.

### What a new invitation must prove to lift a removal

A device that has an active tombstone in any group can join only when every
condition below holds. Each condition is part of the statements that consume
the invitation and write the enrollment, so an earlier read can never
authorize a later write.

1. **A valid, unused invitation.** It exists, is not revoked, not expired, and
   not consumed, and its group is not archived. Its kind is `team_member`,
   `add_device`, or a Project share. Enrollment-only codes and join-request
   approvals never lift a removal.
2. **Issued after the removal.** Its `issued_after_removal_seq` is at least
   the highest `removal_seq` of every tombstone, active or lifted, that
   matches the joining device ID or key. Null never passes.
3. **An inviter that is still enrolled.** If the invitation records an inviter
   device, that device is enrolled and enabled in the invitation's group, is
   not blocked, and has no tombstone numbered above the invitation. An
   invitation created with the admin secret has no inviter device.
4. **The same key.** Every active tombstone for the joining device ID records
   the joining key. A removed device ID that returns with a different key is
   refused.
5. **Proof of that key.** The join request is signed by the joining key with
   the existing signed-request scheme. The signed body contains the invitation
   token, so the signature belongs to this invitation.
6. **Not blocked.** No revocation matches the device ID or key. This existing
   check is evaluated first.

When they hold, one transaction consumes the invitation, writes the enrollment
in the invitation's group, and sets `lifted_at` and `lifted_by_invite_id` on
the active tombstones of that group that match the device ID or key.
Tombstones in other groups stay active, so the device returns to the
invitation's group only. Nothing else comes back. Scope memberships and
pairings are created only by the paths that create them for a new device.

A retry of a consumed invitation by the device it is bound to never lifts a
tombstone. The lift happens only in the transaction that first consumes the
invitation. A retry is still checked against condition 2, so it cannot enroll
a device that was removed after it accepted.

Two rules apply outside lifting.

- An invitation whose inviter device has a tombstone numbered above the
  invitation is refused for every acceptor, including a device that was never
  removed. Today a missing inviter only skips the bootstrap grant.
- Every path that creates or enables an enrollment without one of those
  invitations refuses with `403 device_removed` when an active tombstone
  matches the device ID or key and either belongs to the group being written
  or the device has no enrollment left in any group. That covers admin enroll
  and upsert, enable, join-request approval, enrollment-only codes, and owner
  enrollment. These statements already carry the revocation check. Rebinding
  and device-claim binding change existing enrollments only, so they have
  nothing to act on for a removed device.

### Why a stale or replayed invitation cannot lift a removal

| Attempt | What stops it |
| --- | --- |
| An invitation created before the removal | Condition 2. Its number is lower than the tombstone's. The coordinator database assigns both numbers in the statements that insert the rows, so no clock is involved and two coordinator instances cannot disagree. |
| An invitation the removed device created for itself or for a second identity before it was removed | The inviter rule. The invitation is refused for every acceptor once its inviter has a newer tombstone. |
| An invitation that another device already consumed | Condition 1. A consumed invitation is bound to one device ID and key. |
| An invitation this device consumed before it was removed, sent again | Condition 2. The tombstone has a higher number than the invitation. A retry also never lifts. |
| The invitation that lifted an earlier removal, after the device is removed again | Condition 2. The second tombstone has a higher number than that invitation. |
| A captured signed join request sent again | The invitation is consumed by then. The signature cannot move to another invitation because the token is inside the signed body. |
| An invitation from before the coordinator upgrade | Condition 2. Its number is null. |
| A valid new invitation presented by someone who does not hold the removed key | Condition 5. |
| Admin upsert, enable, join approval, or an enrollment-only code | Refused in a group whose tombstone is active, and in every group while the device has no enrollment left. |

### Limits

- A machine that discards its device ID and key is a new device. An unused
  invitation admits whoever holds it, so a removed or blocked machine's holder
  can use one with a fresh identity. This is also true of Block, and ADR 0007
  states it for Block. The Block confirmation says so when unused invitations
  exist, and they can be revoked in Sharing.
- An add-device invitation is created by any enrolled device of the same
  Identity. A person with a second enrolled device can therefore bring a
  removed device back without an administrator. To stop a person, remove that
  person from the Team.

## 2. What ends the Identity binding

The binding ends by setting `identity_devices.status` to `removed`. The row
stays. Deleting it would fire the existing trigger that deletes the device's
per-Team decisions, and a later rejoin would then widen access past an
exclusion that ADR 0005 keeps as a tombstone.

| Device | When the binding ends |
| --- | --- |
| The device that runs Remove or Block | In the local transaction that follows the coordinator's receipt, together with the pairing and cursor deletes. |
| Every other device that refreshes from the coordinator | When the lookup reports the device as `removed` or `revoked`, in the same transaction as the pairing and cursor deletes. Today a revoked device keeps its binding. This design ends it. |
| A device that runs Remove for a device the coordinator does not list | In the local-only transaction in Section 3. |
| The removed device itself | Its own binding rows are not touched. |

A missing enrollment in one group's snapshot never ends a binding. Only the
lookup result or a local Remove does.

An ended binding is treated as absent everywhere a binding grants something:
the reconciler's device list for an Identity, Devices, and the recipient
preview. The coordinator's own link between the device and an Identity is the
`identity_id` on the enrollment, and it goes with the enrollment. An ownership
binding from Google sign-in is immutable and stays.

For a device the coordinator lists, a binding becomes active again only
through the write that binds a newly enrolled device, from an enrollment the
coordinator currently holds. A removed device can be enrolled again only by
lifting its tombstone, so the binding cannot return while the removal stands.
Devices refuses to bind a device that the lookup reports as removed. For a
device that was removed locally only, pairing it again in Devices is the
explicit decision that binds it.

The local step waits for a coordinator refresh already running in the same
process and starts a new refresh when it finishes. A refresh in another
process can still apply a peer list fetched before the removal. The next
lookup corrects that, and the coordinator refuses membership grants for a
device with no enrollment during the gap.

## 3. A device the coordinator does not list

Remove has one entry in Devices. What it does depends on what this device can
confirm.

| Situation | Behavior |
| --- | --- |
| Coordinator configured, admin secret present, device enrolled | Coordinator removal (Section 1), then the local step. |
| No coordinator configured, or the admin listing shows no enrollment and no active tombstone for the device | Local-only removal. |
| Admin listing shows an active tombstone | The device is already removed. Run the local step and say so. |
| No admin secret, and the signed peer listing for this device's groups includes the device | Remove is disabled. The control says an administrator's device removes it. |
| No admin secret, and the signed peer listing succeeds without the device | Local-only removal. |
| The coordinator cannot be reached | Refuse and say to try again. The Viewer does not guess. |

Local-only removal runs one function in one transaction: delete the pairing,
delete its rows in both cursor tables, end the binding, and keep the pinned
key for memory retirement requests. The result tells the user that other
devices still sync with the removed device until they remove it too.

That function is the only code that deletes a pairing. Four places delete a
`sync_peers` row today: the Viewer route, `codemem sync peers remove`, the
revocation drop, and the cleanup of coordinator-policy pairings that lost
their last shared Project. Only the revocation drop deletes both cursor
tables. All four call the one function, and only the policy cleanup skips
ending the binding. This closes `codemem-l4dd`.
`sync_attempts` and `sync_scope_rejections` stay, because they are history for
Advanced diagnostics and hold neither trust nor sync position.

## 4. Block after a prior removal

Block's preview and commit read the current enrollment for the group and
device as evidence. When that enrollment is gone, they use the active
tombstone for the same group and device ID, which holds the same four fields.
The digest also binds which kind of evidence was used, so a preview made
against an enrollment does not commit against a tombstone without a new
preview. A lifted tombstone is never evidence, because a lifted tombstone
means the device has an enrollment in that group again or a newer tombstone
there.

Because every enrollment delete writes a tombstone (Section 1), a device that
was ever removed always has an enrollment or an active tombstone to block
from. Devices lists removed devices from `GET /v1/admin/devices/removals`,
each with **Block device permanently**, so the user can still reach a device
that no longer has a pairing. This closes `codemem-e3iox`.

After a block the lookup reports the device as `revoked`. A peer that already
dropped the device at removal has nothing left to drop. If someone pairs that
peer with the blocked key again, its next lookup reports `revoked`, and the
peer deletes the pairing and records the retired alias that stops further
pairing with that key.

## 5. Delivered memories, work in flight, and offline devices

**Memories already delivered.** Nothing is erased on any device. Memories the
removed device holds stay on it. Memories it created and already sent stay on
the other devices with their authorship unchanged, and keep syncing among the
devices that remain. Memory retirement can still ask the removed device to
delete a retired memory. A removed device that returns keeps its history and
catches up from its peers.

**Work in flight.**

| In flight at removal | Outcome |
| --- | --- |
| A sync exchange a peer already admitted | It finishes. The peer has no pairing for the next one. |
| An unused invitation the removed device issued | Refused for everyone (the inviter rule in Section 1). |
| A Project share the removed device issued that a recipient accepted but has not finished setting up | The bootstrap grant is revoked, so the recipient cannot start from the removed device. The recipient keeps its own enrollment. Setup resumes from another member's device, or from a new invitation. |
| An invitation the removed device accepted before removal | Its enrollment is deleted. A retry of that invitation cannot enroll it again (condition 2). |
| A membership grant queued for the removed device on an administrator's device | The coordinator refuses it. The next reconcile no longer lists the device, because its binding ended. |
| Pending join requests and reciprocal approvals | Denied and deleted in the removal transaction. |

**The removed device is offline.** Nothing has to reach it. When it returns,
its coordinator requests fail and its peers have no pairing for it. To tell
the user why, signed requests from a device with no enrollment and an active
tombstone in that group are verified against the tombstone's key and answered
with `403 device_removed`. An invalid signature still gets `unknown_device`,
so only the key holder learns of the removal. The removed device then stops
outbound sync to peers it found through that coordinator and shows "This
device was removed" with the way back. It deletes nothing.

**Another device is offline.** It keeps its pairing until its next sync tick.
Each tick runs the lookup before it syncs with any peer, so the device drops
the removed device before its own first outbound sync. Two cases remain. A
request from the removed device that arrives before that first lookup is
still accepted. A device that can reach the removed device and cannot reach
the coordinator keeps syncing with it. Block has both limits today, and ADR
0005's 24-hour ceiling for offline devices is not implemented. Section 7
shows the user which devices are still waiting.

## 6. Viewer actions that leave, and what the CLI keeps

| Action today | In 0.50 |
| --- | --- |
| Devices: Retire device | Replaced by Remove device and Block device permanently. |
| Coordinator administration: Remove | Leaves the Viewer. Devices Remove replaces it. |
| Coordinator administration: Disable and Enable | Leave the Viewer. Operators use the CLI. |
| Advanced: Remove device (local peer delete) | Leaves the Viewer. Devices Remove covers the unlisted case. |
| Advanced: Save name, and Coordinator administration: Rename | Leave the Viewer under ADR 0007 Decision 5. Devices rename remains. |

The CLI keeps the operator tools for group and enrollment repair.

| Command | Behavior in 0.50 |
| --- | --- |
| `codemem coordinator device list` | Unchanged. `--removed` lists active tombstones. |
| `codemem coordinator device remove <group> <device>` | Removes one group's enrollment and writes its tombstone. |
| `codemem coordinator device disable <group> <device>` | Unchanged. |
| `codemem coordinator device enable <group> <device>` | New, because the Viewer's Enable leaves. |
| `codemem coordinator device revoke <group> <device>` | Unchanged, and now works after a removal. |
| `codemem coordinator device enroll` | Refuses a device with an active tombstone and points to an invitation. |
| `codemem sync peers remove <peer>` | Local-only removal through the shared function. Prints the notice about other devices. |

## 7. Upgrade behavior

The rule: an older peer or coordinator never keeps a removed device's access
without the user seeing it.

| Mix | Behavior |
| --- | --- |
| 0.50 Viewer, older coordinator | The removal routes return 404. Remove refuses, changes nothing, and says the coordinator must be updated first. It never falls back to deleting the enrollment, because that would leave direct pairings syncing and report success. Local-only removal stays available only for a device the coordinator does not list. |
| 0.50 peer, older coordinator | The lookup returns 404 and pairings stay, as today. An older coordinator cannot record a removal, so there is nothing to miss. |
| Older peer, 0.50 coordinator | The older peer never runs the lookup. At its next permission refresh it stops exchanging memories in coordinator-managed Projects with the removed device, because the coordinator no longer lists that device as a member. Its direct pairing stays and still carries memories outside those Projects. The Viewer names this peer (below). |
| Older Viewer or CLI, 0.50 coordinator | Its per-group Remove now writes a tombstone. When the last enrollment goes, 0.50 peers drop their pairings. Its Enable and enroll cannot bring a removed device back. |
| Older codemem on the removed machine | It cannot sign a join request, so it cannot lift its removal until it updates. The join fails with `device_removed`. |
| Coordinator schema not yet migrated | The removal routes return `503 device_removal_unavailable`. They never delete an enrollment without a tombstone. On D1 the migration is applied before the Worker that uses it. |

**Showing who has applied a removal.** Each 0.50 device advertises
`applied_removal_seq` in presence (Section 1). For a removed device, Devices
compares the tombstone's number with the number each enrolled device
advertises and shows three groups: devices that have dropped it, devices that
have not checked in since the removal, and devices on an older version. For
the last group it says that those devices keep syncing with the removed device
until they update, and names them. The same list appears in the result of
Remove and of Block.

## 8. Viewer copy

`{name}` is the device's name. Both dialogs focus the cancel button.

### Remove device

- Title: **Remove {name}?**
- Body: "Your devices stop syncing with {name}. Devices that are online stop
  within a few minutes. A device that is offline stops when it next connects.
  Memories already on {name} stay there, and memories it already sent stay on
  your devices. Your other devices keep syncing with each other. To bring
  {name} back, create a new invitation in Sharing and accept it on {name}."
- Shown only when it applies: "{n} devices run an older version of codemem and
  keep syncing with {name} until they update: {list}."
- Link under the body: "Lost or stolen? Block it permanently instead."
- Buttons: **Remove device** and **Keep device**.
- Result: "{name} is removed. {done} of {total} devices have stopped syncing
  with it."

### Remove device, when the coordinator does not list it

- Title: **Remove {name} from this device?**
- Body: "This device stops syncing with {name} and forgets its sync progress.
  The coordinator doesn't list {name}, so your other devices keep syncing with
  it until you remove it on each of them. Memories already on either device
  stay."
- Buttons: **Remove from this device** and **Keep device**.
- Result: "{name} is removed from this device. Remove it on your other devices
  too."

### Block device permanently

- Title: **Block {name} permanently?**
- Body: "This cannot be undone. Use it for a lost, stolen, or compromised
  machine. Every device stops syncing with {name}, including devices paired
  with it directly. Devices that are online stop within a few minutes, and an
  offline device stops when it next connects. No invitation brings {name}
  back. That machine can only return if it is set up again as a new device.
  Memories already on {name} stay there, because blocking cannot erase them.
  Your other devices and their memories are not affected."
- Shown only when unused invitations exist: "{n} unused invitations still work
  for anyone who holds them. Revoke them in Sharing if the person holding
  {name} might have one."
- Link under the body: "Want to add it back later? Remove it instead."
- Buttons: **Block permanently** and **Keep device**.
- Result: "{name} is blocked. {done} of {total} devices have stopped syncing
  with it."

### Other states

- No admin secret, device listed: "Only an administrator's device can remove
  {name}."
- Older coordinator: "This coordinator needs an update before it can remove a
  device. Nothing was changed."
- On the removed device: "This device was removed from sharing. Its memories
  are still here. To rejoin, accept a new invitation."
- Unknown outcome: "The coordinator didn't confirm. Refresh Devices to see
  whether {name} was removed before you try again."

The device inventory state `retired` keeps its internal name and is shown as
"Blocked". A device with an active tombstone gets a new state, shown as
"Removed".

## Decisions requested

1. **Devices linked to a Google account.** A device with a coordinator
   ownership binding is refused by the invitation paths today
   (`device_ownership_requires_verified_identity`). The source inspection for
   this design found no other path that enrolls such a device once its
   enrollments are gone, and implementation starts by confirming that. Without
   a change, Remove would be permanent for these devices. Recommended: when lifting a removal, accept an
   `add_device` invitation for an owned device if the invitation targets the
   Identity in the ownership binding and the joining device ID and key both
   equal the binding's. Conditions 1 to 6 still apply. The alternative is a
   fresh Google sign-in on the removed device, which needs a new ceremony.
2. **Who may bring a device back.** Recommended: any valid invitation created
   after the removal, including an add-device invitation from the same
   person's other device. The alternative is to require an invitation created
   with the admin secret, which stops a teammate from undoing an
   administrator's removal and also stops a person from re-adding their own
   device without an administrator.
3. **Offline peers.** Recommended for 0.50: show which devices have not
   applied a removal, and keep the current behavior for devices that cannot
   reach the coordinator. The alternative is to pause sync with
   coordinator-linked peers after 24 hours without a successful lookup, which
   also stops sync between two devices that are both away from the coordinator
   for longer than that.
4. **Leftover cursor rows from earlier versions.** Recommended: a one-time
   cleanup at upgrade that deletes cursor rows whose device has no pairing.
   `codemem-l4dd` requires approval before any such purge.
5. **Removing the device you are using.** Recommended: refuse in 0.50, as
   Retire does. ADR 0007 defers the signed self-withdrawal route.
6. **Signed join for older machines.** Recommended: a removed machine must run
   0.50 to rejoin, because lifting requires a signed join request.

## Implementation order after approval

1. Coordinator: tombstone table, invitation column, removal store operation,
   and the removal check in every enrollment writer, on SQLite and D1.
2. Coordinator: removal routes, listing, lookup reply, `device_removed` for a
   removed device's signed requests, signed join.
3. Core: the one pairing-removal function, binding end, lookup handling, and
   `applied_removal_seq`.
4. Block: tombstone evidence.
5. Viewer and CLI: the two actions, removed-device list, copy, and removal of
   the old actions.
6. User guide and CLI reference.

Each step starts from the tests in the test plan. Nothing here is deployed to
a live coordinator without its own approval.
