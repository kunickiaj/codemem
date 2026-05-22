# Team and Space sharing UX design

**Date:** 2026-05-22  
**Status:** draft for 0.32  
**Related:** `2026-04-30-sharing-domain-scope-design.md`, `2026-04-22-multi-team-coordinator-groups-design.md`, `2026-05-06-sharing-domain-release-readiness-ux-design.md`, `2026-05-08-sharing-domain-guided-setup-flow.md`, `codemem-00dc`

## Decision summary

0.32 should keep the current security model but simplify the product model:

- **Team**: people/devices/admin visibility container.
- **Space**: isolated memory-sharing boundary.
- **Project**: work assigned into one Space.
- **Access grant**: permission for a device/member to sync a Space.

Every new Team should get one default Space automatically. Most users should experience this as “create a Team, add people/devices, put projects in it.” Advanced users can add more Spaces when they need separate memory boundaries.

Teams also carry an explicit setting: **auto-grant default Space on join**. When enabled, newly enrolled Team devices get access to the Team’s default Space. When disabled, Team membership grants visibility/admin context only and Space access remains explicit.

The current internal terms remain valid but should move out of primary UI copy:

| Current/internal term | 0.32 user-facing term | Notes |
|---|---|---|
| Coordinator group | Team | Discovery and admin container. |
| Sharing domain / replication scope / `scope_id` | Space | Hard data boundary. `scope_id` can appear as Space ID in advanced details. |
| Scope membership | Space access grant | Explicit grant. Team membership may auto-create a grant only for the Team’s default Space when the Team’s auto-grant setting is enabled. |
| Project scope mapping | Project assignment | Local rule assigning a project/worktree to a Space. |
| Sync peer | Peer / device, advanced sync detail | Active replication relationship; not the primary setup noun. |

## Problem

The current UI exposes too many layers for a common task:

1. create or select a coordinator group;
2. enroll devices in that group;
3. create a Sharing domain;
4. grant devices to the Sharing domain;
5. assign projects to the Sharing domain;
6. manage peers and project filters separately.

Each layer has a real implementation purpose, but users read many of them as the same thing: “the place where this collaboration happens.” That confusion caused a concrete setup failure: a user could create a group and a domain, see an enrolled device, and still not find a reliable path to grant access or assign projects.

## Goals

- Preserve the invariant that a Space is the hard memory authorization boundary.
- Make simple collaboration setup feel like one object: a Team with a default Space.
- Teach the rule of thumb: create a **Space** for a memory boundary; create a **Team** for a people/admin boundary.
- Make project assignment happen in terms of Spaces, with Team context for ownership and admin.
- Keep advanced multi-Space and cross-Team sharing possible.
- Decide which state belongs in `config.json`, local DB, or coordinator DB before implementation.

## Non-goals

- Do not collapse Team and Space internally.
- Do not weaken scope/Space authorization.
- Do not make project filters grant access.
- Do not add coordinator-as-data-path behavior.
- Do not redesign encryption, relay, or storage trust.
- Do not require all existing groups/scopes to migrate in one release.

## Product model

### Team

A Team is the people/devices/admin boundary. It answers:

- Who can discover or invite devices here?
- Which devices are enrolled under this admin context?
- Who manages the Spaces owned by this Team?

Team membership is visibility and administration. It becomes data access only through Space grants. In the simple collaboration path, adding a member/device to a Team may automatically grant the Team’s default Space; non-default Spaces always require explicit grants.

### Space

A Space is the data boundary. It answers:

- Which memories and projects belong together?
- Which devices may sync those memories?
- Which Team owns or manages the boundary?

Internally, a Space is backed by the existing `replication_scopes` / `scope_id` model.

### Default Space

Every Team should have a default Space created automatically by the setup flow.

Example:

```text
Team: Example Dev Team
  Space: Private Work
  Space: Open Source
  Space: Shared Collaboration
```

