# Multi-Team Coordinator Groups

**Status:** Design
**Date:** 2026-04-22
**Supersedes guidance in:** codemem-cbfk (product-model clarification), codemem-16p5.8 (multi-coordinator UI deferral)

## Problem

Today a device belongs to at most one meaningful coordinator context at a time. Users with multiple collaboration scopes (for example: **personal**, **work**, and **coworker** teams) cannot cleanly represent them in codemem:

- The admin UI treats the configured coordinator as a single global context.
- `sync_peers` rows are flat — there is no first-class notion of "this peer came from team X."
- `projects_include_json` / `projects_exclude_json` exist per-peer but must be maintained by hand for every new pairing, so team-level defaults drift.
- There is no way to express "these three teams exist, and my project foo syncs only with team A, project bar only with team B, project baz with both" without clicking through every peer one by one.

This matters because the canonical multi-team shape is concrete and common:

- **Personal** device holds everything.
- **Work** device holds work projects.
- **Coworker** device holds *specific* shared-with-work projects.
- Personal ↔ Work: sync most projects.
- Work ↔ Coworker: sync the shared-with-work projects only.
- Personal ↔ Coworker: no sync at all.

None of the existing primitives are wrong — coordinator groups, peer-scope filters, and the principle "group membership is not automatic sync" all still hold. What is missing is a coherent product model that binds them together so a user can think in teams rather than in individual peers.

## Scope

This design covers the product model + the minimum user-facing surfaces that deliver the canonical use case above. It is deliberately narrower than "full multi-coordinator support."

**In scope:**

- A device can be a member of multiple coordinator groups simultaneously.
- Each group carries a default project-scope template; newly-enrolled peers inherit it.
- The admin UI surfaces "which groups am I in, which peers came from each, what scope applies."
- Sync still requires explicit peer trust — group membership alone does not create sync relationships.

**Out of scope for v1 implementation but intentionally kept possible:**

- Multiple *independent* coordinator backends (multi-coordinator). One coordinator instance hosting multiple groups covers the canonical case today, but the data model and API shapes below must not foreclose adding a second coordinator context later. Future-proofing is a first-class design constraint, not a later refactor.
- Relay / coordinator-proxied transport.
- Automatic peering on group-membership change — still user-approved per the non-goal in `2026-04-12-coordinator-admin-ui-design.md`.
- Per-memory group attribution. Memories inherit their project from the session; project-level scoping is sufficient.

## Product model

### Group

A **group** is a coordinator-hosted namespace with:

- a stable id (coordinator-assigned, opaque to the client)
- a human label
- a coordinator context — for v1 this is always the one configured coordinator; the model leaves room for (coordinator-id, group-id) to become the primary key later
- zero or more members (devices)
- a default project-scope template (include / exclude lists)

A device can be a member of any number of groups simultaneously. A group exists independently of the device's peer list — membership gives the device *visibility* into other group members via coordinator discovery, not an active sync relationship.

### Peer

A **peer** remains the unit of active sync, as today. What changes:

- each peer can optionally carry a reference to the group it was discovered through (nullable; manually-paired peers have no group reference)
- a peer's `projects_include_json` / `projects_exclude_json` remain per-peer and canonical — the group template is only a seed, never a live link
- trust is still reviewed per-peer; group membership does not bypass trust

The distinction from cbfk: **group membership is a discovery + organization concept. Peering is a trust + transport concept. They are adjacent, not the same.**

### Project-scope template

Each group may define default `projects_include` / `projects_exclude` lists. When a new peer is enrolled through that group's discovery path:

- **default behavior (auto-seed = true):** the peer's `projects_include_json` / `projects_exclude_json` are populated from the group template at creation time.
- **opt-out:** a per-group toggle `auto_seed_scope` (default `true`) can disable seeding; the user picks a scope manually per-peer.

The seeded values are copied, not referenced. Later edits to the group template do not retroactively change existing peers. This mirrors the existing "peer scope is per-peer canonical truth" invariant.

