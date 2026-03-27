# Sync / Coordinator Peer Suggestions and Control Surface Plan

**Beads:** `codemem-cbfk`, `codemem-ddx7`, `codemem-oq8h`, `codemem-vr2x`, `codemem-low6`, `codemem-rtmb`  
**Status:** Design  
**Date:** 2026-03-26

## Problem

The current TypeScript sync/coordinator flow has three overlapping problems:

1. **Model confusion**
   - coordinator-backed group membership feels like team connectivity
   - actual sync still depends on separate manually managed `sync_peers`
   - old stale peer entries can coexist with fresh coordinator discovery and make the system feel broken

2. **Missing operator controls**
   - the TypeScript CLI is missing coordinator admin commands that docs and store capabilities imply should exist
   - peer management CLI parity with the Python flow is incomplete
   - the UI exposes stale/broken peer state without enough repair affordances

3. **Premature automation pressure**
   - users naturally expect same-group devices to become usable teammates
   - but silent auto-peering would blur discovery, trust, and sharing in a way that conflicts with codemem’s explicit local-first model

## Goals

- Make the coordinator/group model explicit and predictable.
- Restore missing CLI/UI surfaces so users can inspect and repair state without raw SQLite.
- Introduce a lower-friction onboarding flow for coordinator-discovered devices.
- Preserve explicit trust and sharing review before replication starts.

## Non-goals

- No assumption that joining a coordinator group should immediately enable memory sharing.
- No replacement of peer trust with opaque coordinator magic.
- No full RBAC/account system redesign here.
- No server-authoritative sync model.

## Recommended Product Model

This design intentionally keeps the durable model small.

Durable concepts:
- **coordinator membership**
- **discovered device**
- **sync peer**

Derived flags or UX labels, not first-class persisted states:
- stale
- conflicted
- unreachable
- needs repair
- needs sharing review

### Coordinator group

A coordinator group is a **discovery and eligibility boundary**.

Meaning:
- devices in the same group may discover each other
- devices in the same group may be presented as candidate teammates
- coordinator membership alone does **not** make them active sync peers

This keeps discovery transport separate from replication trust and sharing policy.

### Suggested peer

A suggested peer is a read-model or UX label for a device discovered through the coordinator that:
- belongs to the same group
- is reachable enough to advertise fresh presence
- has not yet been accepted as a real sync peer

Suggested peers are the bridge between coordinator discovery and explicit sync trust. This does not require a durable
`suggested_peers` table in the first implementation.

### Accepted sync peer

An accepted sync peer is a device the local operator has explicitly approved for replication.

Acceptance creates or updates a real `sync_peers` entry. That peer then participates in the normal sync path.

### Sharing before first sync

Acceptance should not imply immediate replication with inherited defaults hidden in the background.

Before first sync, the user should review sharing policy:
- inherit default policy
- selected projects only
- no sharing yet

This should be treated as a derived onboarding requirement first, not a new persisted workflow state unless experience
proves the existing peer/share config is insufficient.

## Why suggestion-based onboarding is preferred

Three candidate models were considered:

1. **Auto-peer on discovery**
   - too implicit
   - risks surprise replication
   - over-couples discovery and trust

2. **Suggested peers with explicit acceptance and pre-sync sharing review**
   - recommended
   - reduces manual friction while preserving trust and sharing boundaries

3. **Auto-peer with no sharing by default**
   - safer than immediate auto-sync
   - but creates more hidden state and “why is this connected but inert?” confusion than the suggestion model

The suggestion model best matches codemem’s explicit trust posture.

## Bead Graph Strategy

### 1. `codemem-cbfk` — Clarify coordinator groups vs manual peer pairing

This bead is the foundation.

It should define:
- coordinator group semantics
- suggested peer semantics
- accepted peer semantics
- first-sync sharing review requirement
- expected coexistence with old manual peers

This design must land before implementation work on automation or UX polish.

### 2. `codemem-ddx7` — Add missing coordinator admin CLI commands

Restore and align the coordinator admin surface with the current store and remote-admin design.

Minimum useful commands:
- `group-create`
- `list-groups`
- `list-devices`
- `enroll-device`
- `rename-device`
- `disable-device`
- `remove-device`

Rationale:
- operators need a supported way to inspect and repair coordinator state
- automation without admin visibility is a debugging nightmare

### 3. `codemem-oq8h` — Restore sync peer management CLI commands

Restore direct peer maintenance commands in the TS CLI.

Minimum useful commands:
- peer removal
- peer listing/inspection improvements
- peer repair-oriented commands needed to manage stale pairings

Rationale:
- stale peer cleanup must be possible without UI dependence or SQLite surgery
- this is also a prerequisite for a safe suggestion acceptance/rejection workflow in CLI form

### 4. `codemem-vr2x` — Add UI control to delete sync peers

The viewer should expose peer deletion/removal for stale or broken peers.

Rationale:
- backend support already exists
- users encountering stale peers in the UI need an obvious recovery path
- this is especially important while old/manual peers and new coordinator suggestions coexist

### 5. `codemem-low6` — Auto-peer devices discovered in coordinator groups

This bead should be reinterpreted as **suggestion-driven onboarding**, not blind auto-peering.

Recommended scope:
- first add a read-only discovered-device view separate from existing peers
- surface likely stale/broken peer conflicts and repair guidance
- only add accept/reject/dismiss actions after the read model proves necessary
- reuse existing peer/share config where possible rather than inventing a new persisted workflow state

### 6. `codemem-rtmb` — Simplify create-invite group argument

This is related cleanup, not a blocker for the larger model. It can be folded into coordinator CLI surface cleanup where convenient.

## Recommended Execution Order

1. `codemem-cbfk`
2. `codemem-ddx7`
3. `codemem-oq8h`
4. `codemem-vr2x`
5. read-only discovered-device / stale-peer visibility
6. `codemem-low6`
7. `codemem-rtmb`

`codemem-ddx7` and `codemem-oq8h` can potentially proceed in parallel once the model is fixed, but both should land
before suggestion acceptance or any new onboarding automation.

## Migration / Coexistence Notes

The design must account for pre-existing manual peers.

Expected realities:
- users may already have stale peer entries with dead addresses or old identity state
- coordinator discovery may surface a fresh device that corresponds to an old stale peer record
- accepted-suggestion flow should not silently merge unsafe state

Recommended first pass:
- show stale peers and suggestions as separate concepts
- when a suggestion appears to match an existing peer/device, prompt the user to repair/replace rather than silently mutating both

Conflict and repair should start as a read-model and operator-action problem, not as an automatic merge system.

## Acceptance Criteria

This design is successful when:

1. Coordinator membership, suggested peers, and accepted sync peers are clearly distinct.
2. The plan restores missing operator controls before adding onboarding automation.
3. The first implementation restores operator control and read-only visibility before onboarding automation.
4. Suggested-peer onboarding is explicitly deferred behind the simpler visibility/repair slices.
5. The bead graph has a documented execution order that reduces rework and debugging ambiguity.
