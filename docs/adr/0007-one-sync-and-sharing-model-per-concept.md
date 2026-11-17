# ADR 0007: One sync and sharing model per concept

**Date:** 2026-11-16

**Status:** Proposed

**Amends:** [ADR 0001](0001-project-recipient-policy-boundaries.md) (Decisions 3, 5, and 6) and [ADR 0005](0005-authenticated-identity-device-and-membership-lifecycle.md) (Section 5)

**Related ADRs:** [ADR 0002](0002-legacy-team-hardening-boundaries.md), [ADR 0004](0004-authenticated-identity-and-live-relay-boundaries.md)

**Related contract:** [Coordinator device revocations](../contracts/coordinator-device-revocations.md)

**Affected areas:** Viewer (Projects, Sharing, Devices, Advanced), recipient policy, replication scopes, coordinator enrollment and invitations, device removal

**Related task:** `codemem-lvgba`

## Summary

The model a person holds is short. There are Teams, and Teams have members.
A Project is shared with a Team, or with one person. Each member's devices
receive the Projects shared with that member.

A person manages four things under that model: their devices, the people they
share with, Teams, and which Projects are shared with whom. Each of the four
gets one stored model, one home in the Viewer, and one set of actions.

Today the Viewer shows that model while sync enforces an older one built on
Spaces. This ADR retires Space as a separate concept. The sharing boundary
becomes the Project itself, existing installs are migrated automatically, and
the actions that exist only under Advanced move into the screens where people
look for them.

## Context

ADR 0001 introduced Project, Identity, Team, and Device as the user-facing
concepts and kept replication scopes (Spaces) as the security boundary. It
separated intent, effective access, and enforcement, and it expected each
Project to cut over to recipient-policy authority after a parity gate.

A source audit at commit `8b3072704` found that the cutover is incomplete and
that several generations of models still act at the same time.

### What sync checks today

When a memory is sent or received, sync reads six things
(`packages/core/src/sync-replication.ts`, `sync-scope-protocol.ts`):

1. a pairing between the two devices (`sync_peers`, with a pinned key)
2. the memory's Space, stamped when the memory is written from the Project's
   Space mapping
3. coordinator membership of both devices in that Space, with a key-bound
   proof
4. a local deny overlay for access that is being revoked
5. the memory's visibility
6. a project filter stored on each pairing.

Identities, Teams, recipient edges, and Identity-to-device bindings are not
read at sync time. A background reconciler turns them into Space memberships
(`recipient-policy-reconciler.ts`), and it runs only when both of these hold:

- the Project maps to exactly one active Space of kind `managed_project`
- the device running the reconciler holds the coordinator admin secret.

### What follows from that

- Recipient changes saved on a device without the admin secret never take
  effect, and no screen says so.
- Recipient changes for a Project in any other kind of Space never take effect.
  Projects that went through legacy Team setup are in this state, because that
  setup does not create a `managed_project` Space.
- Two mechanisms grant or block data with no visible recipient. Approving a
  join request can grant a group's default Space to the new device. The project
  filter on a pairing can block a Project that every other model allows, and
  the Viewer has no editor for it.
- One device has four stored records (`sync_device`, `sync_peers`, coordinator
  `enrolled_devices`, `identity_devices`) and three stored names. They are
  joined only in a read model. No job ends an Identity-to-device binding.
- Four actions remove a device, with four different effects. Coordinator Remove
  leaves direct pairings syncing. The newest action, Retire, revokes the
  device ID and key permanently, so the same machine can never enroll again.
- Managing people (merge, deactivate, rename) exists only under Advanced, where
  it is labelled "People". Deactivating or merging a person blocks the
  reconciler before its revocation step, so the person's devices keep access
  while the person disappears from Sharing and Devices.
- A Team can be created only by accepting an invitation or by migrating a
  coordinator group, and groups are created only under Advanced.
- Invitations are accepted in three places depending on their kind. Three
  creators still produce the older enrollment-only kind.
- The same sharing boundary is called Space, Sharing domain, scope, enforcement
  boundary, shared-space, and legacy Space across UI and server copy.

## Principles

1. **One model per concept.** Each of the four concepts has one authoritative
   record, one Viewer home, and one action for each thing a person wants to do.
