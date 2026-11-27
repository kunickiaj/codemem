# Coordinator readiness records

**Scope:** Storage and the device-signed request for readiness records, which the
per-Project boundary migration uses
([design](../plans/2026-11-16-per-project-boundary-migration-design.md)). No build
sends a record yet, and nothing reads the records to make a decision. A record
grants no access.

## Generation-bound device evidence (version 2)

The device client can construct and sign a version 2 request for one configured
coordinator group. No runtime calls this client yet. The coordinator accepts
version 2 only for a current preparation. The local `sync migration status` command does not call
either sender.

The future caller supplies the generation issued by the coordinator (a fresh
UUIDv4 for each preparation), the revision of the successful group refresh it
observed for that generation, and an increasing inventory sequence. If another
refresh finishes before collection, the device must collect again. A revision
identifies a local cache update. It does not prove that the coordinator still
authorizes a device.

The refresh records `group_generation` only if the signed GET to the configured
HTTPS coordinator returns that generation on the catalogue and every member
snapshot. Redirects are refused. An older coordinator that omits the generation
still supports ordinary sync, but its responses cannot supply readiness.
The cache updates the observed generation in the same transaction as the
membership data and revision. A legacy writer that refreshes the cache clears
the observation. After hashing the key, the sender reads the generation and
revision again immediately before signing. If either no longer matches, it
returns `recollect_required` without posting. The caller must start a new
collection for the current refresh.

The request uses the existing signed POST and includes these fields alongside
`sequence`, `omitted_projects` and `projects`:

| Field | Signed value |
| --- | --- |
| `version` | `2` |
| `coordinator_id`, `group_id` | Configured authority and group for this refresh |
| `device_id`, `key_id` | Local device ID and canonical SHA-256 ID of its Ed25519 public key |
| `group_generation`, `scope_refresh_revision` | Coordinator generation and local refresh revision |
| `filter_evidence` | `none`, `present` or `unknown` |

The device reads its identity, group inventory and stored filters in one SQLite
transaction. It reports `present` for a restriction on any pairing, retained
override, active pairing template or effective config/environment fallback.
Pairings can cross groups, so the scan covers the whole device. Missing storage
or malformed evidence gives `unknown` unless another source already shows a
restriction. No filter list travels in the request. A device with zero locally
authored rows still reports its restrictions.

The future sender must read configuration and environment fallbacks **in the
process that serves sync requests**, using the same config path and overrides
as that process. A CLI or background process with a different environment
cannot attest to the serving process's filters. Any nonempty stored list counts
as a restriction, including a whitespace-only include list that blocks sharing
during provisioning.

An empty `projects` list does not say that the device cannot receive a Project.
The coordinator must derive the affected receivers from admission and request
their evidence too. Inventory counts alone do not prove equivalent access.

The sender requires migration mode `on`, enabled sync and the configured HTTPS
coordinator. It verifies its signature against the public key from the snapshot
before sending. A stored or stale acknowledgement must echo the protocol
version, group, device, key and generation. A version 1 reply cannot acknowledge
version 2. There is no retry with a weaker protocol.

The coordinator must verify the signature against the **current enrolled key**
and check the generation when it writes and when it uses a record. That
server-side check and the direct-serving fence are separate changes. A valid
signature or a successful HTTP response alone does not make a Project eligible
for migration.

A readiness record is what a device that runs the migration code keeps at the
coordinator, one per group. It says two things: the device handles a Project that
has its own boundary, and these are the Projects it holds under an older scope
with the boundary each one needs.

## Request

`POST /v1/boundary-readiness?group_id=<group>`, signed with the device key like
every other device request. The device is the one whose key signed the request.
A body that names another `device_id` or `group_id` is refused.

```json
{
  "version": 1,
  "sequence": 12,
  "omitted_projects": 0,
  "projects": [
    {
      "source_scope_id": "team:g1:default",
      "boundary_scope_id": "managed-project:<64 hex characters>",
      "state": "waiting",
      "own_rows_in_source": 412,
      "own_rows_in_boundary": 0
    }
  ]
}
```

- `sequence` rises with every change the device makes to its record.
- `state` is `waiting`, `adopted`, or `rolled_back`.
- A record with no Projects is valid.
- A Project can appear once per source scope.