### Canonical example resolved

Personal / Work / Coworker as three groups on one coordinator:

| Group | auto_seed_scope | template include | template exclude |
|---|---|---|---|
| Personal | true | (all projects) | — |
| Work | true | `["work/*", "shared-work-coworker/*"]` | — |
| Coworker | true | `["shared-work-coworker/*"]` | — |

When Personal enrolls Work as a peer via the Personal group, the Personal↔Work peer seeds with Personal's scope template. When Work enrolls Coworker via the Coworker group, the Work↔Coworker peer seeds with Coworker's scope. Personal and Coworker never appear in each other's discovery feed because they share no group. The topology falls out of group membership naturally — no special "exclude cross-team" logic required.

## Schema deltas

All additive, nullable, backward-compatible. No existing row shape changes.

### `sync_peers` — new columns

```sql
ALTER TABLE sync_peers ADD COLUMN discovered_via_coordinator_id TEXT;  -- nullable; null = manual pairing
ALTER TABLE sync_peers ADD COLUMN discovered_via_group_id TEXT;        -- nullable; null = manual pairing
```

Rationale:
- Captures how the peer entered the peer list. Manually-paired peers have both null (no behavior change).
- Composite `(coordinator_id, group_id)` future-proofs for multi-coordinator without a follow-up migration. For v1 `coordinator_id` is always the currently-configured coordinator; readers can treat null as "configured coordinator."
- Stored as text to match existing coordinator id conventions; no foreign key (coordinator groups live server-side; local references may outlive a group being deleted remotely).

### New table: `coordinator_group_preferences`

Local-side preferences — group membership itself is coordinator-authoritative and fetched via API.

```sql
CREATE TABLE coordinator_group_preferences (
  coordinator_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  projects_include_json TEXT,   -- JSON array; null means no include filter
  projects_exclude_json TEXT,   -- JSON array; null means no exclude filter
  auto_seed_scope INTEGER NOT NULL DEFAULT 1,  -- boolean; 1 = seed new peers from template
  updated_at TEXT NOT NULL,
  PRIMARY KEY (coordinator_id, group_id)
);
```

Composite primary key explicitly accommodates multiple coordinators. In v1 every row's `coordinator_id` is the currently-configured one; the constraint survives the later addition of other coordinators unchanged.

### What is NOT in the local schema

- Group membership list — the coordinator is authoritative, client caches via API.
- Group display name — ditto, fetched with membership.
- Peer-level scope (`projects_include_json` / `projects_exclude_json`) stays on `sync_peers` exactly as today. The template seeds these at peer-creation time; no live link.

## API boundary

### Viewer-server proxy (new and extended)

All under the existing `/api/coordinator/admin/*` namespace introduced in `2026-04-12-coordinator-admin-ui-design.md` slice 0; admin secret stays in viewer-server.

```
GET  /api/coordinator/admin/groups                       # list all groups on the configured coordinator (exists)
GET  /api/coordinator/admin/groups/:groupId/preferences  # read local prefs (scope template + auto-seed flag)
PUT  /api/coordinator/admin/groups/:groupId/preferences  # upsert local prefs
GET  /api/coordinator/admin/groups/:groupId/peers        # peers discovered via this group (local view)
POST /api/coordinator/admin/groups/:groupId/enroll-peer  # promote a discovered device to a sync peer,
                                                         # optionally overriding the auto-seeded scope
```

`preferences` is local-only; it never round-trips to the coordinator. `enroll-peer` is the single entry point that binds a discovered device to a new `sync_peers` row, applies the seeded or user-overridden scope, and stamps `discovered_via_coordinator_id` / `discovered_via_group_id`.

### Coordinator worker — no new endpoints required for v1

The coordinator already supports multi-group operations; what changes is that the client is allowed to operate on any of them, not just the configured one. The admin UI picks an active group (see next section); all group-scoped coordinator operations (`list invites`, `review join requests`, etc.) take `groupId` as a parameter — the coordinator already accepts this, the UI currently just hardcodes the configured group.

