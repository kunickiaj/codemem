# Remove device and Block device permanently

**Status:** Accepted by the owner on 2026-11-16, with the six decisions recorded under [Owner decisions](#owner-decisions). The owner then replaced decision 1 with rejoin by Google sign-in. Four security review passes changed the design, as listed under [Security review](#security-review). The owner accepted decisions 7 and 8 and the details of the sign-in ceremony on 2026-11-17. No owner decision is open. Not implemented.

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
  the removal. A machine that is signed in to a Google account returns by
  signing in on it again, with no invitation.
- **Block device permanently** is today's revocation of the device ID and key.
  Nothing lifts it. It also works on a device that was removed first.

Remove needs one new coordinator table, one column each on invitations and
enrollments, triggers on enrollments, two admin routes, one admin listing, and
two more fields in the lookup that peers already run at each refresh. Block
needs one change: it accepts a removal tombstone as evidence when the
enrollment is gone. Rejoining by Google sign-in needs a new ceremony, modeled
on the existing rebind ceremony.

Four passes of an independent security review found sixteen ways around
earlier drafts. Their fixes are part of this text and are listed under
[Security review](#security-review).

The owner settled six questions the design depended on. They are listed under
[Owner decisions](#owner-decisions).

## Terms

- **Enrollment:** the coordinator row that says a device key belongs to a group
  (`enrolled_devices`).
- **Pairing:** the row one device keeps about another device it syncs with
  (`sync_peers`), including the pinned key.
- **Sync progress:** the tables that record how far a pairing has synced. They
  are the two cursor tables (`replication_cursors` and
  `replication_cursors_v2`) and `sync_channel_progress`, which holds what a
  peer has acknowledged over the relay channel. Implementation found the third
  table. Wherever this note says "both cursor tables", the third goes with
  them.
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
| `lifted_at`, `lifted_by_invite_id`, `lifted_by_attempt_id` | Null while the tombstone is active. A lift sets the time and one of the other two, once: the invitation, or the sign-in attempt. |

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
  row ID, already exists. Any update that moves a row onto another row's group
  and device ID or row ID aborts, whichever name the statement uses for the
  row ID. Without this rule SQLite's replace-on-conflict deletes
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
{ "version": 1, "revoked": ["..."], "removed": ["..."], "enrolled": ["..."], "removal_seq": 42 }
```

- A requested device is `removed` when an active tombstone matches its device
  ID or its key, and no enrollment in any group has that tombstone's `key_id`.
  A device removed from one group by an operator and still enrolled in another
  with the same key is not reported. An enrollment of the same device ID under
  a different key does not hide the removal.
- `revoked` wins when both apply.
- A requested device is `enrolled` when any enrollment in any group, enabled
  or disabled, has its device ID or its key. Section 3 uses this to decide
  whether a removal must go through the coordinator.
- `removal_seq` is the coordinator's highest removal number. A peer with more
  than 25 entries sends several requests. After it has applied every reply of
  one complete lookup, it stores the lowest `removal_seq` among those replies
  and advertises it in its next presence update as `applied_removal_seq`. A
  removal recorded between two requests is therefore never counted as applied.
  Section 7 uses this to show which devices have applied a removal.
- The stored number is valid only for the pairings and bindings the lookup
  asked about. The peer keeps a local counter that every new or reactivated
  pairing or binding increases in its own transaction. A change of the key a
  pairing pins increases it too. A lookup notes the
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
make devices drop each other. The new exposure is that an enrolled device can learn whether a device ID or
key it names is enrolled or was removed anywhere on the coordinator. It can
already learn whether that device is blocked.

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
7. **No Google account link.** A device with a coordinator ownership binding
   is refused by every invitation path, as it is today. It rejoins by signing
   in, as the next section describes.

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

### Rejoining by signing in with Google

A device that was signed in to a Google account has an ownership binding: an
immutable coordinator row that ties its device ID and key to one Identity. The
owner decided that such a device needs no invitation to return. Its owner
signs in with Google on that device and confirms. This follows ADR 0005
Section 2, where a verified owner adds a device without an administrator or a
second device.

The ceremony reuses the three proofs of the existing rebind ceremony in ADR
0005 Section 8, bound to one short-lived attempt:

1. **The account.** A Google sign-in bound to the attempt, whose issuer and
   subject resolve to a live account link of the Identity in the device's
   ownership binding. A plain device-claim link, which is what a device gets
   when it signs in through the Viewer without an administrator's review,
   counts for this ceremony (decision 7).
2. **The key.** A signature over the attempt by the device key. The
   coordinator verifies it against the public key stored in the device's
   tombstone, whose canonical key ID equals the binding's.
3. **The confirmation.** A browser page that names the Google account, the
   Identity, the device, and the groups it returns to.

The coordinator also requires that one binding row holds both the device ID
and the key, that the binding belongs to the coordinator ID the request runs
under, that an active tombstone records exactly that device ID and key, and
that no block matches. It refuses when an active tombstone records the device
ID with another key. A coordinator with no trusted coordinator ID refuses.

The device returns only to groups where its Identity has not lost its
standing. An Identity-group grant is the coordinator's record that an Identity
may have devices in a group. A group qualifies when a tombstone with the
device's own ID and key names it, it is not archived, and the Identity either
has an active grant there or never had a grant row there (decision 8). A group
whose grant was revoked does not qualify. The second case applies only when
the device was enrolled in that group under the same Identity when it was
removed. A device that changed Identity afterwards needs an active grant.

One transaction then finalizes the attempt, sets the lift columns on every
active tombstone of the device's key, writes one enrollment with the binding's
Identity, device ID, and key in each qualifying group, and writes an audit
event. A tombstone of another device ID that shares the key is ended and never
enrolled. When no group qualifies, the ceremony refuses and writes nothing.
Lifting the tombstones without writing an enrollment would leave nothing to
block the device from, because Block takes an enrollment or an active
tombstone as evidence. Scope memberships are not restored. The reconciler
grants what current recipient policy gives that Identity.

Signing in alone changes nothing, as ADR 0005 requires. Only the confirmed
ceremony lifts the removal. Each rejoin appears on the Identity's other
devices at their next sync with a Remove action, and rejoins are limited to a
small number per Identity per day, as rebinding is.

This ceremony does not exist in code yet. The closest code is the rebind
ceremony, which changes existing enrollments and verifies against the enrolled
key. Its wire protocol is
[Device rejoin routes](../contracts/coordinator-auth-protocol.md#device-rejoin-routes)
in the account-link protocol.

A device that signs in for the first time, with no binding and no tombstone,
is the fresh-device enrollment of ADR 0005 Section 2. Today that exists only
as an operator-run CLI flow. Offering it in the Viewer is separate work and
not part of this design.

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
  Identity, and a person with a Google account can sign in on a removed
  device. A person can therefore bring their own removed device back without
  an administrator. To stop a person, remove that person from the Team.
- A Google-linked device whose Identity no longer has a qualifying account
  link can neither sign in to rejoin nor use an invitation. The same holds
  when no group it was removed from qualifies. Its holder sets it up as a new
  device.
- In a group that never had a grant for an Identity, the coordinator cannot
  tell that a person has left. A removed device of that person returns there
  when the person signs in. It receives no Project memories from that alone,
  because scope memberships come from current recipient policy.

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
coordinator currently holds. That write treats an ended binding as absent and
reuses its row. A removed device can be enrolled again only by
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

Remove has one entry in Devices. What it does depends on what the coordinator
says about the device. The Viewer asks through the signed lookup from
Section 1, whose reply also says whether the coordinator holds any enrollment
for a device ID or key, in any group, enabled or disabled. The signed peer
listing cannot answer this, because it shows only enabled devices in the
caller's own group.

| What this device learns | Behavior |
| --- | --- |
| No coordinator is configured | Local-only removal. |
| The lookup says the device is enrolled, and this device has the admin secret | Coordinator removal (Section 1), then the local step. |
| The lookup says the device is enrolled, and this device has no admin secret | Remove is disabled. The control says an administrator's device removes it. |
| The lookup says the device is removed or blocked | The device is already removed. Run the local step and say so. |
| The lookup says the device is not enrolled, removed, or blocked | Local-only removal. |
| The lookup gives no answer: the coordinator cannot be reached, predates the lookup, or does not list this device | Refuse and say why. The Viewer does not guess. An operator can still run `codemem sync peers remove`. |

`codemem sync peers remove` and the Viewer's peer removal route always allow
this device to disconnect. Without the admin secret, when a coordinator is
configured and has not confirmed that the device is removed, blocked, or not
enrolled, they delete only the pairing and sync progress. The binding stays
active and no Project policy is woken. An administrator's device ends the
binding and removes the device from Projects. Until the lookup client ships,
the coordinator's answer is unknown.

Local-only removal runs one function in one transaction: delete the pairing,
delete its rows in both cursor tables, end the binding, and keep the pinned
key for memory retirement requests. The result tells the user that other
devices still sync with the removed device until they remove it too.

That function is the only code that deletes a pairing. Four places delete a
`sync_peers` row today: the Viewer route, `codemem sync peers remove`, the
revocation drop, and the cleanup of coordinator-policy pairings that lost
their last shared Project. Only the revocation drop deletes both cursor
tables. All four call the one function. The policy cleanup and a disconnect
skip ending the binding. This closes `codemem-l4dd`.
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
is removed on 0.50 or later always has an enrollment or an active tombstone to
block from. Devices lists removed devices from
`GET /v1/admin/devices/removals`, each with **Block device permanently**, so
the user can still reach a device that no longer has a pairing. The listing
returns 500 tombstones at a time, newest first. Devices pages through it and
can ask for one device by ID, so an older removal stays reachable. Devices
that are already blocked are left out. This closes `codemem-e3iox` for
removals made on 0.50 or later.

A device whose enrollment was deleted before 0.50 has no tombstone. The
coordinator kept nothing about it, so it cannot be reported to peers as
removed and cannot be blocked from a tombstone. Each device that still pairs
with it removes it locally.

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
| `codemem sync peers remove <peer>` | Local-only removal through the shared function, or a disconnect that keeps the binding (Section 3). Prints the notice about other devices. |

## 7. Upgrade behavior

The rule: an older peer or coordinator never keeps a removed device's access
without the user seeing it.

| Mix | Behavior |
| --- | --- |
| 0.50 Viewer, older coordinator | The removal routes return 404. Remove refuses, changes nothing, and says the coordinator must be updated first. It never falls back to deleting the enrollment, because that would leave direct pairings syncing and report success. The Viewer offers no local-only removal either, because an older coordinator cannot confirm that it holds no enrollment for the device. `codemem sync peers remove` still works. |
| 0.50 peer, older coordinator | The lookup returns 404 and pairings stay, as today. An older coordinator cannot record a removal, so there is nothing to miss. |
| Older peer, 0.50 coordinator | The older peer never runs the lookup. At its next permission refresh it stops exchanging memories in coordinator-managed Projects with the removed device, because the coordinator no longer lists that device as a member. Its direct pairing stays and still carries memories outside those Projects. The Viewer names this peer (below). |
| Older Viewer or CLI calling a 0.50 coordinator over HTTP | Its per-group Remove now writes a tombstone. When the last enrollment of the key goes, 0.50 peers drop their pairings. Its Enable and enroll cannot bring a removed device back. |
| Older CLI opening a migrated coordinator database directly | The triggers refuse its enroll once any tombstone exists, because it supplies no `key_id`. They refuse its remove, because it writes no tombstone. Both fail with a constraint error and change nothing. From the moment the triggers are installed, with or without a tombstone, they also refuse its enroll of a device that is already enrolled in that group. The older release writes that as an upsert, and the collision trigger aborts an insert that meets an existing row before the upsert's update can run. |
| Older codemem on the removed machine | It cannot sign a join request and has no sign-in rejoin, so it cannot lift its removal until it updates. A join fails with `device_removed`. |
| Coordinator schema not yet migrated, or `key_id` not yet filled for every enrollment | The removal routes return `503 device_removal_unavailable`. They never delete an enrollment without a tombstone. On D1 the migration and the `key_id` fill are applied before the Worker that uses them. An older Worker keeps enrolling new devices on the migrated schema until the first removal is recorded. Once the enrollment triggers are installed it can no longer remove a device or enroll one that is already enrolled, so the trigger migration is applied in the same window as the 0.50 Worker. |

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
  your devices. Your other devices keep syncing with each other."
- Last sentence of the body, for a device with no Google account link: "To
  bring {name} back, create a new invitation in Sharing and accept it on
  {name}."
- Last sentence of the body, for a device linked to a Google account that can
  rejoin by sign-in: "To bring {name} back, sign in with Google on {name}.
  Whoever can sign in to that account on {name} can bring it back."
- Last sentence of the body, for a device linked to a Google account that
  cannot rejoin by sign-in: "{name} is linked to a Google account and cannot
  be added back after you remove it. It would have to be set up as a new
  device."

The removal preview says which of the three sentences applies, from the same
checks the rejoin would run.
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
- No answer from the coordinator: "codemem couldn't check {name} with the
  coordinator, so nothing was changed. Try again when the coordinator is
  reachable."
- On the removed device, with no Google account link: "This device was removed
  from sharing. Its memories are still here. To rejoin, accept a new
  invitation."
- On the removed device, linked to a Google account: "This device was removed
  from sharing. Its memories are still here. To rejoin, sign in with Google."
  The button is **Sign in to rejoin**.
- Unknown outcome: "The coordinator didn't confirm. Refresh Devices to see
  whether {name} was removed before you try again."

The device inventory state `retired` keeps its internal name and is shown as
"Blocked". A device with an active tombstone gets a new state, shown as
"Removed".

## Owner decisions

The owner decided these on 2026-11-16.

1. **Devices linked to a Google account rejoin by signing in.** A device with
   a coordinator ownership binding is refused by the invitation paths today
   (`device_ownership_requires_verified_identity`). The source inspection for
   this design found no path that enrolls such a device once its enrollments
   are gone, and implementation starts by confirming that. The owner first
   accepted an invitation for the device's own Identity. The second security
   review showed that the inviter's authority could be forged, and its fix
   left a person whose only signed-in device was removed with no way back. The
   owner then chose sign-in: a device of a verified Identity needs no
   invitation. Section 1 describes the ceremony.

   The owner confirmed three details of that ceremony on 2026-11-17. The
   device returns only to groups it was removed from. A device with a Google
   account link cannot use an invitation at all. Each rejoin shows on the
   Identity's other devices with a Remove action, and rejoins are limited per
   Identity per day, as rebinding is.
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
   signed join request or the sign-in ceremony.

The third security review raised two questions about sign-in rejoin. The owner
decided both on 2026-11-17.

7. **A plain device-claim link can bring its device back.** Owner enrollment
   accepts a link that an administrator reviewed, or one explicitly qualified
   for owner enrollment. It refuses a plain device-claim link, which is what a
   device gets when it signs in through the Viewer without a review. ADR 0005
   Section 8 lets such a link authorize rebinding and nothing else. The owner
   accepted it for rejoin as well, because the ceremony can only restore the
   device that the ownership binding already names, in groups it was removed
   from. The alternative left most devices that signed in through the Viewer
   unable to rejoin by signing in.
8. **A device returns to a group that never had a grant for its Identity.** A
   group whose grant was revoked still refuses it. A group without a grant row
   has no coordinator record of who belongs to it, so the removed enrollment
   is the only record there is, and the rejoin restores what the removal took.
   The cost is that the coordinator cannot tell that a person left such a
   group. The alternative returned a device only to groups with an active
   grant. The fourth security review narrowed this to a device that was
   removed from the group under the same Identity it has now. Otherwise a
   device could change Identity to get around a grant that was revoked for its
   earlier Identity.

Decision 7 adds a second use of a plain device-claim link. ADR 0005 Section 8
and the "Operator-only consumers" rule in the account-link protocol were
amended on 2026-11-17 to name it.

ADR 0007 Decision 5 and ADR 0005 Sections 5 and 8 were amended on 2026-11-17
to say that a removed device of a verified Identity rejoins by signing in.

## Implementation order

1. Coordinator: tombstone table, invitation and enrollment columns, triggers,
   removal store operation, the removal check in every enrollment writer, and
   the enrollment requirement in the membership statement, on SQLite and D1.
2. Coordinator: removal routes, listing, lookup reply, `device_removed` for a
   removed device's signed requests, signed join.
3. Rejoin by sign-in: the protocol in the account-link contract, its security
   review, then the coordinator ceremony and the Viewer flow. Until this step
   ships, Remove tells the user that a Google-linked device cannot be brought
   back yet.
4. Core: the one pairing-removal function, binding end, lookup handling, and
   `applied_removal_seq`.
5. Block: tombstone evidence.
6. Viewer and CLI: the two actions, removed-device list, copy, and removal of
   the old actions.
7. User guide and CLI reference.

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

The second pass read only the changes from the first pass and the rule the
owner had then accepted for Google-linked devices: an add-device invitation
for the device's own Identity. It confirmed that the fixes for the first three
findings close them. It found five further paths, and all five changed this
design.

| Finding | Severity | Change |
| --- | --- | --- |
| The invitation rule for Google-linked devices required only that the inviter's enrollment carry the Identity. A Project invitation lets the accepting device name any Identity, so the holder of a removed Google-linked device could enroll a fresh device under that Identity and invite the removed one back. | High | The invitation rule was withdrawn. A Google-linked device rejoins by signing in, which has no inviter. |
| The same rule did not compare coordinator IDs, so a binding kept from another coordinator ID could authorize the lift. | Medium | The sign-in ceremony requires the binding to belong to the request's coordinator ID. |
| A lift ends tombstones in every group. A device that rejoined one group could then use an enrollment-only code from before its removal to enter another. | Medium | Condition 2 applies to every kind of invitation. |
| The triggers missed an update that moves an enrollment to another group, and SQLite's replace-on-conflict, which deletes a row without running its delete trigger. | Medium | The triggers cover the group column and refuse colliding inserts and updates. 0.50 writers stop using upserts on enrollments. |
| A peer could advertise a removal as applied and then regain the pairing from an older peer list applied by another process, or gain one the lookup never asked about. | Medium | A local counter withdraws the advertised number whenever a pairing or binding is added. |

The second pass also noted that the coordinator does not know whether an
Identity was merged or deactivated on a device. It could not show access from
that, and this design does not change it.

### Third pass

The owner asked for a third pass. It read the changes from the second pass and
the sign-in ceremony. It confirmed that the enrollment-only code finding is
closed and that the withdrawn invitation rule is gone. It found four further
paths, and all four changed this design.

| Finding | Severity | Change |
| --- | --- | --- |
| Sign-in rejoin enrolled the device in every group a tombstone named. A group where the Identity's grant was revoked after the removal got its enrollment back. | High | A group qualifies only with an active Identity-group grant. |
| The ceremony proved one device ID and key and then acted on every tombstone that matched the device ID or the key. A device with an older tombstone under another key, or another device ID that shared the key, could be enrolled without proof. | High | Enrollments use only the binding's device ID and key. An active tombstone of the device ID under another key makes the ceremony refuse. |
| The collision trigger named the row ID column, and SQLite accepts two other names for it. | Medium | The trigger has no column list. |
| The local counter ignored a change of the key an existing pairing pins. | Medium | A key change increases the counter. |

The third pass also listed requirements for the sign-in protocol, which the
contract now states: bind the attempt to the exact tombstones, groups, grant
revisions, and account link, finalize once, make every write depend on one
winning statement, and check blocks and grants in the final statements. It
left two authority questions for the owner. The owner then accepted the wider
answer for both, as decisions 7 and 8. The pass reviewed the stricter answers,
so the review of the sign-in protocol must examine both decisions.

### Fourth pass

The fourth pass read the sign-in wire protocol in the account-link contract,
owner decisions 7 and 8, and every design change the third pass had not seen.
It confirmed the third-pass fixes and found no path that lifts a block. It
found three problems in the protocol, and all three changed it.

| Finding | Severity | Change |
| --- | --- | --- |
| Decision 8 let a device return to a group with no grant row for its Identity. A device could change Identity after leaving a group and so avoid a grant that was revoked for its earlier Identity. | Medium | The no-grant case requires that the removal record for that group names the same Identity. |
| The protocol allowed one open attempt for each device, and starting one needs only the device key. Someone with a copy of the key could keep that slot occupied and stop the owner from rejoining. | Medium | Attempts no longer exclude each other. A start can expire only attempts that have not proven the Google account. |
| The rejoin notice was a marker that expired after seven days, so a device that was offline longer never saw it. | Medium | The marker lasts as long as the enrollment, and a signed route returns rejoin events from a cursor. |

It also asked for three clarifications, now in the protocol: the account link
must pass the full lifecycle check and not the narrower one rebinding uses,
the browser and attempt rules that rebinding inherits are stated, and expired
attempts are cleaned up.

No review has checked the changes from the fourth pass. The reviewer ran
SQLite checks of the proposed triggers and no tests of this design.