For a one-purpose Team:

```text
Team: Project Team
  Space: Project Team (default)
```

The default Space removes the current “create group, then separately create and grant a domain” setup trap. Advanced users can add more Spaces when needed.

The default Space has one special behavior: it is the only Space that can be auto-granted when a device joins the Team. This is controlled by the Team’s **auto-grant default Space on join** setting.

Recommended defaults:

- New one-purpose collaboration Teams: default Space created and auto-grant enabled.
- Migrated Teams with exactly one non-personal Space: suggest that Space as the default and ask for confirmation before enabling auto-grant.
- Migrated Teams with multiple Spaces: do not choose a default automatically; leave auto-grant disabled until the user confirms.
- Personal/private Spaces should never be auto-selected as the default during migration.

For example, a migrated multi-Space Team should remain conservative:

```text
Team: Example Dev Team
  Auto-grant default Space on join: off
  Space: Private Work
    Access: owner devices only
  Space: Open Source
    Access: owner devices + selected collaborator devices
```

If the user later creates a one-purpose Team, it can use the simplified behavior:

```text
Team: Project Team
  Default Space: Project Team
  Auto-grant default Space on join: on
```

### Cross-Team sharing

A Space may be shared with another Team without duplicating the data boundary.

```text
Space: Open Source
Owned by: Example Dev Team
Access granted to:
  - owner devices
  - selected collaborator devices
```

This preserves cases where one Team owns multiple Spaces and one Space is shared with people/devices from another Team.

## Config vs database ownership

0.32 should make source-of-truth ownership explicit.

### Keep in `config.json`

`config.json` should hold local bootstrap and connection preferences:

- coordinator URL(s), while multi-coordinator support remains limited;
- admin secret / local credential references where already supported;
- local sync enablement and timing preferences;
- temporary compatibility keys such as `sync_coordinator_group` and `sync_coordinator_groups` until migrated.

Config should not be the long-term source of truth for rich Team/Space state. Editing JSON should not be required to join, leave, archive, or repair a Team.

### Keep in coordinator service state

The coordinator should own shared admin facts:

- Team identity, label, and archived state;
- enrolled devices in each Team;
- invites and join requests;
- Space metadata when authority type is coordinator-backed;
- Space access grants and revocations;
- coordinator-backed membership authority.

The coordinator is still not a memory data path.

### Keep in local DB

The local DB should own local operational and product state:

- project-to-Space assignments;
- local cache of Spaces and grants;
- local active participation state: this node uses, hides, or disconnects from a coordinator-backed Team;
- sync peers and peer transport/trust state;
- local Team preferences, such as UI state and default project narrowing templates;
- disconnected or hidden Team state if a user leaves/archives a Team locally but historical records remain.

The local DB must not become the authority for coordinator-backed membership. It may cache membership and grants for UI/offline display, but the coordinator answers whether a device is enrolled in a Team or granted access to a coordinator-backed Space.

### Migration direction

For 0.32, add a migration/backfill path rather than deleting config keys immediately:

1. Read existing `sync_coordinator_group(s)` as compatibility input.
2. Materialize local active participation references into local DB state.
3. Keep coordinator-backed membership and Space grants coordinator-authoritative.
4. Keep writing compatibility keys until older code paths are removed.
5. UI operations must update the chosen local participation source of truth and keep compatibility config in sync during the transition.

## User flows

### Create Team

Default flow:

1. User creates Team.
2. System creates default Space with same label.
3. System grants the creator/current device access to the default Space when possible.
4. System enables auto-grant default Space on join for the new Team unless the user chooses advanced setup.
5. UI offers next steps: invite devices, add projects.

When auto-grant is enabled, future devices added to the Team receive access to the default Space. Additional Spaces are not auto-granted.

Failure states must name the failed step:

- Team created but default Space failed.
- Space created but current-device grant failed.
- Grant succeeded but project assignment failed.

