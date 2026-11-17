# Remove device and Block device permanently

**Status:** Accepted by the owner on 2026-11-16, with the six decisions recorded under [Owner decisions](#owner-decisions). A second security review then changed five points. One of them narrows decision 1 and waits for the owner's confirmation. Not implemented.

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

Remove needs one new coordinator table, one column each on invitations and
enrollments, triggers on enrollments, two admin routes, one admin listing, and
two more fields in the lookup that peers already run at each refresh. Block
needs one change: it accepts a removal tombstone as evidence when the
enrollment is gone.

Two passes of an independent security review found nine ways around earlier
drafts. Their fixes are part of this text and are listed under
[Security review](#security-review).

The owner settled six questions the design depended on. They are listed under
[Owner decisions](#owner-decisions).

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

`enrolled_devices` gains `key_id`, the canonical key ID of the enrollment's
key, or an empty string for a key that is not SSH Ed25519. Every enrollment
writer already derives this ID for the revocation check and now stores it. The
migration fills it for existing rows. With it, one SQL statement can find
every enrollment of a key under any device ID or key text.

Triggers on `enrolled_devices` make the database refuse writes that would
defeat a removal, whichever program issues them:

- An insert, or an update of the group, device ID, or key, aborts when an
  active tombstone matches the new device ID or key. A key that is not SSH
  Ed25519 is compared by its exact text. The same write aborts when it
  supplies no `key_id` and any tombstone exists.
- An insert aborts when a row with the same group and device ID, or the same
  row ID, already exists. An update that moves a row onto another row's group
  and device ID aborts. Without this rule SQLite's replace-on-conflict deletes
  the other row without running its delete trigger.
- A delete aborts unless an active tombstone already holds that row's group,
  device ID, and key.
- An update that enables a row aborts when an active tombstone of the same
  group matches it.

Because of the second rule, 0.50 writers update an existing enrollment with an
`UPDATE` and insert only when no row exists. They no longer use an upsert on
this table. The removal operation inserts the tombstone before it deletes the
enrollment, and a lift sets the lift columns before it inserts the enrollment,
so both pass. An older codemem that opens the coordinator database directly
cannot re-enroll a removed device or delete an enrollment without a tombstone.

### Removal route

`POST /v1/admin/devices/removal-preview` and `POST /v1/admin/devices/removal`
require the coordinator admin secret, like the other `/v1/admin/devices`
routes. They do not depend on the operator configuration that Block requires,
so every coordinator with an admin secret can remove a device.

- Preview takes `{ "device_ids": [...] }` with one to eight IDs. One machine
  can be enrolled under several device IDs that share a key, and the Viewer
  sends the set it knows, as Retire does today. The coordinator reads every
  enrollment of those IDs in every group, including archived groups. It
  refuses with `409 removal_target_conflict` when they carry more than one
  key, and with `404 removal_target_not_enrolled` when none exists. It then
  adds every enrollment that has the same `key_id` under any other device ID.
  The reply lists all of these enrollments and a digest over them.
- Commit takes the same IDs and the digest. In one transaction it selects the
  enrollments by the same rule, device ID or `key_id`, and checks that this
  complete set still matches the digest. An enrollment of the same key that
  appeared after the preview makes the commit stale. Then for each enrollment
  it inserts a tombstone and deletes the enrollment and its presence row. In the same
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

Membership grants need one change that the first draft took for granted. On
D1 a grant reads the enrollment and then writes the membership in a separate
step, so a grant that was already running could write an active membership
after the removal. The statement that writes a membership now requires an
enabled enrollment of that device in the scope's group, and the grant's
receipt and audit row depend on that statement.

The legacy `POST /v1/admin/devices/remove`, which older Viewers and the CLI
call for one group, uses the same store operation for that single enrollment.
From 0.50 no code path deletes an enrollment without writing a tombstone, and
the delete trigger enforces it.

### How peers learn

Peers already call `POST /v1/peers/revocations` at the start of each
coordinator refresh, before any sync in that cycle. This check landed after
0.49.1 and no release contains it, so its reply can still change. The reply
becomes:

```json
{ "version": 1, "revoked": ["..."], "removed": ["..."], "removal_seq": 42 }
```

- A requested device is `removed` when an active tombstone matches its device
  ID or its key, and no enrollment in any group has that tombstone's `key_id`.
  A device removed from one group by an operator and still enrolled in another
  with the same key is not reported. An enrollment of the same device ID under
  a different key does not hide the removal.
- `revoked` wins when both apply.
- `removal_seq` is the coordinator's highest removal number. A peer with more
  than 25 entries sends several requests. After it has applied every reply of
  one complete lookup, it stores the lowest `removal_seq` among those replies
  and advertises it in its next presence update as `applied_removal_seq`. A
  removal recorded between two requests is therefore never counted as applied.
  Section 7 uses this to show which devices have applied a removal.
- The stored number is valid only for the pairings and bindings the lookup
  asked about. The peer keeps a local counter that every new or reactivated
  pairing or binding increases in its own transaction. A lookup notes the
  counter when it reads its entries and stores the number only if the counter
  is unchanged when it finishes. Any later new pairing or binding sets the
  stored number to 0, and the peer advertises 0 until a complete lookup has
  covered the new entry.
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
7. **For a device linked to a Google account, its own Identity.** A device
   with a coordinator ownership binding is refused by every invitation path
   today. When it lifts a removal, it is accepted only with an `add_device`
   invitation whose target Identity is the Identity in the binding, and when
   one binding row holds both the joining device ID and the joining key. The
   inviter device must have its own ownership binding to that same Identity.
   An enrollment that merely carries the Identity is not enough, because a
   Project invitation lets the accepting device name any Identity for its
   enrollment. Both bindings must belong to the coordinator ID the request
   runs under, and a coordinator with no trusted coordinator ID refuses this
   case. The enrollment is written with the binding's Identity. A
   `team_member` or Project invitation, or a join that is not a lift, stays
   refused for such a device.

When they hold, one transaction consumes the invitation, writes the enrollment
in the invitation's group, and sets `lifted_at` and `lifted_by_invite_id` on
every active tombstone that matches the device ID or key. Nothing else comes
back. Scope memberships, pairings, and enrollments in other groups are created
only by the paths that create them for a new device, and an invitation that
predates the removal stays refused in every group.

A retry of a consumed invitation by the device it is bound to never lifts a
tombstone. The lift happens only in the transaction that first consumes the
invitation. A retry is still checked against condition 2, so it cannot enroll
a device that was removed after it accepted.

Three rules apply outside lifting.

- Condition 2 applies to every kind of invitation at every acceptance,
  including an enrollment-only code and the invitation behind a join request.
  A lift ends the active tombstones in all groups, so without this rule a
  device that rejoined one group could use an old enrollment-only code to
  enter another.
- An invitation whose inviter device has a tombstone numbered above the
  invitation is refused for every acceptor, including a device that was never
  removed. Today a missing inviter only skips the bootstrap grant.
- Every path that creates an enrollment without one of those invitations
  refuses with `403 device_removed` while an active tombstone in any group
  matches the device ID or key. There is no exception for a device that is
  still enrolled elsewhere. That covers admin enroll and upsert, join-request
  approval, enrollment-only codes, and owner enrollment. These statements
  already carry the revocation check, and the insert trigger backs them.
  Rebinding and device-claim binding change existing enrollments only, so they
  have nothing to act on for a removed device. Enable also acts on an existing
  enrollment, and it is refused when an active tombstone of the same group
  matches that enrollment.

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
| Admin upsert, join approval, or an enrollment-only code, in any group | Refused while a tombstone is active. |
| An enrollment-only code from before the removal, used for another group after the device rejoined one | Condition 2 applies to every kind of invitation. |
| The removed device ID claimed with another key, or the removed key under a new device ID, through any of those paths | Refused. A tombstone matches by device ID or by key. |
| A second enrollment created only to make the coordinator stop reporting the removal | The lookup counts only enrollments of the tombstone's own key, and creating one needs a lift signed by that key. |

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
lookup corrects that. During the gap the coordinator writes no membership for
the device, because the membership statement requires its enrollment
(Section 1).

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

Earlier versions left cursor rows behind. The first start on 0.50 deletes, in
one transaction, every row in either cursor table whose device has no pairing.
Such a row has no peer to sync with, so deleting it cannot move a live
pairing's position.

## 4. Block after a prior removal

Block's preview and commit read the current enrollment for the group and
device as evidence. When that enrollment is gone, they use the active
tombstone for the same group and device ID, which holds the same four fields.
The digest also binds which kind of evidence was used, so a preview made
against an enrollment does not commit against a tombstone without a new
preview. A lifted tombstone is never evidence, because a lifted tombstone
means the device has an enrollment again or a newer tombstone.

Block from Devices runs the removal first and the revocation second. It first
previews the block against the enrollment to confirm that the coordinator can
block at all, and removes nothing if it cannot. After the removal it previews
again, now against the tombstone, and commits that preview. A blocked device
then has no enrollment rows left, and it has tombstones whose number
Section 7 compares against each peer. If the removal succeeds and the
revocation does not, Devices says that the device is removed and not yet
blocked, and offers Block again from the removed-device list. The operator
command `codemem coordinator device revoke` keeps revoking without removing.

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
| `codemem coordinator device remove <group> <device>` | Removes one group's enrollment and writes its tombstone. Until an invitation lifts that tombstone, the device cannot be enrolled into any group without an invitation. |
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
| Older Viewer or CLI calling a 0.50 coordinator over HTTP | Its per-group Remove now writes a tombstone. When the last enrollment of the key goes, 0.50 peers drop their pairings. Its Enable and enroll cannot bring a removed device back. |
| Older CLI opening a migrated coordinator database directly | The triggers refuse its enroll once any tombstone exists, because it supplies no `key_id`. They refuse its remove, because it writes no tombstone. Both fail with a constraint error and change nothing. |
| Older codemem on the removed machine | It cannot sign a join request, so it cannot lift its removal until it updates. The join fails with `device_removed`. |
| Coordinator schema not yet migrated, or `key_id` not yet filled for every enrollment | The removal routes return `503 device_removal_unavailable`. They never delete an enrollment without a tombstone. On D1 the migration and the `key_id` fill are applied before the Worker that uses them. An older Worker keeps enrolling devices on the migrated schema until the first removal is recorded. |

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
- Shown only for a device linked to a Google account, when another device is
  signed in to that account: "{name} is signed in to a Google account. To
  bring it back, create the invitation on another device that is signed in to
  the same account."
- Shown only for a device linked to a Google account, when no other device is
  signed in to that account: "{name} is the only device signed in to its
  Google account. If you remove it, it cannot be added back until another
  device signs in to that account."
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

## Owner decisions

The owner accepted these on 2026-11-16.

1. **Devices linked to a Google account can rejoin by invitation.** A device
   with a coordinator ownership binding is refused by the invitation paths
   today (`device_ownership_requires_verified_identity`). The source
   inspection for this design found no other path that enrolls such a device
   once its enrollments are gone, and implementation starts by confirming
   that. Condition 7 in Section 1 opens one path for a lift. The alternative
   was a new Google sign-in ceremony on the removed device.

   The second security review narrowed this after the owner accepted it. The
   inviter must itself be signed in to the same Google account, which the
   coordinator sees as the inviter's own ownership binding. A person whose
   only signed-in device is the removed one cannot bring it back until another
   of their devices signs in. The Remove confirmation says so. This narrowing
   waits for the owner's confirmation.
2. **Any invitation created after the removal can bring a device back.** That
   includes an add-device invitation from the same person's other device. The
   alternative was to require an invitation created with the admin secret,
   which would also stop a person from re-adding their own device without an
   administrator.
3. **0.50 shows which devices have not applied a removal and adds no offline
   expiry.** A device that cannot reach the coordinator keeps its pairing
   until a later lookup succeeds. The alternative was to pause sync with
   coordinator-linked peers after 24 hours without a successful lookup, which
   would also stop sync between two devices that are both away from the
   coordinator for longer than that.
4. **The upgrade deletes leftover cursor rows once.** A cursor row in either
   table whose device has no pairing is deleted at the first start on 0.50.
   This is the purge that `codemem-l4dd` required approval for.
5. **Remove refuses the device you are using.** ADR 0007 defers the signed
   self-withdrawal route.
6. **A removed machine must run 0.50 to rejoin,** because lifting requires a
   signed join request.

## Implementation order

1. Coordinator: tombstone table, invitation and enrollment columns, triggers,
   removal store operation, the removal check in every enrollment writer, and
   the enrollment requirement in the membership statement, on SQLite and D1.
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

## Security review

A reviewer on a model from a different vendor examined this design twice on
2026-11-16 for one question: can a removed or blocked device regain access, or
can anyone lift a removal they should not. Neither pass found a path that
lifts a block.

### First pass

The first pass read the first draft. It confirmed four paths around a removal
and raised two questions. All six changed this design.

| Finding | Severity | Change |
| --- | --- | --- |
| The draft let a path without an invitation enroll a removed device ID when any enrollment shared the incoming device ID or key. An enrolled device could claim the removed ID with its own key through an enrollment-only code, hide the removal from peers, and let the removed device re-enroll. | High | Paths without an invitation refuse every match of an active tombstone, with no exception. The lookup counts only enrollments of the tombstone's own key. |
| A device could enroll a second device ID with the same key between preview and commit. The removal then left that enrollment in place and peers never dropped the key. | High | `enrolled_devices.key_id`. Preview and commit cover every enrollment of the key, and a new one makes the commit stale. |
| On D1 a membership grant already in progress could write an active membership after the removal, which would authorize again after a rejoin. | Medium | The membership statement requires an enabled enrollment, and the receipt depends on it. |
| An older CLI that opens the coordinator database directly could enroll a removed device or delete an enrollment without a tombstone. | Medium | Triggers on `enrolled_devices`. |
| With more than 25 pairings, a peer could advertise a removal as applied when it had asked about that device before the removal. | Question | The peer advertises the lowest number among the replies of one complete lookup. |
| A block without a prior removal had no number to compare against peers. | Question | Block from Devices runs the removal first. |

The first pass read the three documents, ADR 0005 Section 5, ADR 0007, and the
coordinator, invitation, membership, lookup, daemon, binding, and CLI source.
It did not inspect every account-link writer or run any test.

### Second pass

The second pass read only the changes from the first pass and condition 7. It
confirmed that the fixes for the first three findings close them. It found
five further paths, and all five changed this design.

| Finding | Severity | Change |
| --- | --- | --- |
| Condition 7 required only that the inviter's enrollment carry the Identity. A Project invitation lets the accepting device name any Identity, so the holder of a removed Google-linked device could enroll a fresh device under that Identity and invite the removed one back. | High | The inviter needs its own ownership binding to the Identity. |
| Condition 7 did not compare coordinator IDs, so a binding kept from another coordinator ID could authorize the lift. | Medium | Both bindings must belong to the request's coordinator ID. |
| A lift ends tombstones in every group. A device that rejoined one group could then use an enrollment-only code from before its removal to enter another. | Medium | Condition 2 applies to every kind of invitation. |
| The triggers missed an update that moves an enrollment to another group, and SQLite's replace-on-conflict, which deletes a row without running its delete trigger. | Medium | The triggers cover the group column and refuse colliding inserts and updates. 0.50 writers stop using upserts on enrollments. |
| A peer could advertise a removal as applied and then regain the pairing from an older peer list applied by another process, or gain one the lookup never asked about. | Medium | A local counter withdraws the advertised number whenever a pairing or binding is added. |

The second pass also noted that the coordinator does not know whether an
Identity was merged or deactivated on a device. It could not show access from
that, and this design does not change it.

No review has checked the five changes from the second pass. The reviewer ran
no tests of this design, because nothing is implemented.
