# Project-First Sharing with Private Per-Memory Override

**Bead:** `codemem-71t`  
**Status:** Design  
**Date:** 2026-03-12

## Problem

Identity-aware sync introduced explicit memory visibility controls, but the current behavior made `visibility`
the primary sync gate for non-local peers. In practice that means new teammate peers receive nothing unless memories are
individually marked shared.

That is a poor fit for the existing product model because codemem already has global and per-peer project include/exclude
filters. Users reasonably expect those project filters to define the default sync set, with `private` acting as an
escape hatch for exceptions.

## Goal

Restore project-first sharing semantics for non-local peers:

- project include/exclude filters define the default eligible sync set
- `private` is the explicit do-not-share override
- same-person peers assigned to the local actor continue to receive private memories

## Non-goals

- No silent widening beyond the projects already allowed for a peer
- No actor-specific sharing policy beyond local-actor continuity versus non-local actor sharing
- No bulk onboarding wizard in this slice
- No new visibility enum or full sharing-policy engine

## Proposed model

### Local actor defaults

For local actor-authored memories, default visibility becomes effectively shared.

That means:

- newly created local memories are eligible for sync to non-local peers when project filters allow them
- users mark a memory `private` only when they want to keep it off the shared path

### Non-local peers

For peers assigned to a non-local actor, outbound sync should allow a memory when all of the following are true:

1. the memory's project passes the effective include/exclude filters for that peer
2. the memory is not explicitly marked `private`

### Local-actor peers

For peers assigned to the local actor, existing same-person continuity remains unchanged:

- private memories continue to sync
- project filters still narrow what is sent if configured

## Storage contract

We do not need a new visibility enum for this fix.

Instead:

- `private` continues to mean explicit do-not-share for non-local peers
- `shared` continues to mean shareable
- local memories that were previously defaulted to `private` only because the old model required it should be migrated to
  `shared`

## Migration rules

Migrate local-actor memories from old implicit-private defaults to shared when all of the following are true:

- `actor_id` matches the local actor
- current row visibility is `private`
- current workspace is personal
- metadata does not explicitly set `visibility`

Migration behavior:

- set row visibility to `shared`
- set workspace kind to `shared`
- set workspace ID to `shared:default`
- do not treat rows with explicit `metadata_json.visibility = private` as migration candidates

This preserves real private overrides while reclassifying old default-private rows into the model users expected.

## UI and docs contract

- Feed visibility controls should keep the current simple language (`Only me` / `Share with peers`)
- Sync UI copy should explain that non-local peers receive memories from allowed projects unless those memories are set to
  `Only me`
- Docs should stop claiming that new memories default private

## Tests required

- default local memories replicate to non-local peers when project filters allow them
- explicit private memories do not replicate to non-local peers
- explicit private memories still replicate to local-actor peers
- migrated legacy default-private local memories become shareable without needing per-memory edits
- project filters still exclude memories even when their visibility is shared/default-shareable

## Acceptance criteria

This work is successful when:

1. project filters once again define the default shared sync set for non-local peers
2. `private` acts as a per-memory override instead of the default non-local behavior
3. same-person continuity for local-actor peers remains intact
4. legacy default-private local memories are migrated safely
5. docs and UI copy reflect the restored model clearly