Each state should be retryable.

### Add member/device to Team

When a Team has auto-grant enabled, adding or approving a device should show the default Space grant as part of the action:

```text
Approve device for Project Team
✓ Enroll in Team
✓ Grant access to default Space: Project Team
```

When auto-grant is disabled, the UI should make the absence of data access explicit:

```text
Approve device for Example Dev Team
✓ Enroll in Team
No Space access will be granted automatically.
Grant access to: [Private Work] [Open Source] [Skip]
```

This keeps simple Teams simple without accidentally sharing private Spaces.

### Assign project

Projects UI should show:

```text
Project: codemem
Current Space: Example Dev Team / Open Source
Reason: explicit mapping by git remote
```

The assignment chooser should group Spaces by Team:

```text
Local only
Example Dev Team
  Private Work
  Open Source
  Shared Collaboration
Other Team
  Shared Client Work
```

Unavailable Spaces should be visible only if useful, with explanation:

> You can see this Team, but this device does not have access to that Space.

Known project mappings apply automatically. New or unknown projects should not silently move into a non-local Space merely because a Team exists. The Projects surface should suggest a Space and require confirmation unless a safe explicit mapping already exists.

### Archive Team

Archiving a Team should remove it from active local operation for the archiving node. Historical records may remain for audit and restore.

Expected behavior:

- remove archived Team from this node’s active configured Teams;
- stop posting presence for the archived Team;
- coordinator rejects presence/peer discovery for archived Teams;
- UI says “Archived and disconnected from this device.”

If users need a softer action later, add “hide locally” or “leave Team” as separate concepts.

## UI information architecture

### Primary surfaces

- **Projects**: assign projects/worktrees into Spaces.
- **Teams**: manage members/devices, Spaces, invites, and access grants.
- **Sync diagnostics**: inspect peers, transport, and protocol state.

### Team page/card

Each Team should show:

- Team name and status;
- default Space;
- auto-grant default Space on join setting;
- additional Spaces;
- devices/members;
- project count per Space;
- access health: no members, current device not granted, stale grants, archived.

Raw IDs belong in advanced details:

- coordinator URL;
- group ID;
- Space ID / `scope_id`;
- membership epoch;
- authority type.

## Implementation slices

1. **Taxonomy and ownership decision** (`codemem-00dc.1`, `codemem-00dc.7`)
   - Finalize terms and source-of-truth rules.
2. **Lifecycle fixes and default Space automation** (`codemem-00dc.5`, `codemem-00dc.3`)
   - Archive disconnect semantics; auto-create and grant default Space.
3. **Team Spaces management UI** (`codemem-00dc.2`)
   - Reframe Coordinator Admin around Team/Space vocabulary.
4. **Projects assignment UX** (`codemem-00dc.4`, related to `codemem-e9uv`)
   - Assign projects into Spaces, grouped by Team.
5. **Guided setup** (`codemem-00dc.6`)
   - Create Team → invite/enroll → default Space → projects.

## Open questions

1. Should a Team always have exactly one default Space, or can advanced users delete/detach the default after creating another Space? Current recommendation: require a default Space for new Teams; allow replacing/renaming it, but do not allow deleting the last default without selecting another default or disabling auto-grant.
2. Should cross-Team Space sharing be visible in 0.32, or deferred behind advanced details? Current recommendation: support the underlying model and show it in advanced details only.
3. Should “leave Team” be separate from “archive Team,” especially for non-admin members? Current recommendation: yes, but archive + local disconnect is enough for the first 0.32 slice after the 0.31.4 bugfix.

## Success criteria

A user should be able to set up “me and one collaborator share a few projects” without knowing the words coordinator group, scope, or membership epoch.

A power user should still be able to model:

```text
Team: Example Dev Team
  Space: Private Work
  Space: Open Source
  Space: Shared Collaboration
```

and understand that Teams group people/devices while Spaces isolate memory.
