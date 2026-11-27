# Per-Project boundary migration design

**Status:** The approved 0.50 scope below supersedes the November 16 proposal where they differ. Only the historical fixtures and local report are in the first implementation slice.

**Date:** 2026-11-16

**Task:** `codemem-lvgba.24`, which absorbs `codemem-hksk.6` and blocks `codemem-lvgba.28`.

**Spec:** [ADR 0007](../adr/0007-one-sync-and-sharing-model-per-concept.md) (Principle 2, Decisions 2, 3, and 9) and [ADR 0001](../adr/0001-project-recipient-policy-boundaries.md) (Decision 3).

**Source read at:** commit `f6137e97e`. Every file reference below is to that commit.

## Approved 0.50 scope (November 27)

Teams, verified identities, device-to-person binding and person recipients require a coordinator. A never-coordinated install keeps basic device pairing and its existing filters. Pairing alone grants no Project memories. Rows held for legacy review and local-only rows stay local. These installs need no migration, readiness record, Team setup or identity recovery. Losing access to a configured coordinator or clearing its URL does not turn managed data into peer-only data.

1. **Historical fixtures and local report.** Inspect tagged database shapes from schema 6 through beta.4 and fresh installs. Report candidate counts, source splits and local restrictions. Do not publish readiness or change access.
2. **Authenticated readiness and serving fence.** Every affected sender and receiver must attest to the same generation with its enrolled key. Devices report applicable filters as `none`, `present` or `unknown`. A restriction keeps legacy enforcement and creates one review item. Missing evidence waits. Before conversion, stop issuing legacy-readable proofs for the group, drain in-flight refreshes and serving requests, and invalidate each device's cached source and boundary proofs before it acknowledges. Current peers must use fresh key- and generation-bound authorization on both direct and relay paths. Keep local history readable. Cutover requires tests with real old binaries against transitioned stores that had valid cached proofs, offline and after a legacy refresh attempt. Test old-to-old and both mixed-version directions. Two restored pre-cutover backups can still exchange previously disclosed history.
3. **Single-source commit and adoption.** Automate only Projects with equivalent effective admission, including for Projects left in the source. Preserve exclusions, holds and removals. Each author moves its own rows in resumable batches. Leftover rows require both source and Project admission for operations and snapshots.
4. **Rollback and review.** Require the same manager and generation for single-source rollback. Respect later revocations. People already deactivated when a hold starts retain their effective access pending review. Later deactivations revoke immediately. Split sources and Projects requiring attachment stay in review.
5. **Join retirement and rollout.** Retire the default grant per fully converted group once future joins have explicit rules. Keep the legacy reader for unconverted groups. Run report mode on the owner's devices for at least seven days, migrate one selected Project, then run enabled for at least 14 days before changing stable defaults.

Areas 2–5 require security review. Automatic filter conversion, detailed per-sender filter collection, attachment/detachment, multi-source rollback and physical removal of legacy filter storage and settings are outside 0.50.

## November 16 proposal

### What a person sees

1. They update. Sharing keeps working the whole time.
2. Once every device that shares a group of Projects has updated, each Project moves on its own. Projects shows who receives it. Nothing is asked.
3. If a device has not updated, they see "Waiting for *device* to update" and can remove that device.
4. If sharing with people would change which devices receive something, the admin gets one summary: "*Work laptop* will start receiving 12 Projects." Each line offers a choice, and one Confirm applies them all. Until then every device keeps receiving exactly what it receives today.

### How it works

Each shared Project that sits in a scope with other Projects gets a `managed_project` scope of its own. This document calls that scope the Project's boundary.

