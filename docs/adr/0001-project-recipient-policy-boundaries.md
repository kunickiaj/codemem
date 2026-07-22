# ADR 0001: Project-recipient policy boundaries

**Date:** 2026-07-21
**Status:** Accepted
**Related design:** `../plans/2026-07-21-project-recipient-sharing-identity-design.md`
**Implementation plan:** `../plans/2026-07-21-project-recipient-sharing-implementation.md`

## Context

Codemem currently stores human provenance as actors, enrolls devices into coordinator groups, authorizes replication through scope memberships, and provisions exact Project sharing through resumable share operations. The approved recipient-policy design introduces four user-facing concepts—Project, Identity, Team, and Device—without replacing replication scopes as the hard security boundary.

Before adding persistence or routes, the implementation needs stable boundaries between:

```text
user intent ≠ derived effective recipients ≠ current scope enforcement
```

This ADR settles the storage and compatibility decisions needed by the versioned recipient-policy contract. It introduces no policy persistence, migration, route, or authorization behavior.

## Decision 1: Actors back Identities

The existing `actors` table is the canonical backing record for V1 Identities.

An Identity ID is an actor ID. The existing actor lifecycle already supports:

- active local and remote identities;
- pending invitation placeholders;
- merging a pending placeholder into an accepted identity;
- durable memory provenance through `memory_items.actor_id`; and
- device attribution through `sync_peers.actor_id`.

V1 contract language uses **Identity**, not Actor. Future persistence work may add nullable identity kind and verification metadata to `actors`, but it must not introduce a parallel Identity table with a second lifecycle or merge authority.

This decision supersedes the earlier open framing that allowed `actors` to remain only a compatibility projection over a new Identity table.

### Consequences

- Existing provenance and accepted-invite links remain valid.
- Personal and Work Identities use distinct actor IDs even when one human controls both.
- `is_local` is not permission to collapse multiple Identities into one principal.
- OAuth/OIDC may verify an Identity later without replacing the Identity abstraction.

### Rejected alternatives

- A second `identities` table would create duplicate merge and lifecycle authorities.
- Treating actors as provenance-only would leave device-to-Identity assignment non-authoritative.

## Decision 2: Policy Teams are distinct from coordinator groups

A policy Team is a durable set of Identities that receives explicitly shared Projects. A coordinator group remains a device enrollment, discovery, and administration construct.

Future persistence will model Teams independently and may link a Team to one or more coordinator groups through explicit coordinator/group references. Team membership is Identity-based. Coordinator enrollment remains device-based and cannot create Team membership or Project access by implication.

The policy Team display name is authoritative in normal UI. Coordinator group names are enrollment and diagnostics metadata.

### Consequences

- Team membership can express current and future member inheritance.
- A Team can outlive or span coordinator deployments.
- Coordinator enrollment, discovery, and trust never become authorization shortcuts.
- A later reconciler may enroll or discover Team member devices without treating enrollment as a grant.

### Rejected alternatives

- Making coordinator groups canonical Teams would couple device enrollment to access and cannot represent Identity membership.
- Modeling Teams as saved direct-recipient lists would lose future-member inheritance.

## Decision 3: Authority cuts over per Project

Recipient policy remains non-authoritative until each canonical Project passes an explicit parity gate. Existing scope enforcement remains authoritative during projection and migration.

A Project is eligible for recipient-policy authority only when:

1. it resolves to exactly one active managed Project scope;
2. the derived desired device set equals active scope membership;
3. the equality remains stable across an idempotent reconciliation pass;
4. every required peer supports the negotiated reassignment capability;
5. no unresolved review item applies to the Project's current source fingerprint; and
6. reconciliation has no incomplete or attention-required step.

Cutover and rollback operate per canonical Project. A failure after cutover returns that Project to legacy scope enforcement while preserving recipient intent and review history. No database-wide flag or timed promotion changes every Project at once.

These are minimum parity conditions. Later slices may add stricter fail-closed gates without superseding this ADR.

### Consequences

- Migration blast radius is one Project.
- Projection and reconciliation must share one deterministic effective-device derivation.
- Cutover needs a persisted per-Project authority state and observable parity status in later slices.
- Silence or elapsed time is never evidence of parity.