### No breaking changes to existing sync protocol

Replication payloads don't carry group context. Sync remains peer-to-peer with per-peer scope; adding group metadata to `sync_peers` doesn't change the wire format.

### Enroll-peer unification

Manual peer pairing and coordinator-discovered enrollment collapse into a single server-side endpoint:

```
POST /api/coordinator/admin/groups/:groupId/enroll-peer
```

Variants are expressed by an explicit `mode` field in the body, not by overloading the path param (a coordinator group could legitimately be named `none` or any other sentinel candidate):

| Case | `groupId` path param | body includes |
|---|---|---|
| Discovered via group, use template | real group id | `mode: "discovered"` (default), `peer_device_id`, `fingerprint` |
| Discovered via group, override scope | real group id | `mode: "discovered"`, `peer_device_id`, `fingerprint`, `projects_include` / `projects_exclude` |
| Manual pairing | any (ignored) | `mode: "manual"`, `peer_device_id`, `peer_public_key`, optional `name` / `fingerprint` / `peer_addresses` / `projects_*` |

`mode: "manual"` leaves `sync_peers.discovered_via_*` null. Existing callers that omit `mode` get the default `"discovered"` behavior. The existing accept-discovered-peer code path remains wired to the legacy route for backward compat; the admin UI routes through `enroll-peer` with the explicit mode.

## UI

Builds on the existing Coordinator Admin tab from `2026-04-12-coordinator-admin-ui-design.md`. Two surfaces are extended; one is new.

### Groups section (exists, expanded)

The **Groups** panel already lists coordinator groups and lets the admin select an active target. Additions:

- **Per-row membership indicator** — shows whether this device is currently a member. Non-member rows still render so the admin can enroll.
- **Open group drawer** button — takes the user to a new per-group detail view.

### New: per-group detail drawer

Opened from a group row. Contains three collapsible sub-sections:

1. **Scope template** — two editable include/exclude chip inputs and a toggle for `auto_seed_scope`. Save button writes to `/api/coordinator/admin/groups/:groupId/preferences`. An inline help row explains "New peers discovered through this team will default to this scope. Existing peers are not changed."
2. **Discovered devices** — same panel as today's top-level enrolled-devices view, filtered to this group. Enroll button opens the enroll dialog with the group's scope pre-filled (editable).
3. **Peers active in this group** — the `sync_peers` subset where `discovered_via_group_id = :groupId`. Shows current scope, last-sync time; link-out to the Sync tab's existing peer detail row.

### Sync tab changes (minimal)

The Sync tab already lists peers. One additive cue:

- each peer row shows a small "via {group label}" chip when `discovered_via_group_id` is non-null, linkable to that group's detail drawer. Manually-paired peers show no chip (unchanged).

No new primary affordances in Sync. The philosophy from the existing admin doc — Sync stays focused on everyday peer/discovery/sync work — is preserved.

### Readiness + empty states

- Device not a member of any group: Groups section still lists available groups, per-row CTA is "Request to join." Detail drawer disabled until membership is confirmed.
- Coordinator admin secret missing: Group detail drawer is disabled (same gating as the rest of the admin tab).
- Group has no scope template: drawer shows empty include/exclude with `auto_seed_scope` defaulted on; inline hint "Newly-enrolled peers will default to all projects."

## Migration + backward compatibility

### Existing databases

- The two `sync_peers` columns (`discovered_via_coordinator_id`, `discovered_via_group_id`) are null by default. Existing peers — whether manually paired or enrolled under the pre-multi-team admin flow — keep null and read as "manual pairing." No data loss, no ambiguity.
- The new `coordinator_group_preferences` table is empty at migration time. The "scope template" UI starts empty for every group; `auto_seed_scope` defaults to `1` so *new* peers enrolled after upgrade inherit the group's currently-null template (i.e. no include/exclude filter), matching today's default.
- A backfill bead is explicitly NOT needed. The feature light-turns-on for future enrollments; past peers carry on unchanged.

