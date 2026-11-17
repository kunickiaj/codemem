# Per-Project boundary migration design

**Status:** Proposed. Awaiting owner approval. This document changes no production code.

**Date:** 2026-11-16

**Task:** `codemem-lvgba.24`, which absorbs `codemem-hksk.6` and blocks `codemem-lvgba.28`.

**Spec:** [ADR 0007](../adr/0007-one-sync-and-sharing-model-per-concept.md) (Principle 2, Decisions 2, 3, and 9) and [ADR 0001](../adr/0001-project-recipient-policy-boundaries.md) (Decision 3).

**Source read at:** commit `f6137e97e`. Every file reference below is to that commit.

## Summary

Each shared Project that sits in a scope with other Projects gets a `managed_project` scope of its own. This document calls that scope the Project's boundary. The migration grants the boundary to the devices that receive the Project at that moment, records recipient edges that derive the same devices, and moves the Project's memories into it. The existing reconciler then enforces recipients for that Project.

Five choices carry the design.

1. **Each device moves its own memories.** A device can record sync operations only for memories it authored, so nobody else can move them. Each device also checks its own part of the proof that nothing widens before it moves anything.
2. **A Project migrates only after every device in its current scope has upgraded.** Each upgraded device publishes a signed device report to the coordinator. The report carries the facts only that device knows: which devices it is paired with and what its pairing filters block. A device that has not reported makes the Project wait. This follows ADR 0001 Decision 3, condition 4.
3. **The commit is one coordinator transaction.** It checks that the source scope's members and every device report still match the plan, creates the boundary, grants it to the planned devices, and stores a migration record. Either all of that happens or none of it. No boundary exists half granted, and a late or repeated request cannot add a device.
4. **The migration never changes the scope the Project came from.** It issues no revoke, no archive, and no filter change there. Rollback is possible because the old enforcement is still intact.
5. **Anything the migration cannot show to be equal becomes one review item.** The Project keeps its current enforcement until the user answers.