2. **A superseded concept stops ruling behavior.** When a model is replaced,
   existing installs are migrated automatically and the old concept no longer
   gates sync. Migration preserves exactly the access that exists at that
   moment. It never widens access, and it asks the user only when the current
   state is ambiguous.
3. **A screen never saves a change that cannot take effect.** If this device
   cannot apply a change, the control is disabled and says which device can.
4. **The admin secret gates changes to other people's access.** A device can
   always withdraw itself without it.

## Decisions

### 1. Four concepts and their homes

| Concept | Home | Actions that live there |
| --- | --- | --- |
| Device | Devices | Pair, approve a discovered device or a join request, rename, remove, block, sync now, attach history from an older unnamed device |
| Person (Identity) | Sharing | Rename, merge duplicates, deactivate |
| Team | Sharing | Create, rename, manage members, invite |
| Project sharing | Projects | Choose recipients, stop sharing, review older shared data |

Coordinator connection settings live in Settings. Advanced keeps diagnostics
and tools for people who operate a self-hosted coordinator.

### 2. The sharing boundary is the Project, and Space is retired as a concept

Space was introduced as a hard wall between kinds of work, such as personal
and employer Projects, with Teams owning Spaces and devices granted access to
each Space. Project-first sharing replaced that way of thinking for users
without replacing it in enforcement. This decision finishes the replacement.

A shared Project has exactly one boundary of its own. Its members are the
devices of the people and Teams the Project is shared with, and nothing else
can add or remove a member. No boundary holds more than one Project. The
mechanism underneath is the existing coordinator membership check with its
key-bound proof, stored as a `managed_project` scope. It has no name in the
product and no screen of its own.

There is no wall above the Project inside one install. Sharing a Project with
the wrong Team is prevented by the recipient review, as in any sharing product.
People who need strict separation between, for example, employer and personal
work use separate coordinators or profiles, as ADR 0005 Section 1 describes.

Recipient edges are then enforced for every shared Project through the
existing reconciler.

- New shares already provision this Space. That path is unchanged.
- Existing Projects in a `team`, `team_default`, `org`, or `client` Space are
  migrated automatically, one Project at a time. The migration creates the
  Project's Space, grants it to exactly the devices that can receive the
  Project today, records matching recipient edges, and moves the Project's
  memories with the existing delete-then-upsert reassignment.
- The migration runs on a device that holds the admin secret. Other devices
  show the Project as waiting for that device.
- A Project whose current recipients cannot be determined keeps its current
  enforcement and appears in Projects as one review item. It is never widened
  to make it fit.
- "Space", "Sharing domain", and "scope" leave user-facing copy. Projects shows
  who receives a Project. The control now labelled "Advanced Space assignment"
  is replaced by the recipient controls.
- A person and a Team stay two choices in the recipient picker. Whether a
  single person is stored as a Team of one is an implementation choice for the
  recipient-policy contract and does not change this ADR.

This satisfies ADR 0001 Decision 3 by construction. The cutover stays
per-Project, and the granted device set equals the set that had access before.
It amends that decision in one respect: a Project that meets the conditions is
cut over automatically, without a manual review step.

### 3. The two invisible access paths are retired

- **Default Space auto-grant.** Approving a join request stops granting the
  group's default Space. Devices that hold access through a default Space keep
  it until Decision 2 has migrated every Project in that Space. The default
  Space and its preference are removed after that.
- **Project filter on a pairing.** Filters are converted during the same
  migration. A filter that excludes a Project becomes the absence of that
  device from the Project's Space. The filter columns, the group filter
  template, and the sync-time check are removed once no pairing carries a
  filter.

Neither is removed before its migration exists and has run.

### 4. Who can change access

- Changing which people, Teams, or devices receive a Project requires the
  coordinator admin secret on the device making the change. This is the rule
  for now. Roles may replace it later.
- On a device without the secret, access controls are read-only and say that an
  administrator's device applies changes. The Viewer stops accepting edits that
  only the reconciler on another device could apply.
- A device can always withdraw itself: leave a Team, stop receiving a Project,
  or remove itself. Withdrawal takes effect locally at once, because the device
  stops syncing that data and records the decision. It reaches the coordinator
  through a request signed with the device key, following the existing signed
  add-device invitation route. No withdrawal route exists today. Its protocol
  needs security review before implementation.

### 5. One way to remove a device, and a separate permanent block