### Existing sync relationships

- No change. `sync_peers` scope fields remain canonical. Existing `projects_include_json` / `projects_exclude_json` on already-paired peers are preserved verbatim.
- If a user wants a retroactive "apply this group's template to existing peers that came from this group" action, that is an explicit user gesture in the UI, not an implicit migration. Out of scope for v1.

### Rollback

If any v1 change needs to be reverted:

- Dropping `coordinator_group_preferences` has no cascading effect — the table is local-preferences only.
- Clearing the two new `sync_peers` columns loses only the "discovered via {group}" attribution chip in the UI; sync itself continues.

## Non-goals

Preserved verbatim from the parent admin doc where applicable, plus new entries:

- No relay / coordinator-proxied transport.
- No automatic peering from group membership — enrollment remains user-triggered.
- No live link between group scope template and existing peers — template is a seed.
- No per-memory group attribution — project-level is sufficient.
- No multi-coordinator UI in v1 — data model leaves it open, UI assumes one coordinator.
- No group creation from the client — groups are coordinator-admin-created (existing flow, unchanged).

## Success criteria

1. A user with Personal / Work / Coworker groups on one coordinator can enroll peers in each and see per-team scope defaults applied automatically (or disabled per-group).
2. The Sync tab stays focused on everyday peer/sync work; no new primary affordances land there.
3. Existing manually-paired peers behave identically after upgrade — no user action required.
4. A future multi-coordinator extension can land without a schema migration.
5. The "group membership ≠ automatic sync" invariant from cbfk holds end-to-end in the UX.

## Implementation slices

Bottom-up, mirrors the stack shape already used for the Coordinator Admin epic. Each slice aims to be a single PR.

### Slice 0 — schema + preferences API

- Add `sync_peers.discovered_via_coordinator_id` / `discovered_via_group_id` columns.
- Create `coordinator_group_preferences` table + store helpers.
- Add viewer-server routes: `GET`/`PUT /api/coordinator/admin/groups/:groupId/preferences`.
- No UI yet.

### Slice 1 — enroll-peer unification

- Replace ad-hoc accept-discovered-peer handler with `POST /api/coordinator/admin/groups/:groupId/enroll-peer`.
- Internal branching on `groupId === "none"` for the manual-pairing path.
- Wire the existing Sync "accept peer" button through the new endpoint behind the scenes — no UI change yet.
- Tests cover: discovered-with-template, discovered-with-override, manual-pairing-through-sentinel.

### Slice 2 — per-group detail drawer (UI)

- New drawer opened from the existing Groups section.
- Scope template editor + `auto_seed_scope` toggle bound to the preferences API.
- Discovered-devices sub-section filtered by group, enroll CTA pre-fills scope.
- Active-peers sub-section queries `sync_peers WHERE discovered_via_group_id = ?`.

### Slice 3 — Sync-tab chip

- Additive "via {group}" chip on peer rows where `discovered_via_group_id` is non-null.
- Click-through to the group drawer on the admin tab.

### Slice 4 — (deferred) multi-coordinator UI

Same code path, but with a coordinator selector in the Groups section. Out of v1 scope; tracked as a separate bead under the existing 16p5.8 deferral.

## Bead graph

### Epic

- **Multi-team coordinator groups (v1 = single coordinator, multiple groups)**
  Un-defer of `codemem-16p5.8`, absorbing the design prerequisite from `codemem-cbfk`.

### Child beads (proposed)

1. Schema + preferences API (slice 0)
2. Enroll-peer unification (slice 1)
3. Per-group detail drawer (slice 2)
4. Sync-tab "via {group}" chip (slice 3)

`codemem-cbfk` resolves with a close-reason pointing at this doc; the product-model clarification is the doc itself.
`codemem-low6` remains separate — auto-peering on group-membership change is explicitly still a non-goal, not covered by this slice.
Multi-coordinator remains `codemem-16p5.8`-shaped follow-up; this design changes its pre-work, not its scope.