Four [prerequisites](#prerequisites) must land first. The recommendation on Decision 3 is in [Section 10](#10-decision-3-retirements): convert the effect of both paths in this pass, stop the default grant in this pass, and delete the filter columns, the sync-time check, and the default scope a release later.

An adversarial review ran once on this design. Its findings changed the commit, the snapshot prerequisite, rollback, and the filter retirement. The [review record](#review-record) lists each one. The corrected design has not been reviewed a second time.

## Terms

- **Project:** one canonical project identity.
- **Source scope:** the coordinator scope whose ID is stamped on the Project's memories today. Its kind is anything other than `managed_project`.
- **Boundary:** the Project's own `managed_project` scope. Its ID is `managed-project:` followed by the SHA-256 of the group ID and the canonical project identity (`packages/core/src/managed-project-scope.ts:3-11`). Every device that knows the Project computes the same ID without asking anyone.
- **Admin device:** a device whose configuration holds the coordinator admin secret.
- **Author:** the device that created a memory.
- **Carrier:** a device that holds a copy of a Project's shared memories, whether it authored them or received them.
- **Device report:** a signed document each upgraded device publishes to the coordinator. [Section 1](#device-report) lists its contents.
- **Migration record:** the coordinator's per-Project record of the committed plan. [Section 2](#migration-record) lists its contents.
- **Receive set:** the devices that can receive the Project now. [Section 1](#computing-the-receive-set) defines it.

## Findings that shape the design

The map in `codemem-lvgba.15` and `codemem-lvgba.14` holds. Reading the code for this design added the following.

1. **Enforcement is on the sending side.** `GET /v1/ops` returns only ops the serving device authored (`packages/core/src/sync-replication.ts:1362-1373`). A scoped snapshot is different: it carries every memory the serving device holds in that scope, whoever authored it (`sync-replication.ts:1394-1447`, `1449-1516`). On both paths the sender applies the membership check, visibility, and its own pairing filter (`sync-replication.ts:2316-2335`, `2390-2525`, `1433`). Pairings and filters live in each device's own database, so an admin device cannot see another device's filters.
2. **Membership in a scope also gates local reads and retention.** Search reads only scopes this device is an authorized member of (`packages/core/src/scope-resolution.ts:302-347`). When a device loses authorization in a scope, it deletes the rows it received from peers in that scope at its next exchange with each peer (`sync-replication.ts:2639-2641`, `2749-2863`). `POST /v1/ops` also checks authorization for the scope of any existing row with the same `import_key` (`packages/viewer-server/src/routes/sync.ts:4922-4965`). Revoking a member of a source scope, or archiving it, would hide and then delete data and would make later pushes fail.
3. **No per-Project rollback exists.** `rolled_back` is a label written to `recipient_policy_authority_states`. Sync never reads it, and nothing reverts grants, mappings, or memories.
4. **The reconciler acts on its first pass.** It revokes every current member that the local recipient tables do not derive, including a device with no Identity binding, and a device whose coordinator enrollment is bound to a different Identity (`packages/core/src/recipient-policy-reconciler.ts:419-430`). Pointing it at a freshly migrated boundary without a parity check could remove devices.
5. **Sharing a `managed_project` scope pairs devices automatically.** Coordinator policy trust pins a discovered device once both devices are fresh members of one `managed_project` scope (`packages/core/src/coordinator-runtime.ts:506-695`). A pairing then carries every scope both devices are authorized for. Granting a boundary to two devices that never paired starts sync between them, for this Project and for anything else both already hold.
6. **Three functions move a memory between scopes, with different effects on other devices.**
   - `MemoryStore.reassignMemoryScope` records a `delete` in the old scope and an `upsert` in the new one, in one transaction per memory (`packages/core/src/store.ts:2035-2126`). The sender then skips the `delete`, because its own row now carries the new scope (`sync-replication.ts:2361-2371`, `2473-2479`). A device in both scopes restamps its copy when the `upsert` arrives (`sync-replication.ts:4075`). A device only in the old scope keeps its copy.
   - The Project mapping route adds an `access_cleanup` op that hard-deletes the copy on every paired peer (`packages/core/src/project-scope-settings.ts:1119-1129`).
   - `recordScopeReassignment` writes a `reassign_scope` pair whose old side tombstones the copy on devices that stay in the old scope (`sync-replication.ts:1041-1167`).
7. **A scoped snapshot can duplicate a memory.** The first pull of a scope from a peer applies a snapshot. `insertSnapshotItem` is a plain insert (`packages/core/src/sync-bootstrap.ts:357-429`), and the merge path looks for an existing copy only inside the same scope (`sync-bootstrap.ts:608-678`). A device that holds a memory under the source scope and then pulls the boundary gets a second row with the same `import_key`. This comes from reading the code. No test covers it.
8. **The existing migration route does not help.** `POST /api/sync/recipient-policy/v1/migrate` creates no scope, never calls the coordinator, and emits nothing for a scope that holds more than one Project.
9. **The default grant has one caller.** Only the Viewer's join approval route grants a group's default scope, and only when a preference stored in that device's own database is on (`routes/sync.ts:559-592`). CLI approval never grants it.
10. **Scope kind is free text at the coordinator and defaults to `user`.** `team`, `org`, and `client` have no dedicated creator. The migration has to treat every coordinator scope that is not `managed_project` and not `personal:<actor>` as a possible source scope.
11. **Project mappings are per device and are not replicated.** A device learns a new mapping only when something on that device writes it. Pattern mappings can send Projects nobody has reviewed into a source scope.
12. **A device cannot know the version of an offline device.** Presence expires, and `sync_peers.runtime_version` is stored only for stable releases and only for direct peers.
13. **A coordinator grant checks only that the scope is active and the device is enrolled** (`packages/core/src/better-sqlite-coordinator-store.ts:3223-3306`). A delayed request from an abandoned plan would be accepted. The migration therefore issues no separate grants.

## Prerequisites

These must land with tests before the migration can be enabled.

- **P1. Snapshot apply must reconcile by `import_key` across scopes.** When a snapshot item's `import_key` already exists under another scope, the receiver replaces that copy only when the snapshot clock is newer, the receiver is authorized in both scopes, and one of two things is true. Either the existing copy's origin device is the serving peer, or a migration record the receiver has read covers the move: the existing copy carries the record's source scope, the item carries the record's boundary, and the copy's project name matches the record. A record in `rolling_back` covers the opposite direction. In every other case the receiver skips the item. The origin check stops a peer from pulling another author's memories into a scope it chooses. The record lets any carrier hand on a move the author already made.
- **P2. The reconciler needs an effect gate for migrated Projects.** For a Project that carries a migration row, the reconciler computes its plan and issues no grant or revoke until one pass has observed an empty plan. [Section 2](#handing-authority-to-the-reconciler) describes the gate.
- **P3. The coordinator needs additive resources:** device reports, migration records, and three operations on records that each run as one transaction (commit, begin rollback, finish rollback). The client detects them through a capability. A coordinator without them makes every Project wait.
- **P4. Device-to-Identity bindings must exist for older pairings.** ADR 0007 Decision 6 converts `sync_peers.actor_id` and `claimed_local_actor` into bindings. Without it, most installs from before recipient policy have no way to derive recipients, and their Projects land in review.

## 1. Inventory

### Where a Project's memories can sit

A memory's scope is stamped when it is written, from the writing device's own mappings (`packages/core/src/scope-resolution.ts:224-277`). An exact mapping, a mapping written by legacy Team setup, a pattern mapping, and the legacy shared review reassign route can all put a Project in the scopes below.

| Scope the memories carry | How a device becomes authorized | Shared today | Migration |
| --- | --- | --- | --- |
| `team_default` (`team:<group>:default`) | The creating device is granted `admin` when the group is created. A device is granted `member` when the Viewer approves its join request and the default grant preference is on. An admin can also grant it by hand. | Yes | Source scope |
| `team` | Manual grant from the Viewer scope panel, the CLI, or the coordinator API. Legacy Team setup maps Projects here and writes Team recipient edges that nothing enforces. | Yes. The only legacy kind that relay carries. | Source scope |
| `org`, `client`, `user`, or any other kind | Manual grant | Yes, over direct sync only | Source scope |
| `managed_project` | Share provisioning, the reconciler, or a manual grant | Yes | Already a boundary. Left alone. |
| `personal:<actor>` | Manual grant | Private memories only | Left alone. It shares a person's private memories and holds no Project. |
| `local-default`, `legacy-shared-review`, or no scope | Nobody | No. Sync withholds these. | Left alone. ADR 0007 Decision 9 and `codemem-lvgba.26` cover them. |
| A scope with authority `manual` or `invite` | No writer exists in current code | Not determined | Review item `unsupported_source` if any memory carries one |

### Gates on top of authorization

| Gate | Stored | Who evaluates it | Effect on the receive set |
| --- | --- | --- | --- |
| Coordinator membership: active, at the scope's current epoch, enrollment enabled, device not revoked, group not archived | Coordinator, mirrored in each device's cache | Sender and receiver | Defines the starting set |
| Pairing with a pinned key | Each device's `sync_peers` | Both ends | A device pair exchanges nothing without it |
| Pairing filter (`projects_include_json`, `projects_exclude_json`) | The sender's `sync_peers` row for that peer | The sender on every path. The receiver only on `POST /v1/ops`. | Removes a Project for one receiver, from one sender |
| Global filter (`sync_projects_include`, `sync_projects_exclude`, and the matching environment variables) | The sender's configuration | The sender, for every peer whose row has no filter of its own | Removes a Project for every such peer |
| Group filter template | `coordinator_group_preferences` on one device | Copied into a new pairing row once, when a discovered peer is accepted | None by itself. Its effect is the pairing filter it seeded. |
| Default grant on join | Preference in `coordinator_group_preferences`. The grant is a normal membership at the coordinator. | The approving device | Already in the starting set as a membership |
| Visibility | The memory | Sender | Private memories are never shared through a Project. Unchanged. |
| Deny overlay | `recipient_policy_deny_overlays` | Sender | Written only for boundaries. A row on a source scope is unexpected and sends the Project to review. |
| Relay | Scope kind | The initiating device | Transport only. `team_default`, `org`, and `client` have no relay path today and gain one as boundaries. |

Filters match a Project by exact name or by the last path segment of the name, with no wildcard (`sync-replication.ts:2050-2064`). An include list that is not empty blocks every Project it does not name and every memory with no project name.

### Device report

An admin device cannot read another device's pairings or filters. Each upgraded device therefore publishes one report per coordinator group, signed with its device key.

```json
{
  "version": 1,
  "device_id": "…",
  "group_id": "…",
  "sequence": 12,
  "runtime_version": "0.50.0",
  "can_administer": false,
  "filters_cleared": false,
  "default_filter": { "include": null, "exclude": [] },
  "peers": [{ "device_id": "…", "include": null, "exclude": ["<name hash>"] }],
  "evidence_digest": "…",
  "authored": [
    {
      "boundary_scope_id": "managed-project:…",
      "mapped_scope_id": "team:g1:default",
      "own_row_scope_ids": ["team:g1:default"],
      "own_row_count": 412,
      "names": [{ "full": "<name hash>", "base": "<name hash>" }]
    }
  ],
  "held": [{ "scope_id": "team:g1:default", "name": "<name hash>", "count": 1630, "digest": "…" }],
  "records": [
    { "boundary_scope_id": "managed-project:…", "generation": 1, "projection_digest": "…", "state": "adopted", "own_rows_in_boundary": 412, "own_rows_in_source": 0 }
  ]
}
```

- `peers` lists the group's devices this device holds a pinned pairing for, each with the filter stored on that pairing. A pairing with no filter of its own uses `default_filter`, which mirrors the global configuration.
- Filters are name lists, so the report carries them as hashes of project names keyed with the group ID. The coordinator stores no repository name. Names are guessable, so the hashes hide them only from a casual reader.
- `evidence_digest` covers `default_filter` and `peers`.
- `authored` lists every Project this device maps to a coordinator scope that is not a boundary, or holds its own memories in one. Each entry carries the hashes of the Project's names, full and last segment, so an admin device can apply any device's filter to it.
- `held` counts the shared memories this device holds in each such scope, per project name, and digests their sorted `import_key` values. It covers memories the device received as well as its own. It tells the planner which devices are carriers, and it is the before and after measurement.
- `records` lists the migration records this device is part of and how far it has applied each.

A device republishes when any field changes. The report is capped in size and version-checked the way legacy Team completion manifests are. A valid report is also the durable sign that the device runs code that can adopt a boundary, which Finding 12 says nothing else provides.

### Computing the receive set

For Project P with source scope S, on an admin device:

1. Read S's members and the group's enrollments from the coordinator with the admin secret. `Auth` is the set of devices the coordinator would authorize: active membership at the current epoch, enabled enrollment, no device revocation.
2. Require a current report from every device in `Auth`. Without one the Project waits.
3. `Authors` is every device in `Auth` whose report maps P to S or counts its own memories of P in S. `Names` is the union of the name hashes in their entries. `Carriers` is `Authors` plus every device in `Auth` whose `held` list has an entry in S for one of `Names`. A carrier can hand P to another device through a snapshot (Finding 1).
4. For a carrier `c` and another device `r`, apply the filter `c` stores for `r` to each name in `Names`. `c` blocks P for `r` when every name is blocked. A filter that blocks some names and allows others is an ambiguity.
5. A device `r` is excluded when at least one other carrier exists and every other carrier blocks P for `r`. `X` is the set of excluded devices.
6. The receive set is `M = Auth − X`.

The default grant needs no step of its own. A device that joined through it holds an ordinary membership in S and is in `Auth`. The grant's effect on future joiners is carried by the choice of recipient edge in [Section 2](#choosing-recipient-edges), and the grant itself stops as described in [Section 10](#10-decision-3-retirements).

A pairing filter that blocks P for a device removes that device from `M` when every carrier agrees. That is the conversion ADR 0007 Decision 3 asks for. When carriers disagree, the Project goes to review.

The plan is usable only when all of these hold. Each failure is an ambiguity in [Section 4](#4-ambiguity).

- Every author maps P to S, and no author holds its own memories of P in another coordinator scope.
- No carrier in `M` blocks P for another device in `M`.
- No device in `X` is an author.
- No filter splits the Project's names.
- Every two devices in `M` list each other in `peers`.

The last condition exists because of Finding 5. Two devices that are both authorized in S and never paired exchange nothing directly today. Putting both in one boundary would pair them.

For each device in `M` the planner also computes a projection digest: the device's pairing with each device in `Auth`, and whether it blocks P for each. The record stores these. A device can recompute its own from its current filters and the record's `Names`, which is how later steps detect a change that matters to this Project and ignore one that does not.

## 2. The per-Project procedure

### Roles

- **The coordinating admin device** plans and commits. It must hold the admin secret, be in `M`, and map P to S itself. The reconciler needs a local mapping to the boundary (`recipient-policy-reconciler.ts:294-343`), and a device that does not share the Project gets none.
- **Every device in `M`**, the coordinating device included, adopts the committed boundary. The authors among them move their own memories.

### Additive storage

- Local table `project_boundary_migrations`, keyed by canonical project identity: boundary ID, source scope ID, group, role, state, generation, plan digest and JSON, source fingerprint, projection digest, the mapping rows it replaced, counters, lease columns, and a safe error code.
- Local table `project_boundary_migration_steps`, keyed by Project, generation, and step key. It follows `recipient_policy_reconciliation_steps`.
- New values in existing free-text columns: `project_scope_mappings.source = 'boundary_migration'` and `project_recipients.provenance = 'boundary_migration'`.
- Coordinator table for device reports, keyed by group and device.
- Coordinator table for migration records, keyed by group and boundary ID.
- `SCHEMA_VERSION` moves from 21 to 22 so the additive shim creates the local tables on open (`packages/core/src/db.ts:1137-1140`). No column or table is dropped, and no existing row is rewritten by the schema step.

### Migration record

The coordinator stores one record per boundary. A device-signed request reads it. Only the three operations below change it, and each runs as one coordinator transaction. The D1 store already uses atomic batches for account links.

A record holds:

- State: `committed`, `rolling_back`, or `rolled_back`, and a generation.
- Source scope ID, boundary ID, and the committing device.
- `Auth`, `M`, and `Names`.
- Each device's projection digest, and its `evidence_digest` at commit.
- The recipient edges chosen, as kind and ID.
- The source fingerprint and, when a review answer authorized the plan, the resolution's fingerprint.

**Commit.** The request carries the whole plan and each device's `evidence_digest`. The coordinator applies it only when all of these are true at that instant:

- No record exists for the boundary, or the existing record is `rolled_back`.
- The devices the coordinator would authorize in S equal the plan's `Auth`.
- Every device in `Auth` has a stored report whose `evidence_digest` equals the plan's value.
- The boundary scope does not exist, or has no active member outside `M`.

In the same transaction it creates the boundary scope if needed, grants each device in `M` the role it holds in S, and stores the record as `committed`. An identical request returns the stored record. A different plan for a committed boundary gets `409`, and so does any failed condition, with the condition named. Legacy Team completion uses the same first-writer contract (`docs/plans/2026-09-01-cross-device-legacy-team-completion-design.md`).

Because the grants are part of the commit, no request that arrives late can add a device. A request from an older plan fails its conditions or meets an existing record.

**Begin rollback** and **finish rollback** are described in [Section 6](#6-per-project-rollback).

### Choosing recipient edges

The migration needs edges whose derived device set equals `M` on the coordinating device, using `deriveRecipientPolicyEffectiveDevices`, the derivation the reconciler uses. It tries three candidates in order and takes the first exact match.

1. The Project's existing active edges, if it has any. Legacy Team setup wrote these for its Projects.
2. One Team edge, when exactly one active policy Team is linked to S's coordinator group.
3. One direct edge per Identity bound to a device in `M`.

When the Project has existing edges and they derive a different set, the migration stops at candidate 1 and the Project goes to review. Replacing what Projects shows without asking would hide the difference.

A Team edge means devices that later join the Team receive the Project. That matches what the default grant did for approved joiners. It is a property of the model the owner chose, and the invariant in [Section 3](#3-proof-of-no-widening) covers the device set at commit.

### Order of writes

Steps 1 to 3 run on the coordinating admin device. Steps 4 to 6 run on every device in `M`. Nothing outside the coordinating device's own database changes before step 2, and no memory moves before step 4.

| # | Step | Where | Atomic unit | A crash after it leaves | Resume |
| --- | --- | --- | --- | --- | --- |
| 1 | Plan: read the coordinator snapshot and reports, compute `M`, choose edges, run the reconciler's planning code against `M`, store the plan and the source fingerprint | Local | One `BEGIN IMMEDIATE` transaction | A plan row. Nothing outside this database. | Recompute the fingerprint. Discard the plan if it changed. |
| 2 | Commit | Coordinator | One transaction: conditions, boundary, grants, record | If the response was lost: a committed record this device has not applied | Send the same request. It returns the stored record. |
| 3 | Apply: write the chosen edges and the reconciler gate row, mark the local row committed | Local | One `BEGIN IMMEDIATE` transaction | Complete local policy. The mapping still points at S. | Go to step 4 |
| 4 | Adopt: save the device's exact mapping rows for P and replace them with one mapping to the boundary | Local, each device | One `BEGIN IMMEDIATE` transaction | New memories of P are stamped with the boundary. Older ones still carry S. | Go to step 5 |
| 5 | Move: restamp this device's own memories of P from S to the boundary | Local, each author | One transaction per memory, in batches of 200 with a yield between batches | Some memories under the boundary and some under S. Both scopes deliver them to the same devices. | Select what still carries S and continue |
| 6 | Publish the report with the record's progress | Coordinator | One report upsert | A stale report | Publish again |

Notes on individual steps:

- **Step 1.** The dry run calls the reconciler's planning code with the device set supplied by the migration, because the reconciler refuses a Project that has no mapping to a boundary yet. It must yield no grant and no revoke.
- **Step 2 rejected.** Nothing was written at the coordinator. The device discards the plan and plans again on its next pass, or raises the review item the condition names.
- **Step 4.** A device adopts only when all of these hold: its membership cache shows it authorized in the boundary, its recomputed projection digest equals the record's, and it still maps P to S with its own memories of P only in S. Otherwise it leaves its mapping and memories alone and republishes its report. Pattern mappings are untouched, because an exact mapping outranks a pattern. An admin device writes the reconciler gate in the same transaction, so its reconciler never sees the new mapping without the gate.
- **Step 4, devices that do not map P to S.** They change nothing. Giving them a mapping would start sharing memories they have never shared.
- **Step 5.** The move uses the delete-then-upsert behavior of `MemoryStore.reassignMemoryScope`, restricted to memories this device authored. Finding 6 explains why: a device in `M` restamps its copy, a device outside `M` keeps the copy it has, and no cleanup op deletes anything on a peer. The move waits while the device's sync state needs attention, as that function already requires.
- **Step 5, private memories.** They move with the rest. They were not delivered through S and are not delivered through the boundary.

### Handing authority to the reconciler

Step 3 writes the Project's `recipient_policy_authority_states` row with a gate. While the gate is set, the reconciler derives, snapshots, and computes its plan, and issues no grant, revoke, or deny overlay.

- An empty plan clears the gate. The existing `eligible` and `active` transitions then apply.
- A plan with effects, while the recipient tables are unchanged since commit, sets `parity_drift`. The gate stays, the boundary keeps the committed members, and the Project gets a review item.
- A plan with effects after the user changed recipients clears the gate. The user's change is the new intent.

Every admin device applies the same gate when it adopts a committed record. An admin device whose own Team and binding tables derive a different set never issues effects for that Project. It shows the recipients as read-only and names the device that committed.

## 3. Proof of no widening

### The invariant

For a Project P migrated without a review answer:

> For every memory of P that moves, the set of devices it can be delivered to after the move equals the set it could be delivered to before.

Before the move, a memory authored by a device `s` in `M` can reach every other device in `M`: `s` is paired with each of them and blocks none of them, and no other carrier in `M` blocks them either. It cannot reach a device in `X`, because every carrier blocks P for that device on ops and on snapshots. After the move, the memory can reach the boundary's members other than `s`. The commit makes the boundary's members equal `M = Auth − X`.

Memories of P that do not move stay under S with every filter still in force, so their delivery is unchanged too.

### The checks

| When | Check | On failure |
| --- | --- | --- |
| Plan (step 1) | The plan conditions in [Section 1](#computing-the-receive-set) hold. The chosen edges derive exactly `M`. The reconciler's planning code run against `M` yields no grant and no revoke. | No external write happens. The Project waits or goes to review. |
| Commit (step 2), inside the coordinator transaction | S's authorized devices equal the plan's `Auth`. Every report's `evidence_digest` equals the plan's. The boundary has no member outside `M`. The boundary's members after the transaction are exactly `M`. | Nothing is written. The device plans again. |
| Adopt (step 4), on each device | The device's recomputed projection digest equals the one in the record, and its mapping and own memories are still as planned. | The device keeps its mapping and memories under S and republishes. Its memories keep flowing under the old enforcement. The admin device raises a review item. |
| Reconciler gate | The reconciler's first plan is empty. | No effect is issued. The Project is marked `parity_drift` and gets a review item. |
| After commit, on every admin pass | For every device outside `M`, `held` for P's names is unchanged from the plan. Every device in `M` is still authorized in S. | The admin device raises `holdings_changed_outside_boundary` or `source_membership_changed` and offers rollback where it is allowed. |

Two properties hold by construction and are asserted in tests against a log of coordinator calls:

- The migration issues no grant, revoke, epoch change, status change, or filter write on any source scope.
- Only memories that already carry S move. Nothing in `local-default`, `legacy-shared-review`, or another scope is restamped.

### What the invariant does not cover

- **A review answer.** When the user chooses recipients in a review item, the device set is the user's decision and can be wider or narrower. The preview names every device that starts or stops receiving the Project.
- **Devices added later.** A new device of a recipient, or a new member of a recipient Team, receives the Project through the reconciler. That is the model working.
- **Copies delivered earlier.** A device outside `M` keeps what it already holds.
- **A change to S after commit.** If an older admin device removes a device from S after the commit, that device keeps receiving the migrated Project through the boundary. The Project is governed by its recipients from the commit on. The admin device raises `source_membership_changed` so the user can remove the recipient.

## 4. Ambiguity

### Conditions

A Project is not migrated and shows one review item when any of these holds. The item lists every reason that applies.

| Code | Condition |
| --- | --- |
| `multiple_source_scopes` | Devices map the Project to different coordinator scopes, or a device's own memories of the Project sit in more than one. |
| `filter_conflict` | Some carriers block the Project for a device and other carriers do not. |
| `excluded_device_sends` | A device that every other carrier blocks also shares its own memories of the Project. |
| `filter_splits_project` | A filter allows some of the Project's names and blocks others. |
| `devices_not_connected` | Two devices in `M` are not paired with each other. |
| `recipients_undetermined` | No candidate edge set derives exactly `M`. The item says why: a device has no person, a person has only some devices in `M`, a recipient Identity is pending, deactivated, or merged, or the existing recipients derive a different set. |
| `identity_conflict` | The coordinator enrollment of a device in `M` is bound to a different Identity than the local binding. |
| `boundary_has_other_members` | The Project's boundary already exists with an active member outside `M`. |
| `unsupported_source` | The scope has authority `manual` or `invite`, belongs to another coordinator or group, or has a deny overlay. |
| `project_identity_unstable` | The Project has no stable canonical identity, so its authors cannot compute one boundary ID. |
| `parity_drift`, `evidence_changed`, `holdings_changed_outside_boundary`, `source_membership_changed` | Raised after commit by the checks in [Section 3](#the-checks). |

The item's fingerprint covers the Project, the reasons, `Auth`, the reports' evidence digests, and the recipient tables. A changed fingerprint reopens a resolved item, as ADR 0001 Decision 4 requires.

### Waiting is different from ambiguity

These states ask nothing. They clear without a decision.

| Code | Shown as | Clears when |
| --- | --- | --- |
| `waiting_for_device_update` | Waiting for *device name* to update | That device publishes a report, or an admin removes it |
| `waiting_for_admin_device` | Waiting for a device that administers this Team | An admin device that shares the Project runs the migration |
| `waiting_for_coordinator_update` | Waiting for the coordinator to be updated | The coordinator advertises the capability |
| `waiting_for_team_setup` | Finish setting up this Team | The Team migration in ADR 0007 Decision 7 completes |
| `operation_in_progress` | Waiting for a share to finish | No share operation or Team setup draft is in flight for the Project |
| `sync_needs_attention` | Sync needs attention | The existing sync attention state clears |

### What the user is asked

The item appears in Projects on an admin device. On other devices it is a blocked item that names the admin device, as ADR 0001 Decision 4 specifies.

- **Title:** Review who receives *Project*
- **Body:** the reasons in plain language, then a table of devices with who each one receives the Project from today.
- **Keep it as it is.** Nothing changes. The Project stays on its current sharing setup. This is a completed answer and stays resolved until the fingerprint changes.
- **Choose recipients.** Opens the recipient controls with the closest candidate filled in. The preview lists each device that would start receiving the Project, each device that would stop, and each pair of devices that would start syncing with each other. For such a pair it says they will also exchange anything else both are already allowed to receive. Confirming runs the procedure with the chosen recipients, and the record carries the resolution's fingerprint.
- **Apply to the other Projects with the same devices and the same reasons.** Offered when more than one Project shares the cause. Each Project still gets its own record and its own resolution row.

`recipients_undetermined` caused by a device with no person links to the device assignment in Devices. Assigning the device changes the fingerprint, and the Project is planned again.

## 5. Who runs it

### The admin device

The migration runs in the sync daemon's maintenance pass, after the coordinator refresh, next to recipient reconciliation (`packages/viewer-server/src/application/coordinator-maintenance.ts`). It handles at most three Projects per pass and holds a per-Project lease. It runs when all of these hold:

- the rollout flag is `on` ([Section 9](#9-rollout))
- the device holds the admin secret and the coordinator advertises the capability
- the device is a member of the source scope and maps the Project to it

### Every other device

A device without the admin secret publishes its report, refreshes migration records with its membership cache, and adopts committed records. Until a Project is committed it syncs exactly as before.

- Projects shows the Project's recipients read-only, with a status badge from the waiting table.
- Recipient controls are disabled and say that an administrator's device applies changes, as ADR 0007 Decision 4 requires.
- The device runs steps 4 to 6 when it sees a committed record. Projects shows *Finishing on this device* while it moves memories.

### Devices on older versions

| Situation | Behavior |
| --- | --- |
| An older device is a member of a source scope | It publishes no report. Every Project in that scope waits, and nothing about its sync changes. The admin device names it and offers Remove device from ADR 0007 Decision 5. |
| An older admin device | It still grants the default scope on join and can edit scopes by hand. Before a commit, a change to S's members makes the commit's condition fail, and the plan is recomputed. After a commit, the boundary is unaffected. The change raises `source_membership_changed`, and rollback is refused while S differs from the record ([Section 6](#6-per-project-rollback)). |
| An older device added to a boundary later by the reconciler | It receives the Project as it would any shared Project. It holds no copy under S, so Finding 7 does not apply. |
| A migrated device downgraded to 0.49 | Its mapping to the boundary is an ordinary row and keeps working. It stops publishing reports and ignores a rollback, which then waits for it. |
| An older coordinator | The capability is absent. Nothing runs and every Project waits. A self-hosted coordinator is upgraded before its clients. |
| A device paired outside any coordinator group | Unaffected. It receives nothing from coordinator scopes today. |

An older device never gains access, because the commit grants a boundary only to devices whose reports the coordinator holds, and a report requires the new code.

## 6. Per-Project rollback

Rollback returns one Project to its source scope's enforcement. An admin device starts it from Projects, or from the CLI during the beta.

### When it is allowed

Rollback is the exact inverse only while nothing else has changed. **Begin rollback** is one coordinator transaction that moves the record from `committed` to `rolling_back` with a new generation, and it applies only when all of these are true at that instant:

- the boundary's active members equal the record's `M`
- the devices the coordinator would authorize in S equal the record's `Auth`
- every device in `M` either reports the projection digest the record holds for it, or has not reported on the record yet and still has the `evidence_digest` it had at commit
- no device in `M` reports `filters_cleared` ([Section 10](#10-decision-3-retirements))

If any fails, rollback is refused and says why. Returning memories to S after a recipient was removed would deliver them to that recipient again. After a recipient was added, it would cut them off. From that point the Project is governed by recipients and is corrected there.

### Order

1. The admin device begins rollback.
2. Each device that adopted restores the mapping rows it saved, in one transaction, and removes its mapping to the boundary. An admin device also marks its migration row so the reconciler skips the Project.
3. Each author moves its own memories that carry the boundary back to S, with the same function and batching as step 5. This includes memories written after the migration. Other devices restamp their copies as the updates arrive, and P1 lets a carrier's snapshot do the same.
4. Each device publishes its report with its progress.
5. When every device in `M` that adopted reports no own memories left in the boundary, the admin device sends **finish rollback**. In one transaction the coordinator revokes the boundary members that are not authorized in S and moves the record to `rolled_back`. The admin device then removes the edges it wrote with provenance `boundary_migration`, if their revision is unchanged.

A crash at any step resumes from the record's state and the local row.

Finish rollback leaves the other boundary memberships in place. A device deletes peer-authored rows in a scope it loses (Finding 2), and a memory whose author never returns can stay stamped with the boundary on other devices. Keeping the memberships keeps those copies readable. Nothing new is written to the boundary, because no device maps the Project to it. The members that stay are all authorized in S, so they receive nothing they would not receive there.

A boundary member that is not authorized in S exists only when a review answer added it. The previous enforcement gave that device nothing, so its membership ends and its copies under the boundary are deleted on that device.

### What rollback cannot undo

- Each memory's revision is higher, and the op log holds the moves. Content is unchanged.
- The boundary scope, the record, and the memberships of devices that are in S stay at the coordinator. A later migration of the same Project commits a new generation on top of them.
- A memory whose author adopted and then never returned stays stamped with the boundary on the devices that hold it.
- A device added by a review answer received data between commit and rollback. Its copies are deleted only if it cooperates. A device that never syncs again keeps them.
- Pairings created because the user approved connecting two devices are removed only if they were created by coordinator policy trust and the devices share no other boundary.
- The reconciler's effects on other Projects are untouched.

## 7. Multi-device ordering

**Two admin devices.** Both plan from the same coordinator state. The first commit wins. An identical plan from the second returns the same record. A different plan gets `409`, and the second device discards its plan and adopts the stored record like any other device. Both admin devices carry the reconciler gate, and only a device whose recipient tables derive the committed set issues effects. Team rosters are stored per device today, so the second admin device can stay read-only for that Project until ADR 0007's deferred coordinator roster exists.

**A member that upgraded, reported, and went offline.** The commit proceeds. On return the device refreshes its cache, reads the record, checks its projection digest, adopts, and moves its memories. While it is away its memories reach nobody, as before. If its filters changed in a way that matters to the Project, the digest differs and it keeps the old enforcement for its own memories until an admin answers the review item.

**A member that has not upgraded.** Every Project in its scope waits. Other scopes are unaffected. The admin device shows the device's name and last contact.

**A member that upgrades weeks later.** It publishes its report on first start. The admin device's next pass plans the waiting Projects. Nothing was migrated for that scope in the meantime, so the device sees one transition.

**A device that joins or leaves the source scope before the commit.** The commit's condition on S's members fails inside the coordinator transaction. A new device has no report, so the Project waits for it.

**A device that joins the group after commit.** It gets no access to migrated Projects from S, because their memories are no longer stamped with S. It receives them only as a recipient.

**An author that is offline when another device first pulls the boundary.** The pulling device can hold an older copy under S while a carrier holds the moved one. P1 lets the carrier's snapshot replace the older copy, because the record covers the move. The device does not have to wait for the author.

**Authors that no longer exist.** Memories a retired device authored stay under S on every device that holds them. Nobody can move them. They stay readable because S is never revoked or archived, and they stay withheld from excluded devices because filters stay in force for them ([Section 10](#10-decision-3-retirements)).

## 8. Upgrade test matrix

### How fixtures are built

No current test opens a database in an older shape. The existing pattern bootstraps the current schema and lowers `user_version` (`packages/core/src/db.test.ts:132-155`). The fixtures here create each generation's tables from DDL recorded at a tagged release, insert rows, and open the file with the current `MemoryStore` so the additive shim runs. `MIN_COMPATIBLE_SCHEMA` is 6, so the oldest fixture has the v0.19.0 shape.

Each fixture is a set of synthetic stores in a temporary directory. Each store has its own database, configuration file, and key directory. Fixtures that touch a coordinator use a real SQLite coordinator store behind the signed app, as `linkedLegacySetupFixture` does, and run again against D1. No test opens a real database, configuration, or running service.

### How access is measured

Each test drives `syncOnce` between the stores, as `packages/core/src/linked-legacy-setup-sync.test.ts` does. It records, per device and Project, the set of `import_key` values held. It runs the migration to quiescence, writes one new memory per author, syncs again, and compares. The scoped sync postmortem requires this kind of end-to-end assertion (`docs/plans/2026-05-25-scoped-sync-postmortem.md`).

Every fixture asserts the same four things after the migration: no device holds a key it could not receive before, no `import_key` has two rows, each device's search results for the Project are unchanged, and the coordinator call log shows no write to a source scope.

### Fixtures

| Fixture | Generation and shape | Access before | Expected after |
| --- | --- | --- | --- |
| `g1-peer-sync` | Original peer sync, schema 6. Two paired devices, a pairing filter with an include list, shared memories with no scope, no coordinator. | The backfill stamps shared memories `legacy-shared-review`. Nothing syncs. | Identical. No report, no record, no coordinator call. The filter is untouched. |
| `g2-coordinator-group` | Coordinator groups, v0.29.0. Three enrolled devices, a group filter template, discovered pairings, no scope tables. | Nothing syncs, because no memory carries a coordinator scope. | Identical. Each device publishes a report with no Projects. |
| `g3-default-scope-one-person` | Spaces, v0.30.0. One person, three devices, a `team_default` scope with the default grant on, two Projects with exact mappings, every pair paired, pairings marked as the same person. | Each device receives both Projects from the other two. | With P4: two boundaries, each with the same three devices and one direct edge, all memories moved, the default grant stopped. Without P4: `recipients_undetermined`, access unchanged. |
| `g3-team-scope-filter` | Spaces. Two people with two devices each, kind `team`, a pattern mapping that covers four Projects. The first person's devices block Project 3 for both devices of the second person, and block Project 4 for one of them. | Projects 1 and 2 reach all four devices. Project 3 reaches two. Project 4 reaches three. | Boundaries for Projects 1 and 2 with four devices. A boundary for Project 3 with the first person's two devices. Project 4 gets `recipients_undetermined`, because the second person has one of two devices in `M`, and its access is unchanged. |
| `g3-filter-conflict` | Spaces. Three devices of one person. One device blocks a Project for the third, and the second device does not. | The third device receives the Project from the second device only. | `filter_conflict`, access unchanged. |
| `g3-org-client-unpaired` | Spaces. Kinds `org` and `client`, three devices, two of which never paired. | Each of the two receives only from the third. | `devices_not_connected`, access unchanged. After the user chooses recipients: one boundary with three devices, and the two devices pair. |
| `g3-legacy-review-rows` | Spaces. One Project with memories in a `team` scope and older memories in `legacy-shared-review`. | The `team` memories sync. The older ones do not. | The `team` memories move. The older ones stay withheld, and their count is unchanged. |
| `g3-retired-author` | Spaces. Three devices. Two block a Project for the third. One of the two holds a memory of that Project authored by a device that no longer exists. | The third device holds nothing of the Project. | A boundary with two devices. The retired author's memory stays under the source scope. After the second pass the filter for that Project is still in place, and a fresh snapshot of the source scope gives the third device nothing of it. |
| `g4-team-setup` | Recipient policy, v0.43.0. Legacy Team setup completed: a policy Team, device decisions, a mapping to a `team` scope, Team edges nothing enforces, authority state `legacy`. | Every Team device in the scope receives the Project. | A boundary with the same devices. The existing Team edge is kept. The gate clears after an empty reconciler pass. This is the acceptance case of `codemem-hksk.6`. |
| `g4-recipients-differ` | As above, after the user removed one person from the recipients shown. | That person's devices still receive the Project. | `recipients_undetermined` with the difference shown. Access unchanged. |
| `g4-existing-boundary` | Recipient policy. A Project already shared through a share operation. | Its boundary's members receive it. | Identical. No record. |
| `g4-in-flight` | Recipient policy. A share operation in `provisioning` and an unfinished Team setup draft. | As the source scope allows. | `operation_in_progress`, access unchanged. |
| `g5-account-era` | Account era, v0.47.0 to v0.49. Enrollments carry Identity IDs, device binding rows, and key evidence. | Every bound device in the scope receives the Project. | A boundary with the same devices. |
| `g5-identity-conflict` | Account era. One enrollment is bound to a different Identity than the local binding. | That device receives the Project. | `identity_conflict`, access unchanged. Without the dry run the reconciler would have revoked the device. |
| `g5-older-coordinator` | Account era, with a coordinator on the older account schema and no migration capability. | As the source scope allows. | `waiting_for_coordinator_update`, access unchanged. |
| `mixed-older-member` | `g4-team-setup` with one device that publishes no report. | As above. | `waiting_for_device_update`, access unchanged. |

## 9. Rollout

### The flag

One configuration key, `sync_boundary_migration`, with the environment override `CODEMEM_SYNC_BOUNDARY_MIGRATION`:

- `off`: the default in the first betas. The tables exist and nothing runs.
- `report`: the device publishes its report. An admin device computes plans and stores them locally with their classification. It sends no commit and makes no local change.
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

- **In `report`:** per Project, the classification (automatic, each ambiguity code, each waiting code), the size of `Auth`, `X`, and `M`, the edge candidate chosen, and how often the source fingerprint changes from day to day. Per scope, the days until every member has reported. The count of `devices_not_connected` decides open question 1.
- **In `on`:** per Project, commits rejected by each condition, the time from commit until every device has adopted, memories moved per device, `held` before and after on every device, rows per `import_key`, the result of the reconciler's first gated pass, and `sync_scope_rejections`. Per install, review items opened and how each was answered.

### Condition for turning it on by default

All of these hold:

- The upgrade matrix and the tests in the [test plan](#test-plan) pass in CI, for SQLite and D1.
- The owner's machines ran `on` for 14 days and covered: a `team_default` scope, a scope with several Projects, a filter that removes a device from a boundary, a review item answered each way, a device offline for more than 48 hours across a commit, a device that upgraded after the others, and one rollback followed by a second migration.
- No device outside a boundary changed its `held` counts for that Project.
- No `import_key` has more than one row on any device.
- Every reconciler gate cleared with an empty first plan, or was explained by a recipient change the owner made.
- Search results for migrated Projects were the same before and after on every device.
- The corrected design has had the security review ADR 0007 requires for this change, and the owner has accepted the open questions.
- The manual check of a large database that the scoped sync postmortem made a release gate has been run on a migrated install.

## 10. Decision 3 retirements

Decision 3 has four parts with different risk. They cannot all run in the same pass.

| Part | When | Why |
| --- | --- | --- |
| Convert each pairing filter's effect into boundary membership | In the migration pass | It is part of computing `M`. |
| Stop the default grant on join | In the migration pass, per group, once every Project in the group's default scope is committed or has a review item | The grant is a membership in the source scope. After the first commit, a new joiner would receive Projects that are still in review and would not appear as their recipient. The approving device clears its own preference row. An older admin device can still grant until it upgrades. |
| Clear a filter and stop reading the global filter keys | A second pass on each device, per filter, under the conditions below | Until then the filter is the only thing withholding memories that still carry a source scope. |
| Delete the filter columns, the group filter template, `syncProjectAllowed`, the default scope, and its preference | One release later, and only where no filter remains | The constraint is additive schema only. Devices still migrating need the check. Older peers still evaluate filters. |

### When a device may clear a filter

A device clears the filter it stores for a peer only when the filter no longer withholds anything from that peer on any path. For every Project the filter blocks, all of these must hold:

- The Project is committed, no review item is open for it, and the rollback window has passed.
- The peer is outside the Project's boundary.
- This device holds no shared memory of that Project, authored by anyone, in a coordinator scope the peer is authorized in.

The third condition covers snapshots. A memory that stays under the source scope is still served to every authorized member of that scope, and the filter is what keeps it from the excluded peer. Memories from a retired author stay there permanently (Section 7). Where such a memory exists, the filter stays, and the device reports why. Clearing a filter sets `filters_cleared` in the device's report and ends rollback for the Projects it blocked.

A filter that blocks nothing the peer could otherwise receive is cleared without these checks.

This means some installs keep a filter after 0.50, and the deletion in the following release cannot be unconditional. Open question 7 covers what replaces the filter for those memories.

Source scopes are not archived in either release. Finding 2 shows that archiving hides and deletes the memories that still carry the scope. Archiving needs its own design.

`codemem-lvgba.28` therefore splits in two: the second pass in 0.50 after the beta soak, and the deletions in the following release.

One invisible path is outside Decision 3: a pattern mapping into a source scope keeps stamping new Projects there. The migration picks each one up on its next pass. Removing the pattern rows belongs with the second pass.

## Test plan

The implementer writes these before the code. The first group pins behavior the design depends on and is expected to pass today. The rest fail until implemented.

### Current behavior the design depends on

1. `sync-replication`: after `reassignMemoryScope`, the source-scope `delete` is not sent to any peer, and a peer in only the source scope keeps its copy.
2. `sync-replication`: a peer in both scopes that receives the `upsert` restamps its one row.
3. `sync-replication`: a device that loses authorization in a scope deletes peer-authored rows there and keeps its own.
4. `sync-replication`: a scoped snapshot includes memories the serving device did not author and applies the serving device's filter for the requesting peer.
5. `coordinator-runtime`: two devices that share a `managed_project` scope are paired by policy trust, and that pairing then carries a `team` scope both are members of.
6. `recipient-policy-reconciler`: on its first pass the reconciler revokes a current member that has no Identity binding.

### Prerequisites

7. `sync-bootstrap` (P1): a device that holds a memory under the source scope and pulls the boundary snapshot from the author ends with one row, stamped with the boundary.
8. `sync-bootstrap` (P1): with a committed record, a device that holds an older copy under the source scope and pulls the boundary snapshot from a carrier that is not the author ends with one row, at the carrier's revision, with the origin device unchanged.
9. `sync-bootstrap` (P1): without a record, a snapshot item whose `import_key` exists under another scope with a different origin device is skipped. With a record for another Project it is also skipped.
10. `recipient-policy-reconciler` (P2): with the gate set and a non-empty plan, no coordinator effect is issued and the state is `parity_drift`.
11. `recipient-policy-reconciler` (P2): an empty plan clears the gate. A plan after a recipient change clears it and issues effects.
12. Coordinator store contract (P3), SQLite and D1: a report is accepted only from its own device key and within size limits.
13. Coordinator store contract (P3), SQLite and D1: commit creates the scope, the memberships, and the record together. An identical commit returns the record. A different plan gets `409`.
14. Coordinator store contract (P3), SQLite and D1: commit writes nothing when a device was revoked from the source scope after the plan was read, when a report's evidence digest changed, or when the boundary has a member outside the plan.
15. Coordinator store contract (P3), SQLite and D1: a commit request from an earlier plan that arrives after another plan committed adds no membership.

### Planning

16. The receive set equals the coordinator's members minus devices every carrier blocks.
17. A device that only received a Project's memories counts as a carrier, and its filter decides exclusion with the authors'.
18. One test per ambiguity code in [Section 4](#conditions), each asserting no coordinator write.
19. A member with no report yields `waiting_for_device_update`.
20. Edge candidates are tried in order, and existing edges that derive a different set stop the search.
21. The source fingerprint changes when a member, a report, or a recipient row changes.

### Procedure and crash recovery

22. One test per row of the [order of writes](#order-of-writes): stop after the step, restart, and reach the same end state.
23. A rejected commit leaves no scope, no membership, no record, and no local change.
24. The coordinator call log for a full migration contains no write to a source scope.
25. A device whose projection digest changed does not adopt, and its memories keep flowing under the source scope. A filter change for an unrelated Project does not stop adoption.
26. A device that does not map the Project to the source scope gets no mapping.
27. Memories in `legacy-shared-review` and `local-default` are not moved.

### End to end, through `syncOnce`

28. The fixture matrix in [Section 8](#fixtures), one test per row.
29. A device that a filter excluded holds the same keys before and after, including after authors write new memories and after it pulls a fresh snapshot of the source scope.
30. A partly moved Project delivers every memory to the same devices as before.
31. Two admin devices plan the same Project. One commits, the other adopts, and neither reconciler issues an effect.
32. A member offline across the commit adopts on return and ends with one row per key.
33. A device removed from the source scope after commit raises `source_membership_changed`.

### Rollback

34. Rollback restores each device's saved mappings and returns every memory to the source scope. Per-device holdings equal the pre-migration holdings plus memories written since.
35. Begin rollback is refused after a recipient is added or removed, after the source scope's members change, and after a device clears a filter.
36. After finish rollback, a device that holds a peer-authored memory still stamped with the boundary can still read it.
37. Finish rollback revokes a device that a review answer added and no device that is authorized in the source scope.
38. A second migration after a rollback commits a new generation on the existing boundary.

### Decision 3

39. With migration on, approving a join request grants no default scope once the group's Projects are committed or in review.
40. The second pass keeps a filter while the device holds a memory of the blocked Project in a scope the peer is authorized in, including a memory from a retired author.
41. The second pass keeps a filter that blocks a peer inside a boundary.

Validation for each stack layer is the focused tests above. The stack tip runs `pnpm run check` and the Docker scenarios `legacy-team-migration`, `project-sharing`, and `sharing-domains`.

## Open questions for the owner

1. **Unpaired devices.** The design treats two authorized devices that never paired as an ambiguity, because a boundary would start sync between them (Finding 5). The alternative is to treat coordinator authorization alone as access and let them connect without asking. That asks fewer questions and lets data flow that never flowed directly. The `report` stage will show how many Projects are affected.
2. **Waiting for every device.** One device that never upgrades holds back every Project in its scope until an admin removes it. The alternative, migrating around it, puts 0.49 devices in boundaries while they hold copies under the source scope, which Finding 7 says duplicates memories on code that cannot be fixed remotely.
3. **Reports at the coordinator.** The coordinator would store, per device, its pairing list within the group, its filters as keyed hashes of project names, and counts of what it holds. It already knows device IDs and group membership. Project names are guessable from the hashes. Is that acceptable for hosted and self-hosted coordinators?
4. **Admin devices that do not share a Project.** Such a device cannot migrate that Project, because the reconciler needs a local mapping. If the only admin device does not share a Project, the Project waits.
5. **Team edge for a default scope.** When one Team is linked to the group and derives exactly `M`, the migration records a Team edge, so later Team members receive the Project. Direct edges per person would avoid that inheritance and would also drop what the default grant did for joiners.
6. **A filter that blocks one device of a recipient.** ADR 0007 says such a filter becomes the device's absence from the boundary. It also says a boundary's members are the devices of the Project's recipients and nothing else removes one. The reconciler would add the device back. The design sends this case to review, where the user either includes the device or stops sharing with the person. A per-Project device exclusion would make the conversion automatic and would add a second rule about who receives a Project.
7. **Filters that can never be cleared.** A device that holds a retired author's memories of a blocked Project keeps its filter indefinitely, so the filter columns and the sync-time check cannot be deleted everywhere. Three options: keep the check for memories that still carry a source scope, stop serving such memories in snapshots to devices outside the Project's boundary, or let the user delete or adopt those memories.
8. **Filters after a review answer.** When the user's answer includes a device that some carrier's filter blocks, that carrier keeps blocking it until the second pass clears the filter. The screen shows a recipient that receives less than the screen says, for that interval.
9. **Two admin devices with different rosters.** The second stays read-only for migrated Projects until rosters match. Is that acceptable before the coordinator-held roster exists?
10. **Source scopes are never archived, and rolled-back boundaries keep their members.** Both exist to keep memories readable. Accept for 0.50 and the following release?
11. **A manual change to a source scope after commit** does not reach the migrated Project. The design raises a review item. Should the admin device apply the removal to the recipients instead?
12. **Length of the rollback window** before the second pass may clear filters. The design proposes 14 days after the last commit on the install.

## Review record

One adversarial review pass ran on 2026-11-16 with a model from a different vendor, on the concern "find a sequence of states where this migration gives a device access it did not have, or silently removes access a device should keep". The reviewer traced each sequence through the source and the draft procedure. It ran no tests. Its verdict on the draft was to request changes. The changes below were made afterward and have not been reviewed again.

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | Clearing filters exposes memories left in the source scope. A device outside the boundary can pull a snapshot of the source scope and receive a retired author's memory that the filter used to withhold. | Fixed. A filter is cleared only when the device holds no memory of the blocked Project in a scope the peer is authorized in ([Section 10](#when-a-device-may-clear-a-filter)). Fixture `g3-retired-author` and tests 29 and 40 cover it. The consequence is open question 7. |
| 2 | A grant request from an expired claim could arrive after another admin device committed a different plan, and the coordinator would accept it. | Fixed. The draft's separate claim, grant, verify, and commit steps are replaced by one coordinator transaction, and the migration issues no separate grants ([Migration record](#migration-record)). Test 15 covers it. |
| 3 | A device revoked from the source scope between verify and commit stayed in the boundary. | Fixed. The commit is conditional, inside the coordinator transaction, on the source scope's authorized devices and on every report. Test 14 covers it. A revoke after commit is outside what a transaction can cover and is recorded as `source_membership_changed` and open question 11. |
| 4 | The draft of P1 accepted a cross-scope snapshot item only from the memory's author, so a carrier could no longer deliver a newer revision while the author was offline. | Fixed. P1 also accepts the item when a migration record covers the move. Test 8 covers it. |
| 5 | Suspected: rollback revoked boundary memberships before received copies had returned to the source scope, which would hide and delete them. The draft's rollback check also compared a digest that adoption itself changes. | Fixed. Finish rollback revokes only members that are not authorized in the source scope. Rollback compares per-Project projection digests, which adoption does not change. Tests 36 and 37 cover it. |
| 6 | Suspected: a device that only received a Project's memories had no entry in the device report, so the planner could not treat it as a carrier. | Fixed. The report lists holdings per scope and project name for every memory the device holds, and carries filters as name hashes so the planner evaluates them for any Project. Test 17 covers it. |

The reviewer reported no premise in the findings list that the source contradicts. It could not check the proposed coordinator operations or P1 and P2 as code, because none exists yet.