### Rejected alternatives

- A database-wide cutover flag would turn one migration defect into a system-wide authorization change.
- Time-based automatic promotion would treat elapsed time as proof and could broaden access without verified parity.

## Decision 4: Review decisions are attributed and durable

Every review resolution is attributed to the deciding local Identity and device. Resolution is validated against the review item's deterministic source-state fingerprint.

The future persisted record includes:

- deciding Identity ID;
- deciding device ID;
- selected decision;
- source-state fingerprint; and
- resolved timestamp.

`Keep current setup unchanged` and `Reject suggestion` are first-class completed outcomes. They remain cleared until the source fingerprint changes.

If another Identity, device, coordinator administrator, or source owner must act, the condition is `Blocked` with a named owner and repair route. It is not a local review item.

### Consequences

- Review is an auditable decision workflow rather than a warning bucket.
- Non-local ambiguity cannot masquerade as an actionable local task.
- Concurrent resolution must validate the source fingerprint before accepting a decision.

### Rejected alternatives

- Identity-only attribution would not identify which runtime observed and approved the source state.
- Unattributed or transient dismissal would make `Keep current setup unchanged` reappear and provide no durable audit trail.

## Decision 5: Legacy enrollment invitations remain enrollment-only

Legacy pairing and coordinator invitations without persisted reviewed Project intent remain enrollment-only. They may establish discovery, trust, device metadata, and an Identity link, but they never create Project-recipient intent.

An existing invitation may seed a non-authoritative recipient-policy projection only when it carries:

- canonical persisted Project intent;
- a valid reviewed Project-set digest;
- the linked share operation; and
- the bound recipient Identity/device acceptance.

The digest must be revalidated before translation. Translation remains non-authoritative until the Project passes the per-Project parity gate.

### Consequences

- Existing exact-Project invitations remain useful migration evidence.
- Old Team and pairing invitations continue to work without silently granting data.
- In-flight enrollment invitations may wait for an explicit Team or Project relationship after acceptance.

### Rejected alternatives

- Treating any accepted Team or pairing invitation as Project authorization would make enrollment an access shortcut.
- Ignoring all legacy invitations would break valid in-flight enrollment and exact-Project invitations that already carry reviewed intent.

## Decision 6: Legacy navigation remains addressable

The new top-level navigation will add `Sharing` and `Devices`. The existing `sync` route remains a compatibility and advanced-diagnostics alias rather than being removed immediately.

Existing hashes and saved state must resolve predictably:

- `#sync` routes to the new Devices or advanced diagnostics landing;
- `#sync/diagnostics` preserves the diagnostics destination;
- existing Teams/coordinator administration links route into Sharing or Advanced administration; and
- old stored tab values do not strand users on an inaccessible screen.

The final navigation change and redirect tests land only after recipient-policy authority and migration gates pass.

### Consequences

- Existing bookmarks and internal links remain usable.
- `sync` persists as implementation debt during the compatibility window.
- Hard-coded navigation assignments require an explicit audit before promotion.

### Rejected alternatives

- Renaming or removing the `sync` route immediately would break bookmarks, saved tab state, and existing internal links.
- Keeping the current top-level Sync surface unchanged would preserve the engine-first mental model this redesign replaces.

## Versioned contract boundary

PR 1 introduces a dependency-free V1 contract that keeps three representations separate:

1. **Intent:** Project recipients, Team memberships, and Identity devices.
2. **Effective access:** devices derived from Identity and Team relationships.
3. **Enforcement:** current managed-scope membership and per-Project authority status.

Intent types contain no scope, grant, coordinator enrollment, trust, connectivity, or filter field. Those facts cannot grant access and belong only in explicit projection or enforcement status.

## Deferred decisions

- OAuth/OIDC provider and account-recovery behavior.
- Multiple Identities in one runtime.
- GitHub organization, path, and tag automation.
- Device profiles and policy defaults.
- Remote deletion of delivered memories.

## Validation

Pure contract fixtures must prove:

- canonical Projects are keyed by canonical identity;
- one device edge names exactly one Identity;
- direct Identity and Team recipients are distinct variants;
- `Keep current setup unchanged` is a valid actionable decision; and
- intent fixtures contain no authorization shortcut fields.