- **Remove device** is the everyday action. Every device that refreshes from
  the coordinator drops its pairing and sync progress with the removed device.
  The Identity-to-device binding ends. The coordinator records a removal
  tombstone for the device in every group. The same machine can rejoin by
  accepting a new invitation, which is the new explicit decision that ADR 0005
  Section 5 requires.
- **Block device permanently** is for a lost or compromised machine. It is the
  existing immutable revocation of the device ID and key. The confirmation
  states that it cannot be undone and that the machine needs a new device
  identity to return.
- Remove also works for a device the coordinator does not list. In that case it
  deletes the local pairing, both cursor tables, and the binding, and tells the
  user that other devices must remove it too.
- Removing an enrollment never prevents a later block. The block accepts a
  removal tombstone as evidence.
- Coordinator Remove, Disable, and Enable leave the Viewer. The local "Remove
  device" under Advanced is replaced by the action above.
- The unreleased "Retire device" action does not ship in its current form.
- A device has one name. The Devices rename, which already writes all three
  stores, is the only rename. The other two rename actions are removed.

This amends ADR 0005 Section 5 by adding a fourth action, a removal that a new
invitation can supersede. The coordinator revocation contract needs a matching
change and a security review.

### 6. People are managed in Sharing, and deactivation revokes

- Rename, merge, and deactivate move from Advanced "People" to Sharing. They
  act on the same `actors` rows that Sharing already lists as Identities.
- Deactivating a person revokes their devices' access to every Project they
  received. The reconciler treats a deactivated Identity as having no devices
  and proceeds to revocation.
- Merging keeps its current effect on bindings, memberships, and recipients.
  A merge never blocks reconciliation for the surviving Identity.
- "Create person" is removed. Invitations and shares create pending Identities.
- The older person assignment on a pairing (`sync_peers.actor_id` and
  `claimed_local_actor`) is converted once into Identity-to-device bindings
  where the evidence is unambiguous. Other values appear as device review
  items. After conversion the columns stop affecting trust and ownership.

### 7. Teams are created in Sharing

- Sharing gains "Create Team". It creates the coordinator group underneath and
  the policy Team in one step. A coordinator group stays an implementation
  detail, as ADR 0001 Decision 2 defines it, and is no longer a prerequisite
  the user has to create under Advanced.
- "Finish setting up this Team" keeps its place in Projects and Sharing. The
  word "legacy" leaves its copy. It is the migration from a coordinator group
  to a Team, and under Principle 2 it runs automatically wherever the device
  and Project decisions are unambiguous.

### 8. One place to accept an invitation, and no new enrollment-only codes

- Sharing accepts every kind of code. A pairing payload is routed to the
  Devices pairing review. Devices gets its own pairing form and stops borrowing
  the Advanced one.
- The three creators of enrollment-only codes (Advanced Sync, Coordinator
  administration, and `codemem coordinator invitation create`) produce Team or
  add-device invitations.
- Existing enrollment-only codes remain importable from Sharing until they
  expire. Import states that the code connects the device and shares nothing.
  The import path is removed in the release after the last such code can
  expire.

This amends ADR 0001 Decision 5. Those invitations stay enrollment-only, and
no new ones are created.

### 9. Older shared data is reviewed in Projects

- Projects shows, from stored memory scopes, which Projects hold memories that
  were shared before Spaces existed.
- Assigning recipients to such a Project moves its memories, including those
  created on the same person's other devices and those under Project entries
  with no stable identity. These memories are held back from sync today, so
  moving them starts delivering them. The Project asks for one confirmation
  that states how many memories will start being delivered.
- Memories created by other people's devices cannot be moved from this device.
  They no longer keep the upgrade notice open. The notice clears once this
  device has no movable memories left.
- The separate review under Advanced is removed after Projects covers these
  cases.

### 10. What remains under Advanced

Sync diagnostics, recent attempts, per-device sync detail, and tools for
operating a self-hosted coordinator. Advanced holds no action that a core flow
needs. No message in another screen sends a user there to finish a task.

ADR 0001 Decision 6 kept `#sync` addressable until authority and migration
gates pass. The gate for removing a section of Advanced is that Decisions 5
through 9 have moved its actions and that the six flows below complete without
it.

## Flows that must complete without Advanced or the CLI

