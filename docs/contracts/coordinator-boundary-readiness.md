# Coordinator readiness records

**Scope:** Storage and the device-signed request for readiness records, which the
per-Project boundary migration uses
([design](../plans/2026-11-16-per-project-boundary-migration-design.md)). No build
sends a record yet, and nothing reads the records to make a decision. A record
grants no access.

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
| 503 | `boundary_readiness_unavailable` | The coordinator's database has no readiness storage yet (migration `0050`), or the write failed. |
| 404 | | A coordinator from before this route. A device reads it as "not updated yet". |

An entry is stored only when both of these hold. Otherwise it is listed in
`rejected` with the reason, and the rest of the record is stored.

- The boundary ID has the managed Project form (`boundary_scope_invalid`).
- The device is authorized in the source scope when the record arrives, by the
  same read that authorizes scope sync (`source_scope_not_authorized`).

## Size limit

The limit is the UTF-8 size of `projects` as compact JSON: 256 KiB, about 1,300
Projects. The request body limit is that plus 4 KiB. The store and the request
use the same number, so a record a device can build always fits one request.
Presence requests keep their 64 KiB limit, which is why a record does not travel
in the presence body.

A device with more Projects than fit lists the ones that still wait first, sends
the ones that fit, and sends the number it left out as `omitted_projects`. The
coordinator stores that number. The device then counts as having a record, and an
admin device can see that some of its Projects are not listed yet. Projects that
have moved drop out of a device's list, which brings the omitted ones into a
later record. `fitBoundaryReadinessProjects` in
`packages/core/src/coordinator-boundary-readiness.ts` is the cut both sides use.

## Discard on presence

`POST /v1/presence` removes the device's record for that group when the presence
does not list the sync feature `project_boundary_migration_v1`. That is what a
downgraded device sends. The record is removed before the presence is stored. If
the removal fails, the request fails and no presence is stored, so the device
tries again and an older build is never left with a record that says it is ready.

After a discard the coordinator accepts a first sequence again.

## What a reader of the records must do

- A device is checked against the source scope when its record arrives. It can
  leave the scope afterwards, and its record stays until the next one. A reader
  counts only records of devices that are authorized in the source scope at the
  moment it decides.
- Removing a device or an enrollment does not delete its record. The same rule
  covers it.

## Storage

Tables `coordinator_boundary_readiness` (one row per group and device) and
`coordinator_boundary_readiness_projects` (one row per entry), added by migration
`0050_add_boundary_readiness.sql` and by SQLite coordinator startup. The shared
contract tests run on the SQLite store, on a better-sqlite3 D1 stand-in, and on
native Worker D1.
