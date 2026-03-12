# Actor Registry and Peer-Assignment Contract

**Bead:** `codemem-ix6.1`  
**Status:** Design  
**Date:** 2026-03-12

## Problem

The shipped identity-aware sync MVP introduced actor-aware provenance, personal/shared workspace boundaries,
and a lightweight `claimed_local_actor` peer override.

That override is useful, but it is still a stopgap:

- it models "this peer belongs to me" as a boolean instead of an explicit actor relationship
- it cannot map multiple peers to one stable actor record
- it does not provide a real home for teammate actors
- it makes legacy-history collapse feel like a special case instead of part of the actor model
- it leaves future per-actor sharing, review, and retrieval features without a durable identity layer

We need a first-class actor registry and peer-assignment contract that extends the shipped MVP without dragging in
accounts, org directories, or hosted identity machinery.

## Goals

- Replace the one-off same-identity peer claim with explicit actor records and peer-to-actor assignments.
- Allow multiple sync peers to resolve to one logical actor.
- Preserve current local-first behavior for single-user installs.
- Define how legacy synced histories get upgraded when a peer is assigned to an actor.
- Lock the minimum UI and API contract needed for follow-on implementation.

## Non-goals

- No account system, login flow, org membership, or SSO.
- No cryptographic actor identity separate from the existing peer/device trust model.
- No generic per-memory actor editing workflow in this slice.
- No trust-policy engine or actor-based sync ACLs.
- No requirement to rewrite every historical memory row immediately when an actor changes.

## Current baseline

Today the repo already has these behaviors:

- a local actor profile, with `actor_id` defaulting to `local:<device_id>` when not configured
- memory provenance fields (`actor_id`, `actor_display_name`, `visibility`, `workspace_id`, `workspace_kind`, `origin_device_id`, `trust_state`)
- private memories syncing only to peers marked `claimed_local_actor`
- legacy backfill that synthesizes actor IDs such as `legacy-sync:<origin_device_id>`
- a viewer/Sync panel flow for `Belongs to me` and `Claim old device as mine`

This contract must preserve those outcomes while giving them a cleaner identity model.

## Core decisions

### 1) Actor identity remains lightweight and opaque

`actor_id` stays an opaque stable string, not a username or account handle.

Rules:

- existing local actor IDs remain valid; do not force a migration away from `local:<device_id>` immediately
- explicit actor records may use any stable opaque ID shape, but new managed actors should prefer a durable
  actor-oriented namespace such as `actor:<opaque-id>` rather than encoding transport device IDs
- display labels belong in `actor_display_name`, not in `actor_id`

This keeps backward compatibility while allowing the product to stop pretending device identity is the same thing as
actor identity.

### 2) Add a first-class actor registry

The system should store explicit actor records rather than only inferring actors from memory rows.

Minimum actor record fields for the first pass:

- `actor_id` - stable primary identifier
- `display_name` - human-readable label
- `is_local` - whether this record is the current installation's actor
- `status` - `active|merged` to support safe collapse flows without hard deletes
- `merged_into_actor_id` - nullable redirect target when an actor has been merged into another
- `created_at`
- `updated_at`

Notes:

- exactly one actor record may be `is_local=1` per local database
- local config remains the source of truth for the current actor profile in the short term; the actor table mirrors it so
  the UI and assignment logic have a uniform model
- non-local actors are lightweight labels plus stable IDs, not authenticated user accounts

### 3) Peer assignment is many peers to one actor

Each sync peer may map to zero or one actor.

Rules:

- one actor may have many peers assigned to it
- a peer may have at most one active actor assignment at a time
- unmapped peers remain valid and continue using current legacy/fallback provenance behavior
- the local machine does not need a `sync_peers` row for its own actor record

Implementation preference:

- store the current assignment directly on `sync_peers.actor_id` rather than introducing an extra join table for MVP

That shape is enough for:

- multiple devices belonging to one person
- multiple teammate devices resolving to one teammate actor
- a simple UI that answers "which peers belong to which actor?"

### 4) `claimed_local_actor` becomes compatibility state, not the long-term model

The shipped boolean override should migrate into explicit actor assignment instead of surviving as the primary concept.

Contract:

- assigning a peer to the local actor is the new semantic equivalent of `claimed_local_actor = 1`
- during migration, existing `claimed_local_actor = 1` peers should automatically map to the local actor
- follow-on implementation may keep the boolean column temporarily for compatibility, but it should be derived from or
  kept in sync with the explicit assignment
- new product surfaces should talk about actor assignment, not about a standalone same-identity flag

### 5) Actor assignment affects both future provenance and legacy upgrade behavior

Assigning a peer to an actor has two distinct effects.

#### Future inbound behavior

When an inbound payload from a peer lacks explicit actor fields, the assigned actor becomes the fallback author identity
for provenance resolution.

This replaces device-only fallback with actor-aware fallback when the operator has already told us who that peer is.

#### Existing legacy-history behavior

When a peer is assigned to an actor, historical rows from that peer become eligible for backfill if their current
provenance is still synthetic or legacy-derived.

Rows are eligible for reassignment when their provenance still looks incomplete, for example:

- `actor_id` matches `legacy-sync:*`
- `actor_display_name` is the legacy placeholder label
- `workspace_id` or `workspace_kind` still reflects legacy shared fallback
- `trust_state = legacy_unknown`

Do not rewrite rows that already carry explicit non-legacy actor provenance from a newer peer.

### 6) Same-person assignment remains the only case that widens private sync

The current system allows `visibility=private` memories to sync to peers marked `claimed_local_actor`.