1. Add my second device.
2. Share one Project with a teammate.
3. Remove a device I no longer use, and bring it back later.
4. Stop sharing a Project with someone.
5. Join an existing Team on a new machine.
6. Upgrade an install that predates Spaces or Teams.

Creating a Team from nothing is part of flow 2. Each flow gets an end-to-end
test.

## Sequencing

All ten decisions ship in 0.50. Leaving the older model in charge of
enforcement for another release would keep the contradictions this ADR
removes. The order inside the release follows the dependencies:

1. Device removal and blocking (Decision 5), people management with revoking
   deactivation (Decision 6), Create Team (Decision 7), and one invitation
   entry (Decision 8). These do not depend on the migration.
2. Per-Project boundary migration (Decision 2), with read-only access controls
   on devices without the admin secret (Decision 4) and older shared data in
   Projects (Decision 9).
3. Retirement of the default grant and the pairing filter (Decision 3), after
   the migration has run.
4. Devices shows the Projects each device receives, including through a Team,
   from the same derivation the reconciler uses.
5. Advanced reduced to diagnostics and operator tools (Decision 10).

The migration ships through a beta cycle before a stable release. It has
upgrade tests against databases from each generation and a per-Project
rollback to the previous enforcement.

## Deferred, and why

Each item below needs a new security protocol. None of them leaves an older
model deciding who receives a Project.

- **The coordinator half of self-withdrawal.** In 0.50 a device that leaves a
  Team or stops receiving a Project stops syncing that data at once and
  records the decision locally. Removing its coordinator membership without
  the admin secret needs the signed route in Decision 4.
- **First-owner setup of a new coordinator from the Viewer.** ADR 0005 open
  decision A covers the bootstrap protocol. Until then the first device of a
  new coordinator is enrolled with the CLI, and the Viewer covers everything
  after that, including Create Team.
- **One Team roster held by the coordinator.** Team rows are stored per device
  today, so members can see different rosters. The roster on the device that
  holds the admin secret is the one that is enforced, and Sharing says so on
  other devices. Because Teams are the main unit of sharing under this ADR,
  this is the first follow-up.

## Consequences

### Positive

- What a screen shows is what sync enforces.
- Stop sharing, remove a person, and remove a device each revoke access through
  one path.
- A removed machine can come back. A compromised one cannot.
- No data moves because of a grant the user cannot see.

### Negative

- The per-Project migration changes Space memberships on live installs. It
  needs upgrade tests against databases from each generation and a rollback
  that returns a Project to its previous enforcement.
- The reversible removal changes the coordinator revocation contract and needs
  a security review.
- The release that carries this ADR is large. Other planned reliability work
  moves to later releases to make room for it.
- An install loses the ability to wall off a group of Projects from a group of
  people inside one coordinator. Separate coordinators or profiles replace it.
- Until the migration has run on an install, devices that share only a group
  default Space have no relay path, because relay does not carry that kind.
- Removing Coordinator administration actions from the Viewer leaves operators
  of self-hosted coordinators with the CLI for group and enrollment repair.

## Alternatives considered

### Hide Advanced and leave the models as they are

Rejected. The actions under Advanced are the only way to complete several core
flows, and the older models would keep gating sync where no one can see them.

### Keep Spaces as an advanced user choice

Rejected. Two ways to decide who receives a Project is the confusion this ADR
removes. Recipient edges cannot be enforced for a Project that shares a Space
with other Projects.

### Keep a work and personal wall above Projects inside one install

Rejected. A category on each Project that restricts its recipients would bring
back a second rule about who can receive what. The model people hold is Teams,
members, and Projects shared with them. Separate coordinators or profiles
already provide strict separation.

### Remove the membership mechanism and check recipients directly at sync time

Rejected. The result for users is the same as one boundary per Project. It
would require rewriting the sync protocol and its key-bound proofs, which is
the most security-sensitive code in the project.

### Make the screens truthful first and change enforcement in a later release

Rejected. Screens that say a Project's recipients are not yet enforced are
accurate and still leave the older model in charge.

### Keep permanent revocation as the only device removal

Rejected. Most removals are routine. A person who retires a laptop from a Team
and later wants it back has done nothing that warrants a permanent ban on its
key.

### One database-wide cutover

Rejected for the reason ADR 0001 gives. A migration defect would change
authorization for every Project at once.