## Answers

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{"version":1,"status":"stored","sequence":12,"rejected":[]}` | Stored. `rejected` names the entries the coordinator left out. |
| 200 | `{"version":1,"status":"stale","sequence":15}` | The stored record is as new or newer. `sequence` is the stored one, so a device that lost its counter can move past it. |
| 400 | `readiness_record_invalid`, `readiness_version_unsupported`, `device_id_mismatch`, `group_id_mismatch`, `group_id_required`, `invalid_json` | Nothing stored. |
| 401, 403, 409 | The usual signed-request errors | Nothing stored. |
| 413 | `body_too_large`, `boundary_readiness_too_large` | The record is over the size limit. The stored record stays. |
| 503 | `boundary_readiness_unavailable` | The coordinator's database has no readiness storage yet (migration `0050`), a scope's authorization could not be read, or the write failed. The stored record stays. |
| 404 | | A coordinator from before this route. A device reads it as "not updated yet". |

An entry is stored only when both of these hold. Otherwise it is listed in
`rejected` with the reason, and the rest of the record is stored.

- The boundary ID has the managed Project form (`boundary_scope_invalid`).
- The device is authorized in the source scope when the record arrives, by the
  same read that authorizes scope sync (`source_scope_not_authorized`).

A read that could not run is not a refusal. The coordinator then stores nothing
and answers 503, and the device sends the record again.

## Size limit

A record has two limits. Its `projects` take at most 256 KiB as compact JSON in
UTF-8, which is about 1,300 Projects and fewer with long IDs. It names at most 64
source scopes, because each one the device is a member of costs an authorization
read. The request body limit is the size limit plus 4 KiB. The store and the
request use the same numbers, so a record a device can build always fits one
request. Presence requests keep their 64 KiB limit, which is why a record does
not travel in the presence body.

A device with more Projects than fit sends the ones that fit and the number it
left out as `omitted_projects`. `fitBoundaryReadinessProjects` in
`packages/core/src/coordinator-boundary-readiness.ts` is the cut both sides use.

## What a record does not show

Reading a record returns three facts about what it leaves out.

| Field | Meaning |
| --- | --- |
| `omitted_projects` | Projects the device left out to fit the limit. |
| `invalid_boundary_entries` | Entries left out for a malformed boundary ID. A correct build sends none. |
| `unauthorized_source_scope_ids` | Source scopes the record named and the device was not authorized in when it arrived. |

`complete` is false when either count is above zero. A record that is not
complete shows that the device runs the migration code and nothing about what it
holds. It must never be read as "the device does not hold the Projects it left
out".

## Discard on presence

`POST /v1/presence` removes the device's record for that group when the presence
does not list the sync feature `project_boundary_migration_v1`. That is what a
downgraded device sends. The record is removed before the presence is stored. If
the removal fails, the request fails and no presence is stored, so the device
tries again and an older build is never left with a record that says it is ready.

After a discard the coordinator accepts a first legacy sequence again. For
version 2 it retains the last accepted sequence and refresh revision for the
generation, so a delayed report cannot restore discarded evidence.

## What a reader of the records must do

- A device is checked against the source scope when its record arrives. It can
  leave the scope afterwards, and its record stays until the next one. A reader
  counts only records of devices that are authorized in the source scope at the
  moment it decides.
- Removing a device or an enrollment does not delete its record. The same rule
  covers it.
- A device whose record is not complete is treated like a device with no record
  when a boundary is created: every Project of each source scope it is authorized
  in waits. Attaching to an existing boundary only needs to know that the device
  runs the code, so it accepts such a record.
- A record is also treated as not complete when the device is authorized, at the
  moment of the decision, in one of its `unauthorized_source_scope_ids`.
- A record sent just before a downgrade can arrive after the discard. A reader
  counts a record only when the device's stored presence lists the feature.

The reader's own SQL must apply these rules in the transaction that decides. The
design lists them as tests 63 to 66.

## Device inventory

`buildBoundaryReadinessInventory` reads one consistent snapshot of local mappings,
stored repository identities and the device's own active memories. It does not
probe checkouts, create schema, modify mappings or send requests.

- Exact mappings count even when no memories exist. Pattern mappings are resolved
  against locally recorded Projects, without a Viewer page limit.
- Own active memories also supply workspace IDs when the session has no checkout
  or repository identity. They use the same mapping resolver and identity precedence.
- Unstamped memories supply identity evidence without contributing to source or
  boundary counters. Scope selection matches the recorded cache authority ID,
  including explicit non-URL IDs and the local coordinator's `local` ID.
- Own rows under an older scope count even when the mapping has changed. Private
  rows count because they move with the Project while remaining private. Inactive,
  deleted and peer-authored rows do not count.
- The caller supplies recorded local adoption or rollback observations. The
  builder does not infer adoption from a copy arriving under the boundary.
- The shared fitting helper applies the byte and source-scope limits and returns
  the omitted count.

Unidentified or ambiguous own-source identities make the build fail. A future
sender must then post presence without the migration feature for that group, so
the previous record is discarded. It must not leave an older complete record
available while inventory is unknown.

## Storage

Migration `0057_bind_boundary_readiness.sql` adds the coordinator audience to
the group and a binding for the last accepted v2 record. The signed request
names its HTTPS coordinator, group, device, key, generation and refresh
revision. The write checks the active generation and the enabled, unrevoked
enrollment inside the same transaction as the inventory update. A stale or
mismatched request cannot replace the inventory. No production operation
starts a preparation.

`getVerifiedBoundaryReadiness` checks the same audience, generation and key
while reading the binding, header and Projects in one transaction. Legacy
replacement and discard break the record ID match. A future cutover must
repeat these checks in its own deciding transaction. A successful response to
the device does not authorize a cutover or grant access.

Tables `coordinator_boundary_readiness` (one row per group and device) and
`coordinator_boundary_readiness_projects` (one row per entry), added by migration
`0050_add_boundary_readiness.sql` and by SQLite coordinator startup. The shared
contract tests run on the SQLite store, on a better-sqlite3 D1 stand-in, and on
native Worker D1.

### Enrollment changes invalidate a group generation

Migration `0056_add_readiness_preparations.sql` adds `groups.readiness_generation`.
NULL means there is no active preparation. No runtime creates one in this release.
Neither a generation nor a readiness report grants access.

The SQLite coordinator clears the generation in the enrollment transaction. On
D1 the Worker clears it with a separate statement in the same `batch()`. Writers
read the receipt at the enrollment statement's own position. In particular, a
key rewrite with a separate reset has two one-row receipts. A multi-group
enrollment or removal checks the actual number of enrolled rows.

| Enrollment writer | Groups invalidated |
| --- | --- |
| `POST /v1/admin/devices` and local admin enrollment | The named group, after insert, update, or key-ID reset and rewrite. |
| Legacy auto-admit `POST /v1/join` | The same enrollment writer, with the invitation pinned. An already-enrolled reply and a pending join request do not write an enrollment. |
| The `rename`, `disable` and `enable` routes under `/v1/admin/devices/` | The named group when an enrollment matches. This includes label edits and re-enabling a device. |
| `/v1/admin/join-requests/approve` | The request's group in the same transaction as the approved enrollment. A failed confirmation rolls back the write. Denial does not write enrollment. |
| Team, add-device and Project acceptance via `/v1/join` | The invitation's group on fresh insert or update, and on repair of a missing identity during retry. Grant-only recovery does not invalidate it. On D1 the fresh acceptance clears the one matching group even if its generation is already NULL, so the next bootstrap statement still sees the enrollment winner's `changes()` value. |
| Owner enrollment (`/v1/auth/owner-attempts/finalize`) | Each grant group pinned by the finalized attempt, after the enrollment count matches the number of grants. |
| Device claim completion, including first link (`/v1/auth/link-attempts/:attemptId/finalize`) | A new ownership binding invalidates every enrolled group for that device. Reusing a binding invalidates only groups where the claim filled a missing enrollment identity. |
| Device rebind and self-bind (`/v1/auth/rebind-attempts/:attemptId/finalize`) | Every enrolled group for the device in the winning attempt, even when every enrollment already names the identity. |
| Device rejoin (`/v1/auth/rejoin-attempts/:attemptId/finalize`) | The groups restored by the winning receipt. |
| Legacy `/v1/admin/devices/remove` and local single removal | The removed enrollment's group and the current group of each scope whose membership this removal revoked. |
| `/v1/admin/devices/removal` and local expanded removal | Each group with a tombstone written by this removal and the current scope groups of its revoked memberships. A preview does not invalidate anything. |
| `/v1/admin/devices/key-id-fill`, peer removal lookup, and SQLite startup | Groups containing rows of the filled page that still match the captured row ID, public key and derived key ID. A page that writes nothing invalidates nothing. |
| Group archive and unarchive (`/v1/admin/groups/archive`, `/v1/admin/groups/unarchive`) | The group whose archive state changed. A group name change has no effect. |
| Team member removal and Team-to-group binding | The named group when the removal or binding is inserted. This includes the first binding created while minting a Team invitation. A replay or conflicting binding does not clear a new preparation. |
| Scope membership grant and revoke | The scope's current group when the mutation writes an audit row. Legacy memberships may inherit that group. A replay or a revoke with no matching membership does not clear a preparation. |
| Scope policy update | The old and new groups when a policy field changes. A label edit, an unchanged policy, or an update that loses to a concurrent change preserves the generation. |
| Scope creation | The destination group when the insert succeeds. A duplicate scope does not invalidate a fresh preparation. |
| Coordinator-wide device revocation, from enrollment or removal evidence | A newly revoked device ID invalidates every group containing that ID. A newly revoked canonical key invalidates groups containing that key under any ID, and groups with unfilled key IDs where a match cannot be excluded. Existing revocation subjects do not invalidate a fresh preparation on retry. |

Older admin clients call these same coordinator paths. An older **coordinator
binary** that writes the database directly does not clear the column. A later
release must exclude such writers before starting any preparation. Deleting a
group deletes its generation with it.