That behavior should survive, but only for peers assigned to the local actor.

Rules:

- peers assigned to the local actor are treated as the same-person continuity path
- those peers may continue receiving private/personal memories
- peers assigned to any non-local actor remain shared-only recipients
- actor assignment to a teammate must not silently widen private-memory replication

This keeps the useful "my machines act like one person" behavior without turning actor assignment into a privacy footgun.

### 7) Legacy backfill differs for local vs non-local actor assignment

When upgrading historical rows from an assigned peer, the target actor determines the safe rewrite behavior.

#### If the peer is assigned to the local actor

Backfilled rows should become equivalent to current personal memory defaults:

- `actor_id = <local actor_id>`
- `actor_display_name = <local actor_display_name>`
- `visibility = private`
- `workspace_kind = personal`
- `workspace_id = personal:<local actor_id>`
- `trust_state = trusted`

This preserves the meaning of the existing `Belongs to me` and `Claim old device as mine` flows.

#### If the peer is assigned to a non-local actor

Backfilled rows should become explicit shared provenance for that actor:

- `actor_id = <assigned actor_id>`
- `actor_display_name = <assigned display_name>`
- `visibility = shared` unless the row already has explicit non-legacy visibility metadata
- `workspace_kind = shared`
- `workspace_id = shared:default` unless a better explicit shared workspace already exists
- `trust_state = trusted`

Rationale:

- the operator has provided explicit actor identity, so the old `legacy_unknown` placeholder is no longer the best model
- we still keep the scope conservative by treating teammate-origin history as shared, not personal

## Merge and collapse semantics

The first pass needs a practical collapse story, not a grand unified identity engine.

### Primary collapse mechanism: many peers, one actor

The main way to collapse legacy history is to assign multiple peers to the same actor.

That alone solves the most important product problem:

- several old devices can resolve to one person
- retrieval can treat them as one contributor
- ownership and shared/private defaults stop depending on device sprawl

### Actor merge behavior

The first managed "merge actor" workflow may stay intentionally narrow.

Minimum contract:

- choose a primary actor and a secondary actor
- move peer assignments from secondary to primary
- future fallback provenance resolves to the primary actor
- mark the secondary actor as `merged` with `merged_into_actor_id = <primary>`
- hide merged actors from normal picker UIs

Deferred for later unless clearly needed:

- eagerly rewriting every historical row that already references the secondary explicit actor ID
- multi-step actor split/undo workflows
- full audit-log UI for actor merges

This keeps the merge story safe and explainable while avoiding a large historical-rewrite feature in the first pass.

## UI contract

The first actor-management UI should stay close to the existing Sync panel mental model.

Minimum supported actions:

- create actor
- rename actor
- assign peer to actor
- unassign peer from actor
- assign peer to local actor (replacement for `Belongs to me`)
- claim old device history as local actor
- optionally merge one actor into another if the implementation can explain the effect clearly

Minimum information shown:

- actor display name
- whether the actor is local or non-local
- which peers are assigned to the actor
- whether a peer is unassigned
- a short explanation of what assignment changes affect:
  - future provenance fallback
  - legacy history upgrade
  - private sync only when assigned to the local actor

Non-goals for the first UI pass:

- editing every actor field manually
- project/workspace policy editing inside the actor editor
- actor avatars, invitations, or presence
- exposing merged actors as first-class active rows

## API contract

The first implementation should support a minimal management API surface.

Recommended operations:

- list actors
- create actor
- rename actor
- list peers with assigned actor IDs
- assign or unassign a peer's actor
- trigger legacy-history reconciliation for an assigned peer when needed

Recommended payload shape requirements:

- peer list responses should include both `peer_device_id` and `actor_id`
- actor list responses should include enough metadata for selection and badges (`actor_id`, `display_name`,
  `is_local`, `status`, `merged_into_actor_id`)
- assignment updates should be explicit writes, not implicit side effects hidden behind unrelated peer-update endpoints

The first pass does not need a public CLI for full actor management if the viewer API/UI lands first, but the backend
contract should not preclude a later CLI.

## Migration plan

### Existing local actor

- create or mirror an actor record for the configured local actor on startup or migration
- preserve the current configured `actor_id` and `actor_display_name`

### Existing `claimed_local_actor` peers

- migrate each claimed peer to `sync_peers.actor_id = <local actor_id>`
- keep `claimed_local_actor` in sync during the transition period if the column remains

### Existing unclaimed peers

- leave them unassigned
- keep current fallback behavior until the operator assigns them

### Existing legacy memories

- do not perform a global rewrite during schema migration alone
- only upgrade eligible legacy rows when the relevant peer or legacy device is explicitly claimed or assigned
- keep already explicit actor provenance intact

This avoids surprise mass rewrites while still making assignment immediately useful.

## Open implementation questions

- Should the local actor config remain authoritative forever, or should the actor table eventually become canonical?
- Do we need a dedicated "retired/merged actors" view, or is hiding them from normal pickers enough?
- Should peer unassignment preserve a last-known actor reference for audit/debugging, or is clearing `sync_peers.actor_id`
  sufficient in MVP?
- Do we need a one-shot "reconcile all assigned peers" maintenance action, or are per-peer updates enough?

## Acceptance criteria

This contract is successful when:

1. The actor registry model is explicit enough for persistence and UI implementation.
2. Multiple peers can map to one actor without relying on boolean same-identity flags.
3. Migration from `claimed_local_actor` is defined and backward compatible.
4. Legacy-history collapse rules are clear for both same-person and teammate assignments.
5. The first implementation can ship without inventing accounts, orgs, or trust-policy machinery.