1. **Access means who is authorized.** The devices that receive a Project today are the devices the coordinator authorizes in the Project's current scope. The migration copies that set and nothing else. It does not try to reproduce which pairs of devices happen to exchange data.
2. **The copy is one coordinator transaction.** The coordinator reads the current scope's members, creates the boundary, grants it to the same devices, and stores a migration record. The coordinator computes the set itself, so no plan from a device can be stale.
3. **Each device moves its own memories.** A device can record sync operations only for memories it authored.
4. **The scope the Project came from is never changed.** No revoke, no archive, no filter change. Memories that stay there stay readable, and undoing the migration is moving memories back.
5. **Recipients take over only when they agree with today, or when the admin confirms.** The reconciler is held for a migrated Project until its plan is empty. What it would grant or revoke becomes the lines of the summary.
6. **Pairing filters are left alone.** A sender applies its filter by project name whichever scope a memory is in, so a filter keeps working after the move. Retiring filters is a later step ([Section 10](#10-decision-3-retirements)).

The first version of this design tried to preserve the exact exchange between every pair of devices. That required each device to publish its pairings and filters, a dozen kinds of question, and a rollback window. The owner chose the simpler reading on 2026-11-17. [Owner decisions](#owner-decisions) lists what changed.

## Terms

- **Project:** one canonical project identity.
- **Source scope:** the coordinator scope whose ID is stamped on the Project's memories today. Its kind is anything other than `managed_project`.
- **Boundary:** the Project's own `managed_project` scope. Its ID is `managed-project:` followed by the SHA-256 of the group ID and the canonical project identity (`packages/core/src/managed-project-scope.ts:3-11`). Every device that knows the Project computes the same ID.
- **Authorized devices of a scope:** the devices the coordinator would authorize in it at that instant: active membership at the scope's current epoch, enabled enrollment, no device revocation.
- **Admin device:** a device whose configuration holds the coordinator admin secret.
- **Author:** the device that created a memory.
- **Readiness record:** a small signed document each updated device keeps at the coordinator. [Section 1](#readiness-record) lists its contents.
- **Migration record:** the coordinator's record that a Project has moved. [Section 2](#migration-record) lists its contents.
- **Summary:** the one place an admin answers questions. [Section 4](#4-ambiguity) defines it.

## Findings that shape the design

The map in `codemem-lvgba.15` and `codemem-lvgba.14` holds. Reading the code for this design added the following.

1. **Membership is the gate an admin set.** Sync requires both devices to be authorized in the memory's scope (`packages/core/src/sync-replication.ts:2316-2335`). Pairings and filters narrow delivery further and live in each device's own database.
2. **A pairing filter follows the project name.** The sender applies it to every memory, whatever scope the memory carries, on ops and on snapshots (`sync-replication.ts:2001-2064`, `1433`, `2505-2513`). Moving a memory to a boundary does not lift a filter.
3. **Membership in a scope also gates local reads and retention.** Search reads only scopes this device is authorized in (`packages/core/src/scope-resolution.ts:302-347`). A device that loses authorization in a scope deletes the rows it received from peers there (`sync-replication.ts:2639-2641`, `2749-2863`). Revoking a member of a source scope, or archiving it, would hide and then delete data.
4. **No per-Project rollback exists.** `rolled_back` is a label in `recipient_policy_authority_states`. Sync never reads it, and nothing reverts grants, mappings, or memories.
5. **The reconciler acts on its first pass.** It revokes every current member that the local recipient tables do not derive, including a device with no Identity binding (`packages/core/src/recipient-policy-reconciler.ts:419-430`). Pointed at a new boundary with no check, it could remove devices.
6. **Sharing a `managed_project` scope pairs devices automatically.** Coordinator policy trust pins a discovered device once both devices are members of one `managed_project` scope (`packages/core/src/coordinator-runtime.ts:506-695`). Two authorized devices that never paired start syncing once they share a boundary.
7. **Moving a memory with `MemoryStore.reassignMemoryScope` deletes nothing on other devices.** It records a `delete` in the old scope and an `upsert` in the new one (`packages/core/src/store.ts:2035-2126`). The sender then skips the `delete`, because its own row now carries the new scope (`sync-replication.ts:2361-2371`). A device in both scopes restamps its copy when the `upsert` arrives. The two other functions that move memories delete or tombstone copies on peers, so the migration does not use them.
8. **A scoped snapshot can duplicate a memory.** The first pull of a scope from a peer applies a snapshot with a plain insert (`packages/core/src/sync-bootstrap.ts:357-429`), and the merge path looks for an existing copy only inside the same scope (`sync-bootstrap.ts:608-678`). A device that holds a memory under the source scope and then pulls the boundary gets a second row. This comes from reading the code. No test covers it.
9. **The default grant has one caller.** Only the Viewer's join approval grants a group's default scope, and only when a preference in that device's own database is on (`packages/viewer-server/src/routes/sync.ts:559-592`).
10. **Scope kind is free text at the coordinator.** Only `team_default` and `managed_project` have dedicated creators. Every coordinator scope that is not `managed_project` and not `personal:<actor>` is a possible source scope. Only a default scope grants its creator. A scope made by hand grants nobody (`routes/sync.ts:8284-8320`).
11. **Project mappings are per device and are not replicated.** A device learns a new mapping only when something on that device writes it.
12. **A device cannot know whether an offline device has updated.** Presence expires, and `sync_peers.runtime_version` is stored only for stable releases and only for direct peers.

## Prerequisites

P1 to P3 must land with tests before the migration can be enabled anywhere. P4 and P5 decide how often the summary appears and are needed before the migration is on by default.

- **P1. Snapshot apply must reconcile by `import_key` across scopes.** The rule below is the one in the code (`packages/core/src/snapshot-cross-scope-reconcile.ts`). It differs from the first wording of this section in the ways the [review record](#p1-implementation-review-2026-11-18) lists.
  - **Where it applies.** Only to a copy this device holds and can still read, which excludes private copies and tombstones, in a scope a migration record covers for the item's scope. A `committed` record covers a move from its source scopes into its boundary. A `rolled_back` record covers the move back. Where no record covers the copy, the snapshot is applied exactly as before, which can leave two rows. An existing share depends on that: it leaves a tombstone under the older scope and delivers the live copy by snapshot.
  - **Replace, add, or hold back.** The item replaces the held copy only when its clock is newer and the serving peer could have rewritten the copy anyway: it is a proven member of the copy's scope, or it created the memory, by a source record this device verified when the memory arrived. When that does not hold and this device has left the copy's scope, the item is added and the copy stays, as before this change. A device that never held the copy would be given the item, and leaving a scope can be temporary, so only ordinary cleanup may delete the copy. In every other case the held copy stays and the item is not added.
  - **Proven** means the key-bound check the scoped protocol already applies to the requested scope (`packages/core/src/sync-scope-protocol.ts:109-129`), run against the peer's pinned key. A bare membership row is not enough. Missing proof for this device's own membership is not treated as having left. "Left" means the coordinator no longer lists the membership, or lists it as revoked, behind the scope's epoch, or in an archived scope, and the copy came from a peer.
  - **A copy already in the item's scope** is still brought up to date when the copy in the other scope is kept, on a first pull and on a merge.
  - **A `detached` record covers nothing yet.** The boundary held memories before the attach, and telling those apart from what the attach moved in needs a record of what this device itself moved, which it does not keep. Until the attach change adds one, a snapshot of the older scope is applied as before.
  - Requiring the serving peer to be a proven member of the copy's scope stops a device that was added to the boundary later from pulling another Project's memories out of that scope. A peer proven in both scopes can already replace or rewrite a copy in the older scope through an ordinary snapshot, so the rule gives it nothing new. The cost is a delay in one case, described in [Section 7](#7-multi-device-ordering).
- **P2. The reconciler needs a hold for migrated Projects.** For a Project with a migration record, the reconciler computes its plan and issues no grant, revoke, or deny overlay until one pass has seen an empty plan or the admin has confirmed the summary. The hold is stored in the migration's own table under the boundary ID. The reconciler checks it after it has resolved the Project's boundary and before it writes anything, including the deny overlays it stages ahead of a revoke (`recipient-policy-reconciler.ts:1496-1513`). Existing code can replace a Project's authority row when it merges an alias (`recipient-policy-reconciler.ts:1857-1879`), which is why the hold does not live on that row.
- **P3. The coordinator needs additive resources:** readiness records, migration records, and four operations that each run as one transaction (commit, attach, roll back, and take over). It also checks every later membership change on a boundary that has a migration record: the request must carry the record's current generation and come from the device the record names as managing the Project, and the record must be `committed`. The check runs in the same transaction as the membership write. A request without a generation is refused, which is what an older admin device sends. The client detects all of this through a capability. A coordinator without it makes every Project wait.
- **P4. Device-to-Identity bindings must exist for older pairings.** ADR 0007 Decision 6 converts `sync_peers.actor_id` and `claimed_local_actor` into bindings (`codemem-lvgba.27`). Without it, the summary asks whose device each one is.
- **P5. An admin device must be able to manage a Project it receives and has never opened.** It needs the Project's identity to record recipients. A boundary member learns it from a peer over the existing sync channel and checks it against the boundary ID, which is a hash of that identity. Without P5 such a Project still moves with the same devices, but it gets no Team recipient, so a person who joins the Team later does not receive it ([Section 10](#10-decision-3-retirements)).

## 1. Inventory

### Where a Project's memories can sit

A memory's scope is stamped when it is written, from the writing device's own mappings (`packages/core/src/scope-resolution.ts:224-277`). An exact mapping, a mapping written by legacy Team setup, a pattern mapping, and the legacy shared review reassign route can all put a Project in the scopes below.

| Scope the memories carry | How a device becomes authorized | Shared today | Migration |
| --- | --- | --- | --- |
| `team_default` (`team:<group>:default`) | The creating device is granted when the group is created. A device is granted when the Viewer approves its join request and the default grant preference is on. An admin can also grant it by hand. | Yes | Source scope |
| `team` | Manual grant. Legacy Team setup maps Projects here and writes Team recipient edges that nothing enforces. | Yes. The only legacy kind that relay carries. | Source scope |
| `org`, `client`, `user`, or any other kind | Manual grant | Yes, over direct sync only | Source scope |
| `managed_project` | Share provisioning, the reconciler, or a manual grant | Yes | Already a boundary. Left alone. |
| `personal:<actor>` | Manual grant | Private memories only | Left alone |
| `local-default`, `legacy-shared-review`, or no scope | Nobody | No. Sync withholds these. | Left alone. ADR 0007 Decision 9 and `codemem-lvgba.26` cover them. |
| A scope with authority `manual` or `invite` | No writer exists in current code | Not determined | Left alone and counted in the report stage |

### What grants access, and how the migration carries it

| Mechanism | Stored | What the migration does |
| --- | --- | --- |
| Coordinator membership in the source scope | Coordinator | Copied exactly into the boundary. This is "the devices that can receive this Project now". |
| Default grant on join | A preference on the approving device. The grant itself is an ordinary membership. | Devices that joined through it are members, so they are copied. Where the grant was on, the Project gets a Team recipient, so later members still receive it. The grant then stops ([Section 10](#10-decision-3-retirements)). |
| Pairing with a pinned key | Each device's `sync_peers` | Unchanged. Devices that share a boundary and never paired are paired by policy trust (Finding 6). The owner accepted that they connect. |
| Pairing filter and global filter | The sender's `sync_peers` row or configuration | Unchanged and still in force (Finding 2). |
| Group filter template | One device's preferences | Unchanged. It only seeds a filter when a pairing is created. |
| Visibility | The memory | Unchanged. Private memories move with the Project and are still not delivered. |
| Relay | Scope kind | `team_default`, `org`, and `client` have no relay path today and gain one as boundaries. Transport only. |

### Readiness record

An updated device keeps one record per coordinator group at the coordinator, signed with its device key. It sends the record in a request of its own, after its presence and again when the contents change, because a presence request is limited to 64 KiB and a record can be larger. The coordinator keeps the last one. It discards the record when the device posts presence without the migration feature, which is what a downgraded device does.

```json
{
  "version": 1,
  "device_id": "…",
  "group_id": "…",
  "sequence": 12,
  "projects": [
    {
      "source_scope_id": "team:g1:default",
      "boundary_scope_id": "managed-project:…",
      "state": "waiting",
      "own_rows_in_source": 412,
      "own_rows_in_boundary": 0
    }
  ]
}
```

- `projects` lists every Project this device maps to a source scope, or holds its own memories in one. The boundary ID stands in for the Project, so the coordinator stores a hash and no repository name.
- `state` is `waiting`, `adopted`, or `rolled_back`.

The record tells the coordinator two things: this device runs code that handles a boundary correctly, and these are the boundaries its Projects need. It carries no pairing, no filter, and no project name.

The coordinator accepts an entry only when the device is authorized in the named source scope and the boundary ID has the `managed-project:` form. A device can name a boundary for a Project it does not have. The result is an empty boundary with the source scope's own members, which no device adopts and which changes nobody's access.

What the coordinator stores (`packages/core/src/coordinator-boundary-readiness.ts`, coordinator migration `0050`):

- One record per device and group, replaced as a whole. A record replaces the stored one only when its `sequence` is higher. Otherwise the coordinator answers with the stored sequence, so a device that lost its counter can move past it.
- A record with no Projects is valid. It says the device runs code that handles a boundary.
- An entry that fails the two checks above is left out and named in the answer. The rest of the record is stored.
- A device with no enabled enrollment in the group is refused.
- One Project can appear once per source scope.
- A record's Projects take at most 256 KiB as compact JSON, about 1,300 Projects and fewer with long IDs, and name at most 64 source scopes. The store and the request use the same limits, so a record the device can build always fits one request. A device with more Projects sends the ones that fit and the number it left out in `omitted_projects`, which the coordinator stores.
- A coordinator that has not applied migration `0050` answers that readiness records are unavailable, and every Project waits.

**What a record does not show.** A record can leave out Projects the device holds. The coordinator stores three facts about that, and the commit must use them. They are prerequisites of the commit change, with tests 63 to 67.

- **A record that is not complete.** The record is not complete when the device left Projects out to fit the limit, or when an entry had a malformed boundary ID, which a correct build never sends. Such a record shows that the device runs the migration code and nothing about what it holds. It must never be read as "the device does not hold the Projects it left out". For a commit, a device whose record is not complete is treated like a device with no record: every Project of each source scope that device is authorized in waits. Nothing in those scopes moves in the meantime, so a device over the limit keeps them waiting until records can be sent in pages. An admin device can see the count, and nobody's access changes. Attach only needs to know that the device runs the code, so it accepts a record that is not complete.
- **A source scope the device was refused for.** An entry is left out when the device is not authorized in its source scope at arrival, and the coordinator stores those scope IDs with the record. If the device is authorized in one of them at the commit, the record no longer shows what it holds there, and the commit treats it as not complete. A device that stays out of that scope blocks nothing.
- **A read that could not run is not a refusal.** When the coordinator cannot read a scope's authorization, it stores nothing and answers that readiness is unavailable. The device sends the record again.
- **Presence at the commit.** A record sent just before a downgrade can arrive after the downgraded build's presence discarded the earlier one. The commit therefore counts a record only when the device's stored presence lists the migration feature.

The check that a Project is not also shared in a second older setup ([Two cases where a Project does not move by itself](#two-cases-where-a-project-does-not-move-by-itself)) covers devices authorized in the source scope, and devices outside it that have a complete record. A device outside the source scope with no record, or with one that is not complete, is not seen, as before this rule.

The device is checked against the source scope when the record arrives. It can leave that scope afterwards, and its record stays until its next one. The commit therefore counts only records of devices that are authorized in the source scope at the moment of the commit.

## 2. The per-Project procedure

### Roles

- **An admin device** asks the coordinator to commit. Any admin device in the group can do it. It does not need to hold the Project, because the request names only a source scope and a boundary ID from a readiness record.
- **Every device authorized in the boundary** adopts the committed record. The authors among them move their own memories.
- **One admin device that knows the Project** records recipients and runs the reconciler for it. The record names it, and the coordinator accepts membership changes for the boundary only from it (P3).

### Additive storage

- Local table `project_boundary_migrations`, keyed by boundary ID. The snapshot change adds it with the columns that change reads: source scope ID, additional source scope IDs, state, and generation. The hold change adds the hold columns at version 23 (`packages/core/src/project-boundary-migration-hold.ts`): the generation the hold was cleared at, why and when it was cleared, and a list of devices described in [Still open](#still-open), item 8. The hold itself is not a stored flag. A Project with a record is held unless the hold was cleared at the record's current generation, so a newer record sets the hold again with no second write. A row or column the code cannot read leaves the Project held. Later changes add the rest as columns: canonical project identity, group, the mapping rows it replaced, counters, lease columns, and a safe error code.
- Local table `project_device_exclusions`, keyed by canonical project identity and device ID. It holds the "Keep off" choices in [Section 4](#4-ambiguity). The derivation that the reconciler and the Viewer share subtracts these devices.
- New values in existing free-text columns: `project_scope_mappings.source = 'boundary_migration'` and `project_recipients.provenance = 'boundary_migration'`.
- Coordinator tables for readiness records and migration records.
- `SCHEMA_VERSION` moves from 21 to 22 with the snapshot change and to 23 with the hold columns. The additive shim checks for the table and those columns on every open and writes only when one is missing (`packages/core/src/db.ts`). Each later table or column takes the next version. No column or table is dropped, and no existing row is rewritten by the schema step.

### Migration record

The coordinator stores one record per boundary: state (`committed`, `rolled_back`, or `detached`), generation, source scope ID, boundary ID, the devices granted, the committing device, the admin device that manages recipients, and the recipients chosen at migration. After the admin's answer in one [rare case](#two-cases-where-a-project-does-not-move-by-itself), it also names a second older setup whose memories move. A device-signed request reads it.

**Commit** is an admin request that names a group, a source scope, a boundary ID, and the generation it expects. The coordinator applies it in one transaction, and only when all of these are true at that instant:

- No record exists for the boundary, or the record is `rolled_back` at the expected generation.
- Every authorized device of the source scope has a readiness record.
- At least one of those readiness records lists the boundary under that source scope, and no readiness record lists it under another source scope.
- The boundary scope does not exist, or it belongs to the rolled-back record.

In the same transaction the coordinator creates the boundary if needed, makes its active members exactly the source scope's authorized devices with the roles they hold there, and stores the record as `committed` with a new generation. A repeated request returns the stored record. A failed condition returns `409` with the condition named, and nothing is written.

A boundary that already exists without a migration record is never reused, even when it has no active member. Devices can still hold memories stamped with it from an earlier share, and granting it again would bring those back. That case goes to the summary.

The device sends no device list. The coordinator reads the members and writes the copy in one step, so a request that arrives late copies whatever is true when it arrives, or finds the record already there.

**Roll back** is described in [Section 6](#6-per-project-rollback).

### Choosing recipients

After the commit, an admin device that knows the Project records recipient edges for it. It answers two questions separately.

**Who receives the Project now.** It tries three candidates in order and takes the first whose derived devices equal the boundary's members, using `deriveRecipientPolicyEffectiveDevices`, the derivation the reconciler uses.

1. The Project's existing active edges. Legacy Team setup wrote these for its Projects.
2. One Team edge, when the Project came from a default scope with the default grant on and exactly one active policy Team is linked to the group.
3. One direct edge per Identity bound to a device in the boundary.

If none matches exactly, it keeps the closest candidate in that order. The difference becomes lines in the summary, and the hold in P2 stops the reconciler from acting on it.

**Whether people who join later receive it.** Where the Project came from the group's `team_default` scope and the default grant is on for that group on this device, or was on until this migration stopped it, an approved joiner received the Project. After the move, a membership in the default scope no longer delivers it. Only a Team recipient does. So in that case the Project must end up with a Team edge, whichever candidate matched above.

- If exactly one active policy Team is linked to the group and the edges do not name it, the device adds the Team edge. When every device of the Team is already in the boundary, this changes nobody's access and nothing is asked. Otherwise the summary shows the Team's other devices as "will start receiving" lines.
- If no policy Team is linked to the group, the summary shows the line about new members in [Section 4](#the-summary).

In a scope that was granted by hand, nobody received a Project by joining, and direct edges per person carry today's access.

The admin device that records the edges writes itself into the record as the device that manages the Project's recipients, with a compare-and-set. Other admin devices show the recipients read-only until the coordinator holds one roster (`codemem-lvgba.35`).

Any admin device can take over. Projects on another admin device shows *Managed from device* with the action **Manage from this device**. **Take over** is one coordinator transaction that names the new managing device and advances the record's generation. Requests from the previous device then carry an old generation and are refused. The new device sets the hold again and records recipients as above, from its own tables. Its "Keep off" list starts empty, so a device that was kept off shows up as a "will start receiving" line with the default Keep off. Nothing changes until the admin confirms, and confirming the defaults keeps the boundary's members as they are. This is also how a Project recovers when the managing device is lost or removed.

### Order of writes

| # | Step | Where | Atomic unit | A crash after it leaves | Resume |
| --- | --- | --- | --- | --- | --- |
| 1 | Commit | Coordinator | One transaction: conditions, boundary, memberships, record | A committed record that no device has applied yet. Every memory is still in the source scope and is delivered as before. | Any device reads the record and continues |
| 2 | Record recipients and the reconciler hold | Local, on an admin device that knows the Project | One `BEGIN IMMEDIATE` transaction | Recipients recorded and held | Nothing to redo |
| 3 | Adopt: save the device's exact mapping rows for the Project and replace them with one mapping to the boundary | Local, each device | One `BEGIN IMMEDIATE` transaction | New memories of the Project are stamped with the boundary. Older ones still carry the source scope. | Go to step 4 |
| 4 | Move: restamp this device's own memories of the Project from the source scope to the boundary | Local, each author | One transaction per memory, in batches of 200 with a yield between batches | Some memories under the boundary and some under the source scope. The same devices are authorized in both. | Select what still carries the source scope and continue |
| 5 | Update the readiness record | Coordinator | One upsert | A stale record | Send it again |

Notes:

- **Step 1** is the only step that changes anything at the coordinator, and it changes nothing about who is authorized for what.
- **Step 3.** A device adopts when it reads a committed record for a boundary it computes for one of its own Projects, and its membership cache shows it authorized there. It replaces the mapping only if it maps the Project to the record's source scope today. A device that stopped mapping the Project keeps it unmapped. Pattern mappings are untouched, because an exact mapping outranks a pattern. An admin device writes the reconciler hold in the same transaction as the mapping.
- **Step 4** uses the delete-then-upsert behavior of `MemoryStore.reassignMemoryScope`, restricted to memories this device authored that carry the record's source scope. No copy is deleted on any peer (Finding 7). The move waits while the device's sync state needs attention, as that function already requires. Private memories move with the rest and are still not delivered.
- **Nothing in `local-default`, `legacy-shared-review`, or any other scope moves.**

### When the reconciler takes over

Step 2 sets the hold from P2. While it is set, the reconciler derives, snapshots, and computes its plan, and issues nothing.

- An empty plan clears the hold. The existing `eligible` and `active` transitions then apply. This is the normal case, and nobody is asked anything.
- A plan with grants or revokes becomes lines in the summary. The boundary keeps the copied members until the admin confirms.
- A recipient change the user makes in Projects clears the hold for that Project. The change is the new intent.

A cleared hold is tied to the record's generation. When a device reads a record with a different generation or state, the hold is set again. The coordinator enforces the same thing from its side: it refuses a membership change that carries an older generation or arrives after a rollback (P3). A reconciler that has not yet read the new record therefore cannot act on what it believed before.

## 3. Proof of no widening

### The invariant

> At commit, the devices authorized in the boundary are exactly the devices authorized in the source scope.

The coordinator reads one set and writes the other in the same transaction, so there is no interval in which they can differ and no device-supplied list that can be wrong.

From that, for every memory that moves:

- It was deliverable to the source scope's authorized devices, subject to pairing and to each sender's filter. It is now deliverable to the boundary's authorized devices, which are the same devices, subject to pairing and to the same filters (Finding 2).
- No device loses it. Every device that held a copy is in the boundary and restamps its copy. The source scope is untouched, so memories that do not move stay readable and deliverable as before.

### The checks

| When | Check | On failure |
| --- | --- | --- |
| Commit, inside the coordinator transaction | The conditions in [Migration record](#migration-record). After the transaction the boundary's active members equal the source scope's authorized devices. | Nothing is written |
| Adopt, on each device | The record is committed, the boundary ID is one the device computes itself, and the device is authorized in the boundary | The device changes nothing and reads again on its next refresh |
| Reconciler hold | The reconciler's plan is empty | Nothing is issued. The plan becomes summary lines. |
| After every device has adopted | No `import_key` has two rows. Each device's count of the Project's memories equals its count before. | Recorded as a migration error for that Project and shown in diagnostics. [Rollback](#6-per-project-rollback) is offered. |

Two properties are asserted in tests against a log of coordinator calls:

- The migration issues no grant, revoke, epoch change, status change, or filter write on any source scope.
- Only memories that already carry the record's source scope move.

### Changes the owner accepted

These are differences from today that the migration causes or allows. Each was accepted on 2026-11-17.

- **Two authorized devices that never paired start syncing.** They were approved for the same Projects and each held part of them. Once they share a boundary they are paired, and they exchange everything both are authorized for.
- **A filter can hide behind the recipient list.** A device that an older filter blocks is a boundary member and appears as receiving the Project. It still receives nothing from the devices that block it. The device that holds the filter shows it in Devices as an older setting until filters are retired.
- **Confirmed summary lines change access.** That is the admin's decision, and each line states its effect first.

## 4. Ambiguity

### The current state is ambiguous when people and devices disagree

After the move, the boundary holds exactly today's devices. The new model shares a Project with people and Teams, and each person's devices receive it. Those two can differ. A person can have a device that was never in the old scope. A device in the old scope can belong to nobody the recipients name.

The reconciler's plan for a migrated Project is the list of those differences: the devices it would grant and the devices it would revoke. The summary is that list, grouped by device. The Project is not held back. It has already moved, and it keeps today's devices until the admin answers.

### The summary

One summary exists per install, on an admin device, in Projects. It gains lines as groups of Projects finish moving. A line that has been confirmed returns only if the facts behind it change.

| Line | Shown when | Choices | Default |
| --- | --- | --- | --- |
| *Device* will start receiving *N* Projects | A recipient's device is not in the boundary. This is the case of one person whose devices sat in different older setups. | **Include** grants the device. **Keep off** records that this device does not receive these Projects, and it stays out of the boundary. | Keep off |
| *Device* receives *N* Projects and belongs to nobody | A device in the boundary has no person | **Pick a person**, or name a new one. **Remove device.** | No default. The line stays until answered. |
| *Person* is not listed for *N* Projects their devices receive | The Project's recipients do not name a person whose device is in the boundary | **Keep sharing with *person*** adds them as a recipient. **Stop** removes their devices. | Keep sharing |
| *Device* is listed under two people | The coordinator names one person for a device and this device's records name another | **It belongs to *person*,** one choice per person. **Remove device.** | No default |
| New members of *group* received *N* Projects automatically, and will not after this update | The Projects came from a default scope with the default grant on, and no Team is linked to the group | **Create a Team for this group and share these Projects with it,** which is the Create Team action from ADR 0007 Decision 7. **New members get nothing until I share with them.** | No default |
| *Person* was deactivated and their devices receive *N* Projects | A deactivated person's device is in the boundary | **Stop** removes their devices, as ADR 0007 Decision 6 intends. **Reactivate *person*.** | No default |

Rules for every line:

- It states the effect before Confirm: which devices start, which stop, and how many memories.
- The summary shows the result of all selected choices together. A choice can bring in new differences. Keeping a person adds every device of that person, so their devices outside the boundary appear at once as "will start receiving" lines with the default Keep off. Confirm is enabled only when the devices the summary shows are exactly what the reconciler will derive from the answers.
- Confirm with every default selected changes no device's access. A line with no default must be answered. Until it is, the Projects it covers stay held with today's devices.
- One Confirm applies all answered lines. A line can be expanded to answer per Project.
- An answer is stored in `recipient_policy_review_resolutions` with the line's fingerprint and the deciding Identity and device, as ADR 0001 Decision 4 requires. The hold then clears for the Projects it covers, and the reconciler applies exactly what the line said.
- No choice sends the user to Advanced, the CLI, or diagnostics.
- A device that is not the managing admin device shows the recipients read-only and says which device has changes to confirm. An admin device also offers **Manage from this device**.

"Keep off" is a recorded choice that one device does not receive one Project, although its person does. It is what ADR 0007 Decision 3 calls the absence of a device from a Project's boundary, and what Decision 4 calls a device that stops receiving a Project. Projects shows it on the recipient's row, and the admin can change it there later.

### Two cases where a Project does not move by itself

Both are rare, and both appear as lines in the same summary. Until answered, the Project stays where it is and syncs as before.

When the admin picks one setup in the first case, the commit request names that setup as the source scope, lists the other setup as an additional source, and carries the fingerprint of the stored answer. The coordinator then applies the commit's conditions with one difference: every other source scope that a readiness record lists for the boundary must be named in the request. It copies the devices of the chosen setup only, and the record names both setups so that devices in the boundary move their memories from both. A device that is only in the other setup is not in the boundary and cannot move anything into it. Its own memories stay in that setup and keep reaching that setup's devices as before. It keeps the copies it has and receives nothing new from the devices that moved. The line states both facts and names those devices. To bring such a device in, the admin adds its person as a recipient.

When the admin picks **Move the rest** in the second case, the admin device sends an **attach** request with the boundary ID, the source scope, and the fingerprint of the stored answer. The coordinator applies it only when every device that is authorized in both the boundary and the source scope has a readiness record. Such a device holds copies under the source scope, and on older code it would get a second row for each memory when it pulls the boundary (Finding 8). In one transaction the coordinator then stores a `committed` record for the existing boundary, names the requesting device as the one that manages it, and changes no membership. The hold is set. Devices that are authorized in the boundary and keep the Project in the source scope then adopt and move their own memories, as in steps 3 and 4. A device that is only in the source scope is not in the boundary. Its own memories stay where they are, and it receives nothing new from the devices that moved. Rolling back an attached record is different from rolling back a copied one, because the boundary was shared and managed before the attach and has to stay that way. The transaction revokes nobody and stores the record as `detached` with a new generation. Each device moves back only the memories it moved in, and restores its mapping. For a `detached` record the coordinator accepts membership changes that carry no generation, exactly as for a boundary with no record, and refuses any that carry one. Recipients of the boundary are then managed as they were before the attach, and a late request from the attach is refused. A later attach names the detached record's generation.

| Line | Shown when | Choices |
| --- | --- | --- |
| *Project* is shared in two older setups | Devices map the same Project to different source scopes | **Share with only *one list*,** one choice per setup. It names the devices that stop receiving the other part and the devices whose own memories stay behind in the other setup, or says that no device changes when both setups have the same devices. **Leave it as it is.** |
| *Project* is already shared with *people*, and *N* devices hold part of it in an older setup | The Project's boundary already exists without a migration record, with or without members, and some device still keeps the Project in a source scope | **Move the rest to the people it is shared with,** which names the devices that start receiving those memories, the devices that stop, and the devices whose own memories stay behind. **Leave the older part where it is.** |

### Waiting

These states ask nothing and clear without a decision.

| Shown as | Clears when | What the user can do |
| --- | --- | --- |
| Waiting for *device* to update | That device publishes a readiness record | Update that device. On an admin device: Remove device. |
| Waiting for a device that administers this Team | Any admin device in the group runs its maintenance pass | Open codemem on that device |
| Waiting for the coordinator to be updated | The coordinator advertises the capability | Self-hosted: update the coordinator |
| Waiting for a share to finish | No share operation or Team setup draft is in flight for the Project | Nothing. It finishes or shows its own error. |
| Sync needs attention | The existing sync attention state clears | Follow the sync notice |

## 5. Who runs it

### The admin device

The migration runs in the sync daemon's maintenance pass, after the coordinator refresh, next to recipient reconciliation (`packages/viewer-server/src/application/coordinator-maintenance.ts`). For each boundary that a readiness record lists and that has no migration record at all, the admin device sends a commit. A Project that was rolled back is never picked up by this pass. It moves again only when an admin chooses **Move this Project again** in Projects, or runs `codemem sync migration run`. It runs when the rollout flag is `on`, the device holds the admin secret, and the coordinator advertises the capability.

An admin device that is not a member of a source scope can still commit for it. It becomes no member of the boundary and receives nothing. The Project moves with the same devices, and its recipients stay as recorded until an admin device that receives the Project manages them.

### Every other device

A device without the admin secret publishes its readiness record, reads migration records when it refreshes its membership cache, adopts, and moves its own memories. Until a Project is committed it syncs exactly as before.

- Projects shows each Project's recipients read-only and says that an administrator's device applies changes, as ADR 0007 Decision 4 requires.
- While it moves memories, Projects shows *Finishing on this device*.

### Devices on older versions

| Situation | Behavior |
| --- | --- |
| An older device is authorized in a source scope | It has no readiness record. Every Project in that scope waits, and nothing about its sync changes. The admin device names it and offers Remove device from ADR 0007 Decision 5. |
| An older admin device | It still grants the default scope on join and can edit scopes by hand. The coordinator copies whatever the members are at the commit, including such a change. A change to a source scope after the commit does not reach the migrated Project. In 0.50 the Viewer stops offering manual membership edits on a source scope once one of its Projects has committed. |
| An older device added to a boundary later by the reconciler | It receives the Project as it would any shared Project. It holds no copy under the source scope, so Finding 8 does not apply. |
| A migrated device downgraded to 0.49 | Its mapping to the boundary is an ordinary row and keeps working. Its readiness record is discarded, so nothing new commits for its scopes until it updates again. |
| An older coordinator | The capability is absent. Nothing runs and every Project waits. A self-hosted coordinator is updated before its clients. |
| A device paired outside any coordinator group | Unaffected. It receives nothing from coordinator scopes today. |

An older device never gains access. The commit copies a scope only when every authorized device in it has a readiness record, and a readiness record requires the new code.

## 6. Per-Project rollback

Rollback returns one Project to its source scope. An admin device starts it from Projects, or from the CLI during the beta. It stays available for as long as the source scope exists.

**Roll back** is one coordinator transaction. It applies when the record is `committed` at the expected generation. It revokes every boundary member that is not authorized in the source scope, and stores the record as `rolled_back` with a new generation. From that transaction on, the coordinator refuses every membership change on the boundary (P3). The reconciler on the managing device may not have read the record yet and may still want to grant a device that the rollback removed. Its request carries the old generation and is refused.

Each device that adopted then acts when it reads the record:

1. It restores the mapping rows it saved and removes its mapping to the boundary, in one transaction. An admin device marks its migration row so the reconciler skips the Project.
2. It moves its own memories that carry the boundary back, with the same function and batching as the forward move. A memory returns to the scope it came from, which the forward move recorded on it. A memory written since the migration goes to the scope the restored mapping gives. Other devices restamp their copies as the updates arrive, and P1 lets a snapshot do the same.
3. It updates its readiness record.

The preview names what changes before the admin confirms: each device that will stop receiving the Project, and each device that is authorized in the source scope and was removed from the boundary since the migration, which will receive the Project again.

Boundary members that are authorized in the source scope keep their boundary membership. A device deletes peer-authored rows in a scope it loses (Finding 3), and a memory whose author is offline can stay stamped with the boundary on other devices for a while. Keeping the memberships keeps those copies readable. The members that remain are all authorized in the source scope, so they receive nothing they would not receive there.

### What rollback cannot undo

- Each memory's revision is higher, and the op log holds the moves. Content is unchanged.
- The boundary scope, the record, and the memberships of devices that are in the source scope stay at the coordinator. A later migration of the same Project commits a new generation on top of them. That happens only when an admin asks for it ([Section 5](#the-admin-device)).
- A device that the admin included after the migration received data. Its copies are deleted when its membership ends, if it cooperates. A device that never syncs again keeps them.
- Devices that policy trust paired because they shared the boundary stay paired while they share any other boundary. A pairing that the user made by hand is never removed.
- "Keep off" choices and recipient edits stay recorded and have no effect while the Project is rolled back.

## 7. Multi-device ordering

**Two admin devices.** Both send the same commit. The coordinator applies the first and returns the stored record to the second. Neither sends a device list, so they cannot disagree about the members. The first admin device that knows the Project becomes the one that manages its recipients, and the other shows them read-only.

**The managing admin device is lost.** Until another admin device takes over, the boundary keeps its members and nothing is granted or revoked. A recipient's new device is not added during that time. Another admin device takes over from Projects, as described under [Choosing recipients](#choosing-recipients).

**A member that updated and went offline.** The commit proceeds, because its readiness record is at the coordinator. Its memories stay in the source scope until it returns. They are delivered then exactly as they would have been, since every device authorized in the source scope is also in the boundary. On return it adopts and moves them.

**A member that has not updated.** Every Project in its scope waits. Other scopes are unaffected. The admin device shows the device's name and last contact and offers Remove device.

**A member that updates weeks later.** It publishes its readiness record on first start, and the admin device's next pass commits the waiting Projects. Nothing was migrated for that scope in the meantime, so the device sees one transition.

**A device that joins or leaves the source scope before the commit.** The coordinator copies the members as they are at the commit. A device that joined and has not updated makes the scope wait.

**A device that joins the source scope after the commit.** It receives whatever is still stamped with that scope and nothing that has moved. It receives a migrated Project only as a recipient.

**An author that is offline when another device first pulls the boundary.** The pulling device can hold an older copy under the source scope while another device holds the moved one. P1 lets the snapshot replace the older copy when the serving device is a proven member of the older setup. When the serving device was added to the Project later, the pulling device keeps its older copy until it reaches any device from the older setup. The author counts after it has left the older setup only where the pulling device verified, when the memory arrived, which device created it. Every device that could deliver the update before the migration still can, so no delivery that existed is lost. The newer device is an extra source that this one memory cannot use yet.

**Authors that no longer exist.** Memories a retired device authored stay under the source scope on every device that holds them. Nobody can move them. They stay readable because the source scope is never revoked or archived. A device that becomes a recipient of the Project later does not receive them.

## 8. Upgrade test matrix

### How fixtures are built

No current test opens a database in an older shape. The existing pattern bootstraps the current schema and lowers `user_version` (`packages/core/src/db.test.ts:132-155`). The fixtures here create each generation's tables from DDL recorded at a tagged release, insert rows, and open the file with the current `MemoryStore` so the additive shim runs. `MIN_COMPATIBLE_SCHEMA` is 6, so the oldest fixture has the v0.19.0 shape.

Each fixture is a set of synthetic stores in a temporary directory. Each store has its own database, configuration file, and key directory. Fixtures that touch a coordinator use a real SQLite coordinator store behind the signed app, as `linkedLegacySetupFixture` does, and run again against D1. No test opens a real database, configuration, or running service.

### How access is measured

Each test drives `syncOnce` between the stores, as `packages/core/src/linked-legacy-setup-sync.test.ts` does. It records, per device and Project, the set of `import_key` values held. It runs the migration to quiescence, writes one new memory per author, syncs again, and compares. The scoped sync postmortem requires this kind of end-to-end assertion (`docs/plans/2026-05-25-scoped-sync-postmortem.md`).

Every fixture asserts the same things after the migration: the boundary's members equal the source scope's authorized devices, no device outside that set holds a new key, no `import_key` has two rows, each device's search results for the Project are unchanged, and the coordinator call log shows no write to a source scope.

### Fixtures

| Fixture | Generation and shape | Access before | Expected after |
| --- | --- | --- | --- |
| `g1-peer-sync` | Original peer sync, schema 6. Two paired devices, a pairing filter with an include list, shared memories with no scope, no coordinator. | The backfill stamps shared memories `legacy-shared-review`. Nothing syncs. | Identical. No readiness record, no migration record, no coordinator call. The filter is untouched. |
| `g2-coordinator-group` | Coordinator groups, v0.29.0. Three enrolled devices, a group filter template, discovered pairings, no scope tables. | Nothing syncs, because no memory carries a coordinator scope. | Identical. Each device publishes a readiness record with no Projects. |
| `g3-default-scope-one-person` | Spaces, v0.30.0. One person, three devices, a `team_default` scope with the default grant on, no policy Team, two Projects, pairings marked as the same person. | Each device receives both Projects. | Two boundaries with the same three devices, all memories moved. With P4, one direct recipient and no summary. Without P4, the summary asks whose device each one is, and access is unchanged. |
| `g3-two-older-setups` | Spaces. One person, three devices, two scopes made by hand. One scope holds a laptop and a desktop. The other holds the desktop and a home machine. Several Projects in each. | Each Project reaches the two devices of its scope. | One boundary per Project with the same two devices. The summary has two lines, one per device that would start receiving. Confirm with defaults changes no access and records "Keep off". Include adds the device. |
| `g3-team-scope-filter` | Spaces. Two people with two devices each, kind `team`, a pattern mapping that covers three Projects. One device's filter blocks one Project for one device of the other person. | Two Projects reach all four devices. The filtered Project reaches the fourth device from every sender except the one that blocks it. | Three boundaries with four devices. The filter is untouched. The blocked device receives the same keys from the same senders as before, including after a fresh snapshot. No summary. |
| `g3-unpaired` | Spaces. Kinds `org` and `client`, three devices, two of which never paired. | Each of the two receives only from the third. | Boundaries with three devices. The two devices pair and exchange. The test asserts that every key either gains belongs to a scope both are authorized in. |
| `g3-legacy-review-rows` | Spaces. One Project with memories in a `team` scope and older memories in `legacy-shared-review`. | The `team` memories sync. The older ones do not. | The `team` memories move. The older ones stay withheld, and their count is unchanged. |
| `g3-retired-author` | Spaces. Three devices. One holds memories of a Project authored by a device that no longer exists. | The three devices hold those memories. | The retired author's memories stay under the source scope and stay readable on all three. Everything else moves. |
| `g3-two-setups-one-project` | Spaces. Two devices map the same Project to different scopes with different members. | Each part reaches its own scope's devices. | Not moved. One summary line. Each answer is tested. |
| `g4-team-setup` | Recipient policy, v0.43.0. Legacy Team setup completed: a policy Team, device decisions, a mapping to a `team` scope, Team edges nothing enforces. | Every Team device in the scope receives the Project. | A boundary with the same devices. The existing Team edge is kept, the reconciler's plan is empty, and the hold clears. This is the acceptance case of `codemem-hksk.6`. |
| `g4-recipients-differ` | As above, after the user removed one person from the recipients shown. | That person's devices still receive the Project. | A boundary that still includes them. One summary line for that person. Both answers are tested. |
| `g4-default-scope-team` | Recipient policy. A `team_default` scope with the default grant on and one linked policy Team. A second Project sits in a scope granted by hand, with the same devices. | Every Team device receives both Projects. | The first Project gets one Team edge. The second gets direct edges per person. A person added to the Team afterward receives the first Project only. The default grant has stopped. |
| `g4-existing-boundary` | Recipient policy. A Project already shared through a share operation. | Its boundary's members receive it. | Identical. No migration record. |
| `g4-in-flight` | Recipient policy. A share operation in `provisioning` and an unfinished Team setup draft. | As the source scope allows. | Waiting for a share to finish. Access unchanged. |
| `g5-account-era` | Account era, v0.47.0 to v0.49. Enrollments carry Identity IDs, device binding rows, and key evidence. | Every bound device in the scope receives the Project. | A boundary with the same devices and no summary. |
| `g5-identity-conflict` | Account era. One enrollment is bound to a different Identity than the local binding. | That device receives the Project. | A boundary that includes it. One summary line asks which person it belongs to. The reconciler issues nothing until it is answered. |
| `g5-older-coordinator` | Account era, with a coordinator that lacks the capability. | As the source scope allows. | Waiting for the coordinator. Access unchanged. |
| `mixed-older-member` | `g4-team-setup` with one device that has no readiness record. | As above. | Waiting for that device. Access unchanged. |
| `admin-receives-only` | A default scope whose admin device never opened one member's Project. | The admin device receives it. | A boundary with the same devices. With P5, the Team edge is recorded. Without P5, no edge is recorded, and a person who joins the Team later does not receive the Project. |
| `g4-default-scope-existing-edges` | Recipient policy. A default scope with the default grant on and one linked policy Team. The Project already has direct edges that derive exactly the scope's devices. | Every device receives the Project, and an approved joiner would. | The direct edges are kept and the Team edge is added. Nothing is asked. A person added to the Team afterward receives the Project. |
| `g3-default-scope-no-team` | Spaces. Two people, a default scope with the default grant on, no policy Team. | Every device receives the Projects, and an approved joiner would. | Boundaries with the same devices and direct edges. The summary shows the line about new members, with no default. |
| `admin-outside-scope` | A scope made by hand that does not include the admin device. | The admin device receives nothing of its Projects. | Boundaries with the scope's devices. The admin device is no member and still receives nothing. |

## 9. Rollout

### The flag

One configuration key, `sync_boundary_migration`, with the environment override `CODEMEM_SYNC_BOUNDARY_MIGRATION`:

- `off`: the default in the first betas. The tables exist and nothing runs.
- `report`: the device publishes its readiness record. An admin device computes what it would commit and what the summary would contain, and stores that locally. It sends no commit and changes nothing.
- `on`: the full procedure.

Proposed CLI, following `docs/cli-design-conventions.md`: `codemem sync migration status`, `codemem sync migration run <project>`, and `codemem sync migration rollback <project>`, each with `--json`. `run` migrates one named Project while the flag is `report`, which is how the first Projects move during the beta.

### Stages

1. **Dark.** The code merges behind `off`. CI runs the upgrade matrix and the end-to-end tests.
2. **Report on the owner's machines.** Every device runs `report` for at least a week.
3. **One Project.** The owner migrates single Projects with `run`, starting with a Project shared among their own devices.
4. **On, on the owner's machines.** The flag is `on` for at least 14 days.
5. **On by default** in a stable release, once the condition below holds.

The coordinator is deployed first at every stage. Its change is additive.

### What is measured

Progress is recorded in `maintenance_jobs` and shown by `codemem sync migration status` and the diagnostics events route.

- **In `report`:** per source scope, the Projects that would move and the days until every device has a readiness record. The summary lines that would appear, by kind. The pairs of devices that would be newly paired. On each device, the number of pairing filters it holds and the Projects they block. Projects that no admin device knows.
- **In `on`:** per Project, the time from commit until every device has adopted, memories moved per device, per-device counts before and after, rows per `import_key`, whether the reconciler's first plan was empty, and `sync_scope_rejections`. Per install, summary lines shown, the answer each received, and how long each stayed open.

### Condition for turning it on by default

All of these hold:

- The upgrade matrix and the tests in the [test plan](#test-plan) pass in CI, for SQLite and D1.
- The owner's machines ran `on` for 14 days and covered: a `team_default` scope, two scopes made by hand with different devices, a pairing filter, a summary confirmed with defaults and one with Include, a device offline for more than 48 hours across a commit, a device that updated after the others, and one rollback followed by a second migration.
- No device outside a source scope's authorized devices gained a memory of its Projects, other than through a confirmed summary line.
- No `import_key` has more than one row on any device.
- Search results for migrated Projects were the same before and after on every device.
- P4 and P5 have landed.
- The rule that limits a migrated Project's leftover memories to its boundary members has landed with `codemem-lvgba.28` ([Section 10](#what-retiring-filters-needs)).
- The design has had the security review ADR 0007 requires for this change.
- The manual check of a large database that the scoped sync postmortem made a release gate has been run on a migrated install.

## 10. Decision 3 retirements

The two retirements cannot both run in the migration pass.

| Part | When | Why |
| --- | --- | --- |
| Carry the effect of the default grant | In the migration pass | Devices that joined through it are members and are copied. A Team recipient carries its effect for later joiners. |
| Stop the default grant on join | In the migration pass, per group, once every Project in the group's default scope has committed | Once a Project has moved, a membership in the default scope no longer delivers it, so the grant carries nothing for that Project. Its Team recipient decides what a new member receives ([Choosing recipients](#choosing-recipients)). The grant keeps running while some Project in the default scope has not moved, and stops with the last one. The approving device turns the grant off in its preference row and records there that the migration stopped it. If a rollback returns a Project to the default scope, the same device turns the grant back on, and off again when that Project moves once more. A grant that the user turned off stays off, because it carries no such mark. A Project that turns up in the default scope later, through a pattern mapping, is then treated like the ones before it and gets its Team recipient. An older admin device can still grant until it updates. |
| Carry the effect of pairing filters | In the migration pass, by leaving them in force | A filter follows the project name, so it keeps blocking after the move (Finding 2). |
| Retire pairing filters | A later step, `codemem-lvgba.28`, with its own design | See below |
| Delete the filter columns, the group filter template, `syncProjectAllowed`, the default scope, and its preference | The release after filters are retired | The constraint is additive schema only, and older peers still evaluate filters. |

### What retiring filters needs

Retiring a filter means turning it into something the recipient model can show. The natural target is the "Keep off" choice in [Section 4](#4-ambiguity): a filter that blocks a Project for a device becomes a summary line for that device. That step needs three things this design does not provide.

- Each device has to publish which devices its filters block for which Projects, since only it knows.
- A filter is per sender and "Keep off" is per device. A device that some senders block and others do not needs a line where the admin picks one.
- Memories that stay under a source scope are still served to every member of that scope. The sender needs a rule that serves a migrated Project's leftover memories only to that Project's boundary members. An adversarial review of the first design found this path for filters, and the retired-author case in [Section 7](#7-multi-device-ordering) makes it permanent. The same rule is what makes Stop reach those memories when a recipient is removed after the migration. To apply it, every device has to tell which leftover memories belong to which Project. A device that only received a Project knows its name and nothing else, so the migration record will need each Project's names, as keyed hashes.

Until then, the device that holds a filter shows it in Devices as an older setting that limits what it sends, so the path stops being invisible.

Source scopes are not archived in 0.50. Finding 3 shows that archiving hides and deletes the memories that still carry the scope. Archiving needs its own design.

One invisible path is outside Decision 3: a pattern mapping into a source scope keeps stamping new Projects there. The migration picks each one up on its next pass. Removing the pattern rows belongs with `codemem-lvgba.28`.

## Test plan

The implementer writes these before the code. The first group pins behavior the design depends on and is expected to pass today. The rest fail until implemented.

### Current behavior the design depends on

1. `sync-replication`: after `reassignMemoryScope`, the source-scope `delete` is not sent to any peer, and a peer in only the source scope keeps its copy.
2. `sync-replication`: a peer in both scopes that receives the `upsert` restamps its one row.
3. `sync-replication`: a device that loses authorization in a scope deletes peer-authored rows there and keeps its own.
4. `sync-replication`: a sender's pairing filter blocks a memory by project name in a `managed_project` scope, on ops and on snapshots.
5. `coordinator-runtime`: two devices that share a `managed_project` scope are paired by policy trust.
6. `recipient-policy-reconciler`: on its first pass the reconciler revokes a current member that has no Identity binding.

### Prerequisites

7. `sync-bootstrap` (P1): with a committed record, a device that holds a memory under the source scope and pulls the boundary snapshot ends with one row, stamped with the boundary, at the newer revision, with the creating device unchanged. This holds when the serving peer is a proven member of the source scope, on a first pull and on a merge.
8. `sync-bootstrap` (P1): with no record, or with a record for another boundary, a snapshot is applied exactly as before. A memory whose older copy a share tombstoned is still delivered.
9. `sync-bootstrap` (P1): with a committed record, a device added to the boundary later serves a memory held under the source scope. The receiver keeps its copy in the source scope and adds no second row. This covers a memory of another Project and a newer revision of one that did move.
10. `sync-bootstrap` (P1): a serving peer with a membership row in the source scope and no proof for its pinned key is not treated as a member. A peer's claim to have created the memory counts only with a source record this device verified.
11. `sync-bootstrap` (P1): a device that has left the source scope is given the item, and the peer's copy it holds there stays unless a proven member of that scope served the item. A device whose proof for the source scope is missing, with its membership still listed, keeps the copy, for a newer item and for a newer tombstone. A copy this device created, or one with no recorded creator, is kept in both cases.
12. `sync-bootstrap` (P1): with a rolled-back record, a snapshot of the source scope replaces a copy stamped with the boundary. A tombstone under the other scope never holds back a live item, including one at the same clock. A copy the boundary already held is still updated when the copy in the other scope is kept.
13. `recipient-policy-reconciler` (P2): with the hold set and a plan that has effects, no coordinator call is made, no deny overlay is written, and the plan is available to the summary. The hold survives the merge of an alias row with a higher generation.
14. `recipient-policy-reconciler` (P2): an empty plan clears the hold. A confirmed summary clears it, and the reconciler then issues exactly the confirmed effects. Reading a record with a new generation sets it again.
15. Coordinator store contract (P3), SQLite and D1: a readiness record is accepted only from its own device key and only for a source scope that device is authorized in. It is discarded when that device posts presence without the feature.
16. Coordinator store contract (P3), SQLite and D1: commit creates the scope, the memberships, and the record together, and the members equal the source scope's authorized devices with the same roles. Commit writes nothing when an authorized device has no readiness record, when no readiness record lists the boundary, when another readiness record lists it under a different source scope, or when the boundary already exists without a migration record, with or without active members.
17. Coordinator store contract (P3), SQLite and D1: a device revoked from the source scope before the commit is not in the boundary. A repeated commit returns the stored record and changes no membership.
18. P5: a boundary member learns the Project's identity from a peer, rejects an identity that does not hash to the boundary ID, and can then record recipients.
19. Coordinator store contract (P3), SQLite and D1: a grant or revoke on a migrated boundary is refused when it carries no generation, an older generation, or comes from a device other than the managing one, and when the record is rolled back.
20. Coordinator store contract (P3), SQLite and D1: take over names a new managing device and advances the generation. A request from the previous managing device is then refused, and one from the new device is accepted.
21. Coordinator store contract (P3), SQLite and D1: a commit that lists an additional source needs a stored answer, is refused when a readiness record lists a source the request does not name, and copies the devices of the chosen source only.

### Procedure and crash recovery

22. One test per row of the [order of writes](#order-of-writes): stop after the step, restart, and reach the same end state.
23. The coordinator call log for a full migration contains no write to a source scope.
24. A device that no longer maps the Project moves its old memories and gets no mapping.
25. A device that never held the Project gets no mapping and moves nothing.
26. Memories in `legacy-shared-review`, `local-default`, and other scopes are not moved.
27. An admin device that is not a member of the source scope commits, is not a member of the boundary, and receives nothing.

### The summary

28. A Project whose recipients derive exactly the boundary's members produces no summary line and the hold clears.
29. One test per line kind in [Section 4](#the-summary): the line appears, and each choice has the effect the preview named.
30. Confirming every default changes no device's access. This includes a person kept as a recipient who has another device outside the boundary: that device gets its own line and stays out.
31. A line with no default keeps its Projects held until it is answered, and Confirm applies the other lines.
32. "Keep off" keeps the device out of the boundary across later reconciler passes, and changing it in Projects grants the device.
33. A device that is not the managing admin device shows recipients read-only and offers no choice.
34. After a takeover the hold is set on the new device, a device that was kept off appears as a line defaulting to Keep off, and confirming the defaults changes no membership.
35. With the managing device gone, a recipient's new device is not granted. After another admin device takes over and confirms, it is.
36. A confirmed line returns only when its fingerprint changes.
37. The two cases that do not move by themselves produce their line, change nothing until answered, and each answer has the previewed effect.

### End to end, through `syncOnce`

38. The fixture matrix in [Section 8](#fixtures), one test per row.
39. A partly moved Project delivers every memory to the same devices as before.
40. A device blocked by a filter holds the same keys before and after, including after authors write new memories and after it pulls fresh snapshots of both scopes.
41. Two admin devices commit the same Project. One record results, and neither reconciler issues an effect.
42. A member offline across the commit adopts on return and ends with one row per key.

### Rollback

43. Rollback restores each device's saved mappings and returns every memory to the source scope. Per-device holdings equal the pre-migration holdings plus memories written since.
44. Rollback revokes a device that was included after the migration and no device that is authorized in the source scope.
45. After rollback, a device that holds a peer-authored memory still stamped with the boundary can still read it.
46. The rollback preview names a device that was removed from the boundary and is still authorized in the source scope.
47. A second migration after a rollback commits a new generation, and the boundary's members again equal the source scope's authorized devices.
48. A reconciler pass on the managing device that runs after the rollback and before that device reads the record grants nothing, and a device the rollback removed stays out.
49. A memory moved from a second older setup returns to that setup on rollback.

### Decision 3

50. Approving a join request grants no default scope once every Project in the group's default scope has committed. It still grants while one Project has not moved.
51. A person added to the Team after the migration receives the Projects that came from the default scope.
52. The migration writes no pairing filter and no global filter key.

### Added after the pull request review

53. A Project from a default scope with the default grant on, whose existing direct edges derive exactly the boundary's members, also gets the Team edge. A person added to the Team afterward receives it.
54. The same case with no linked Team shows the line about new members, with no default, and changes no device's access.
55. The default grant stops when the last Project in the default scope commits and keeps running before that.
56. Two older setups: an author that is only in the setup the admin did not pick keeps its own memories there, they keep reaching that setup's devices, and the line names it.
57. Coordinator store contract (P3), SQLite and D1: attach stores a committed record for an existing boundary, changes no membership, needs a stored answer, and is refused when the boundary has a migration record already. It is also refused while a device that is authorized in both the boundary and the source scope has no readiness record.
58. After an attach, boundary members that keep the Project in the source scope move their own memories. A device that is only in the source scope keeps its memories there. Rolling the record back revokes nobody.

59. After a rollback, the maintenance pass sends no commit for that Project, even when every device has restored its mapping and published readiness. An explicit request commits a new generation.
60. A Project that appears in a default scope after the migration stopped the group's default grant still gets the Team edge.

61. After the migration stopped a group's default grant, rolling one of its Projects back turns the grant on again, and an approved joiner receives the default scope. Moving the Project again stops it. A grant the user turned off stays off through both.
62. Rolling back an attached record revokes nobody and leaves it `detached`. A recipient can then be removed and a replacement device granted on that boundary by a request with no generation. A request that carries the attach's generation is refused. Memories that were in the boundary before the attach stay there. A snapshot of the source scope does not pull out a memory that was in the boundary before the attach. Once the attach change keeps a record of what this device moved in, a device that still holds such a memory under the boundary takes the newer copy from a snapshot of the source scope.

### Added with the readiness record storage

63. Coordinator store contract (P3), SQLite and D1: commit writes nothing when a device authorized in the source scope has a readiness record with a left-out count above zero, or with an entry that was left out for a malformed boundary ID. A device outside the source scope with such a record does not stop the commit.
64. Coordinator store contract (P3), SQLite and D1: commit writes nothing when a device authorized in the source scope has a record that names a refused source scope the device is authorized in at the commit. It commits when the device is still outside that scope. The check counts only refused scopes that belong to the record's group, so a scope of another group that a device once named does not keep its record incomplete. A stored list that is not valid JSON makes that one record incomplete and does not stop commits for other devices.
65. Coordinator store contract (P3), SQLite and D1: commit counts a readiness record only when the device's stored presence lists the migration feature.
66. Coordinator store contract (P3), SQLite and D1: attach accepts a readiness record that is not complete.
67. Coordinator store contract, SQLite and D1 (in the storage change): a record is not stored when a scope authorization read fails, and the stored record stays. A record with a left-out count or a malformed entry reads as not complete. The source scopes a record was refused for are stored with it.
68. Device readiness inventory includes exact mappings with no memories, resolved pattern mappings, and own rows in an older scope even after a mapping changes. It merges recorded repository aliases, includes private rows in the counters, and excludes peer-authored and deleted rows. It changes no local state and sends no names or content.
69. Before readiness is advertised, the sender must prove that an inventory failure removes the group's earlier record by posting presence without the migration feature. An unidentified or ambiguous source Project must not leave an older complete record available.

Validation for each stack layer is the focused tests above. The stack tip runs `pnpm run check` and the Docker scenarios `legacy-team-migration`, `project-sharing`, and `sharing-domains`.

## Owner decisions

On 2026-11-16 the owner decided twelve questions about the first design, with the condition that every review item be actionable. On 2026-11-17 the owner chose the simpler experience in the [Summary](#summary) and decided one question from the third review pass. The table shows where each decision stands.

| # | Question | Where it stands |
| --- | --- | --- |
| 1 | Two authorized devices that never paired | Replaced. They connect without a question. |
| 2 | A device that never updates | Stands. Its scope's Projects wait, and Remove device is the way out. |
| 3 | What devices publish to the coordinator | Replaced. A readiness record holds boundary IDs and counts. No pairing, filter, or name. |
| 4 | An admin device that does not hold a Project | Replaced. Any admin device can commit. Managing recipients needs P5 or an admin device that receives the Project. |
| 5 | Team edge or direct edges | Stands. A Team edge only where the default grant was on. |
| 6 | A device of a recipient that does not receive the Project | Replaced. "Keep off" records it per device and Project. The earlier decision ruled that out. |
| 7 | Filters that could never be cleared | Moved to `codemem-lvgba.28`. The migration no longer clears filters. |
| 8 | Filters after an answer that includes a device | Replaced. The migration does not touch filters. |
| 9 | Two admin devices with different rosters | Stands. One manages a Project's recipients, and the other shows them read-only (`codemem-lvgba.35`). |
| 10 | Source scopes and rolled-back boundaries | Stands. Source scopes are never archived, and a rolled-back boundary keeps its members that are in the source scope. |
| 11 | A manual change to a source scope after commit | Replaced. It does not reach the migrated Project and raises no question. The Viewer stops offering such edits. |
| 12 | Rollback window | Replaced. Rollback has no window. |
| 13 | A newer revision offered by a device that was added to the Project later | Decided 2026-11-17. A device that holds the older copy waits for the author or a device from the older setup. No signed move record is added to the sync protocol. |

## Still open

1. **Legacy Team setup still writes mappings into older scopes.** A Team setup finished after its group has migrated would map Projects to a source scope again. It has to target boundaries, or wait for the migration. ADR 0007 Decision 7 owns that flow.
2. **A filter behind the recipient list.** Until `codemem-lvgba.28`, a blocked device appears as a recipient. The design shows the filter on the device that holds it. Whether that is enough for 0.50 depends on how many installs have a filter, which the report stage measures.
3. **A Project split between a boundary and its old scope.** Memories from retired authors stay in the old scope. A recipient added later does not receive them. A recipient removed later can still pull them from the old scope while their device is authorized there, so Stop does not reach them. The rule that closes this is deferred to `codemem-lvgba.28`, and the migration is not on by default without it ([Section 9](#condition-for-turning-it-on-by-default)). Until then, the preview for Stop says so when this device still holds memories of the Project in the older setup.
4. **A Project no admin device receives.** It moves with the same devices, and nobody can change its recipients until an admin device receives it. The Viewer needs a way for an admin to add themselves to such a Project. The report stage counts these.
5. **A recipient who has not accepted an invitation** blocks the existing derivation for the whole Project. With the hold this changes no access. It also produces no summary line, so the Project keeps the copied devices until the invitation is accepted or removed. `codemem-lvgba.21` covers the related stall for deactivated people.
6. **Review.** Three adversarial passes have run, the third at the owner's direction. Each asked for changes. The fixes made after the third pass, and the changes made for the automated review threads, have not been reviewed by a person or by the adversarial reviewer. They cover the admin takeover, the key-bound wording in P1, the commit for two older setups, the attach and `detached` states, restoring the default grant on rollback, and keeping rolled-back Projects out of the automatic pass. The [review record](#review-record) lists them. The failing tests in the [test plan](#test-plan) pin the snapshot rule and the coordinator's generation check, and ADR 0007 requires a security review before the migration is on by default.
7. **Rollback of a Project that was moved from two older setups.** Rollback keeps boundary members that are authorized in the setup the admin picked. A memory that came from the other setup and whose author is offline stays readable to them until that author returns.
8. **Whether the hold suspends removing a deactivated or merged person's devices.** P2 and [Section 4](#the-summary) say it does: the summary asks, with no default, and the Project keeps today's devices until the admin answers. A later change on `main` removes such devices even while a Project's recipients cannot be derived, as ADR 0007 Decision 6 intends. The two disagree for a held Project, and the owner has not chosen. The options are to keep the hold as written, to let the removal run through the hold, or to split by time: devices already withdrawn when the Project moved keep the summary line, and a person deactivated or merged afterwards loses their devices at once. The hold columns include the list the third option needs, the devices already withdrawn when the hold was first seen at a generation, because there is no stored time of deactivation. Nothing reads the list yet.

## Review record

### First pass, 2026-11-16

One adversarial review ran on the first design with a model from a different vendor, on the concern "find a sequence of states where this migration gives a device access it did not have, or silently removes access a device should keep". The reviewer traced each sequence through the source and the draft. It ran no tests. Its verdict was to request changes.

| # | Finding | Where it stands in this revision |
| --- | --- | --- |
| 1 | Clearing filters exposed memories left in the source scope to a device outside the boundary. | The migration no longer clears filters. The finding is recorded as a requirement on `codemem-lvgba.28` in [Section 10](#what-retiring-filters-needs). |
| 2 | A grant request from an abandoned plan could arrive after another admin device committed a different plan. | Removed by construction. The migration sends no grants and no device list. The coordinator copies the members inside the commit. |
| 3 | A device revoked from the source scope between verify and commit stayed in the boundary. | Removed by construction. The coordinator reads the members in the same transaction that writes the boundary. Test 17 covers it. |
| 4 | The snapshot rule accepted a cross-scope item only from the memory's author, so another device could not deliver a newer revision while the author was offline. | Fixed for devices from the older setup. P1 accepts the item when a migration record covers the move and the serving device is the author or is authorized in both scopes. The third pass found the remaining case, listed below. Test 7 covers it. |
| 5 | Suspected: rollback revoked boundary memberships before received copies had returned to the source scope. | Fixed. Rollback revokes only members that are not authorized in the source scope. Tests 44 and 45 cover it. |
| 6 | Suspected: a device that only received a Project had no entry in what devices published. | No longer applies. The design does not depend on what a receiving device holds. |

### Second pass, 2026-11-17

The same reviewer ran the one correction pass on this revision, with the owner's new definition of access given as decided. It closed or moved all six first-pass items and confirmed that the transactional commit removes findings 2 and 3. It found four new sequences and one suspected one, and its verdict was again to request changes. The third pass reviewed the fixes below.

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | The commit reused an existing boundary that had no active member. Devices can still hold memories stamped with such a boundary from an earlier share, and granting it again made them readable and deliverable to the source scope's devices. | Fixed. The commit never reuses a boundary that exists without a migration record. That case is a summary line ([Migration record](#migration-record)). Test 16 covers it. |
| 2 | After a rollback removed a device, the reconciler on the managing admin device could grant it again before that device had read the record. | Fixed. Every membership change on a migrated boundary carries the record's generation and is checked inside the coordinator's transaction, and all changes are refused once the record is rolled back (P3, [Section 6](#6-per-project-rollback)). Tests 19 and 48 cover it. |
| 3 | The snapshot rule checked the two scopes and no Project. A device added to a boundary later, with no access to the source scope, could serve a memory of another Project stamped with the boundary. The receiver would move it, and would lose it when the first Project stopped being shared with it. | Fixed differently from the reviewer's suggestion. P1 now requires the serving peer to be authorized in both scopes, which removes the device in the traced sequence. The reviewer suggested checking that both copies belong to the record's Project. A device that only received a Project has its name and no canonical identity, so it cannot make that check without project names or their hashes at the coordinator. Tests 8 and 9 cover the rule. |
| 4 | Confirming every default could change access in two ways: keeping a person added that person's other devices, and the line for a deactivated person defaulted to Stop. | Fixed. The summary shows the combined result of all choices and adds "will start receiving" lines for devices a choice brings in, each defaulting to Keep off. The deactivated-person line has no default ([The summary](#the-summary)). Tests 30 and 31 cover it. |
| 5 | Suspected: merging a Project alias can replace the authority row, which is where the draft kept the hold. The reconciler could then stage a deny overlay and revoke a device before the summary was confirmed. | Fixed. The hold is stored in the migration's own table under the boundary ID and is checked before any write (P2). Test 13 covers it. |

The reviewer also named three places where the draft was too thin to trace: how the hold is implemented, what the coordinator checks in a readiness record beyond its signer, and where memories return on rollback when a record names more than one source scope. P2, [Readiness record](#readiness-record), and [Section 6](#6-per-project-rollback) now state each one.

### Third pass, 2026-11-17

The owner authorized one more pass, limited to the five fixes above and the three contracts the second pass called too thin. The reviewer closed findings 1, 2, 4, and 5. It found that the source supports the claim that a peer authorized in both scopes gains nothing from the snapshot rule. It found two sequences that the fixes introduced, one suspected one, and one contract still incomplete. Its verdict was again to request changes. What follows was done afterward and has not been reviewed.

| # | Finding | Disposition |
| --- | --- | --- |
| A | The snapshot rule from finding 3 refuses a newer revision from a device that was added to the Project later and was never in the older setup. A device that holds the older copy waits for the author or a device from the older setup. A fresh install of the same device would get the newer revision at once. | Accepted by the owner as a limit on 2026-11-17. The reviewer rated it blocking. Every device that could deliver the update before the migration still can, so no delivery that existed is lost ([Section 7](#7-multi-device-ordering)). The rule also now accepts the memory's author whether or not it is still in the older setup. The reviewer's fix is a move record signed by the author that travels with each snapshot item, which adds per-memory signatures to the sync protocol. The owner chose the delay. Test 11 pins the behavior. |
| B | The check from finding 2 accepts membership changes only from the managing device. If that device is lost, nobody can grant a recipient's replacement device. | Fixed. Any admin device can take over in one coordinator transaction that advances the generation and sets the hold again ([Choosing recipients](#choosing-recipients)). Tests 20, 34, and 35 cover it. |
| C | Suspected: if the snapshot rule checked a bare membership row for the serving peer, a peer without valid key-bound proof in the source scope could pass. | Fixed. P1 names the key-bound check against the peer's authenticated key for both scopes. Test 10 covers it. |
| D | The commit for a Project moved from two older setups was not specified, because the automatic commit refuses a second source. | Fixed. [Two cases](#two-cases-where-a-project-does-not-move-by-itself) states the request and how the conditions change. Test 21 covers it. |

### Automated review threads on the pull request, 2026-11-17

An automated reviewer left eleven threads on the pull request across seven commits. The last two were folded in by a follow-up change after the pull request merged (`codemem-lvgba.41`). Two were written against text that the 2026-11-17 revision removed.

| Thread | Disposition |
| --- | --- |
| Recipient removals do not reach memories left in the source scope. | Deferred to `codemem-lvgba.28`, with a gate. The finding is correct and was already listed under [Still open](#still-open). The rule that closes it needs each Project's names in the migration record and belongs with filter retirement, which needs the same rule. The migration is not on by default without it. |
| Lifting a filter that uses an include list has to add the Project's names. | No longer applies to this design, which does not change filters. Recorded on `codemem-lvgba.28`, where an include list has to be handled when a filter is retired. |
| An author that is only in the setup the admin did not pick cannot move its memories. | Fixed. Those memories stay in that setup, and the line says so ([Two cases](#two-cases-where-a-project-does-not-move-by-itself)). Test 56. |
| Existing edges that match exactly won over the Team edge, so later joiners in a default scope received nothing. | Fixed. A Project from a default scope with the default grant on always ends with a Team edge, or with a line about new members when no Team exists. The claim that keeping the default grant running preserved delivery was wrong and is removed ([Choosing recipients](#choosing-recipients), [Section 10](#10-decision-3-retirements)). Tests 53 to 55. |
| "Move the rest" had no commit path, because the commit refuses an existing boundary. | Fixed. An attach transaction stores a record for the existing boundary and changes no membership ([Two cases](#two-cases-where-a-project-does-not-move-by-itself)). Tests 57 and 58. |
| With the rollout flag on, a rolled-back Project was picked up and moved again by the next maintenance pass. | Fixed. The pass skips any boundary that has a migration record. Moving a rolled-back Project again needs an explicit request ([Section 5](#the-admin-device)). Test 59. |
| A Project found in a default scope after the default grant was stopped got no Team edge, because recipient selection required the grant to be on. | Fixed. The preference row records that the migration stopped the grant, and recipient selection treats that like on ([Choosing recipients](#choosing-recipients), [Section 10](#10-decision-3-retirements)). Test 60. |
| Rolling a Project back to a default scope left the default grant off, so later joiners received nothing from either side. | Fixed. The device that stopped the grant turns it back on while a rolled-back Project sits in the default scope ([Section 10](#10-decision-3-retirements)). Test 61. |
| Rolling back an attached record left the existing boundary with a rolled-back record, which blocked ordinary recipient changes on a boundary that was shared before the attach. | Fixed. An attached record rolls back to `detached`, and the coordinator then treats the boundary as it did before the attach ([Two cases](#two-cases-where-a-project-does-not-move-by-itself)). Test 62. |
| Attach could proceed while an older device that sits in both the boundary and the source scope had not updated, which would duplicate rows on that device. | Fixed in the follow-up. Attach requires a readiness record from every such device ([Two cases](#two-cases-where-a-project-does-not-move-by-itself)). Test 57. |
| After an attached record was rolled back, the snapshot rule did not let a source-scope snapshot replace a copy that the attach had moved into the boundary. | Fixed in the follow-up, then deferred by the snapshot change: a `detached` record covers nothing until this device keeps its own record of what an attach moved in ([P1 implementation review](#p1-implementation-review-2026-11-18)). Test 62. |

### P1 implementation review, 2026-11-18

Writing the snapshot change showed that two parts of the first wording of P1 would have removed access that exists today. The coordinating session accepted both corrections. A security review of the change then found three more cases, on the concern of whether it gives a device access it did not have or removes access it should keep. The review ran on a model from a different vendor. P1 above states the result.

| Change to the first wording | Why |
| --- | --- |
| With no covering record, the snapshot is applied as before. The first wording said to skip the item. | An existing share tombstones the copy under the older scope and delivers the live copy by snapshot. Skipping would leave the device with the tombstone only. |
| In a scope this device has left, the item is added and the held copy stays. The first wording required this device to be authorized in both scopes and otherwise skipped the item. | A boundary member that was removed from the older scope would otherwise wait for the author, although a device that never held the copy would be given the item. |
| Only a proven member of the copy's scope, or the verified creator, can cause a held copy to be deleted. Review finding, high, in two rounds. | The first version of the code deleted the copy whenever this device lacked proof for its scope, and the second whenever the membership looked lost. Both states can be temporary, and a device added later could delete a copy this device would regain. |
| A tombstone under the other scope never holds back a live item. Review finding, medium. | A share leaves a tombstone at the same clock as the live copy, so the clock check kept the tombstone and delivered nothing. |
| A copy the boundary already held is kept up to date on a first pull as well as on a merge. Review finding, medium. | A first pull clears the scope before it applies items, so a held-back item removed the copy that was already there. |
| The creating device is taken from a verified source record, and a `detached` record covers nothing yet. Review hardening. | The creating device and the last move on a held copy both arrive in payloads a peer controls. |
