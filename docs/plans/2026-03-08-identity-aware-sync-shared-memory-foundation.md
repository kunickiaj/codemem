# Identity-Aware Sync and Shared Memory Foundation

**Bead:** codemem-d2a.1  
**Status:** Design  
**Date:** 2026-03-08

## Problem

codemem's current sync model is device-aware, not actor-aware.

That works for one person across multiple machines, but it breaks down as soon as memories are intentionally shared across teammates:

- authorship is implicit or absent
- personal and shared context blur together
- retrieval cannot prefer "my" memories over teammate memories in a principled way
- peer sync can filter by project, but not by actor/workspace intent
- existing memories and sync payloads have no first-class provenance contract for collaboration

We want shared memory to become explicit and useful without turning codemem into a mandatory hosted account system.

## Goal

Add a lightweight identity and provenance layer on top of the existing local-first and peer-to-peer sync architecture so codemem can support:

- personal memory across a user's own devices
- explicitly shared memory across trusted peers
- contributor-aware retrieval and ranking
- understandable scope boundaries between personal and shared memory

The first version must remain useful for a single user with no team setup.

## Non-goals (MVP)

- No mandatory centralized service or relay
- No full account system, org directory, or SSO integration
- No complex RBAC or enterprise policy engine
- No attempt to solve all trust and authorization semantics in the first pass
- No automatic widening heuristics that silently merge personal and shared context without clear user control

## Core decisions

### 1) Separate actor identity from device identity

`device_id` remains the sync transport identity for a local installation.

Add a new logical actor layer for authorship and retrieval semantics:

- `actor_id`: stable logical contributor identity
- `actor_display_name`: human-readable label for UI/debugging
- `device_id`: still identifies the specific syncing installation that produced or transported data

This keeps transport and authorship from being conflated.

### 2) Start with lightweight pseudonymous actors

The first actor model should be lightweight and local-first friendly rather than account-centric.

Recommended MVP shape:

- local config stores a stable actor profile for the current installation/user
- actor identity is propagated in local writes and sync payloads
- trust is manual/implicit by peer relationship for now

We deliberately defer formal user accounts and identity-provider integration.

### 3) Treat workspace as the primary scope boundary

Use workspaces to distinguish visibility and retrieval scope.

MVP workspace model:

- `personal` workspace: default scope for the local actor's own memory
- `shared` workspace: explicit shared scope for memories intended to replicate/use beyond one actor

Optional project-scoped shared workspaces can come later, but the first iteration should not invent an overly rich hierarchy.

### 4) Keep memory structure the same; add provenance metadata

We are not defining a new memory species for collaboration.

Instead, existing memory items and replicated artifacts gain provenance fields that explain:

- who authored the memory
- where it came from
- what scope it belongs to
- which device emitted the synced payload

## Provenance model

### Memory-level metadata

New canonical provenance fields for persisted memories and replicated memory payloads:

- `actor_id`
- `actor_display_name`
- `workspace_id`
- `workspace_kind` (`personal|shared` for MVP)
- `origin_device_id`
- `origin_source` (adapter/source that produced the memory, when relevant)
- `trust_state` (reserved field; semantics mostly deferred, see below)

Notes:

- `origin_device_id` is distinct from the current transport peer receiving or forwarding the payload.
- `origin_source` is for provenance and debugging, not for access control.
- `trust_state` may be nullable or defaulted in MVP if we choose not to enforce semantics yet.

### Sync/replication provenance

Replication payloads for syncable entities should carry the same canonical provenance fields when available.

That means outbound sync must preserve provenance, not silently strip it down to device-only merge information.

### Existing metadata that remains relevant

Current fields such as `clock_device_id`, `import_key`, `project`, and adapter `source` remain useful, but they are not enough on their own to model authorship or workspace scope.

The new identity-aware layer complements them rather than replacing all existing metadata.

## Retrieval model

### Default ranking behavior

Retrieval should remain personal-first by default.

MVP behavior:

1. Prefer memories where `actor_id == current_actor_id`
2. Respect explicit workspace filters when provided
3. Allow widening into shared scope when the user asks for it or when a caller explicitly enables it

This should be implemented as explicit ranking/filter controls, not as a hidden blend that makes shared context noisy.

### MVP retrieval controls

Add the minimum useful controls for search/pack/retrieval APIs:

- include actor IDs
- exclude actor IDs
- include workspace IDs or kinds
- exclude workspace IDs or kinds
- personal-first bias enabled by default

The exact API surface can be refined in implementation, but the contract should support contributor-aware filtering without breaking single-user defaults.

### Deferred retrieval behavior

The following are later-phase retrieval concerns, not MVP requirements:

- adaptive widening from personal to shared based on weak result sets
- trust-weight-based ranking
- advanced teammate-specific recall heuristics

## Workspace model

### Canonical MVP workspaces

Use explicit workspace IDs with a small reserved set of meanings:

- personal workspace for the local actor's default memory
- shared workspace for intentionally shared memories

Recommended shape:

- `workspace_id`: opaque stable identifier
- `workspace_kind`: `personal|shared`
- `workspace_name`: optional display name

### Why not project-as-workspace?

Projects already exist as a retrieval/sync filter dimension.

They are not sufficient as the sole collaboration boundary because:

- multiple actors may work on the same project but still want personal/private memory
- a shared workspace may span more than one project
- peer sync controls already use project filters and should remain orthogonal to authorship/scope

So MVP keeps project filters and workspace scope as related but distinct concepts.

## Peer-specific sync scope

Global sync include/exclude filters are too blunt once sharing becomes intentional.

MVP should support peer-specific sync scope controls in addition to global defaults:

- per-peer project include list
- per-peer project exclude list
- optional workspace-aware sync gating where shared/personal scope must be considered

Design rule:

- if a peer has explicit per-peer scope configuration, it overrides global project sync defaults for that peer rather than implicitly merging both layers in surprising ways

This matches the existing per-peer override semantics in replication code and extends them into a first-class UI/UX surface.

## Migration defaults

We need a safe migration path for existing memories and synced payloads that lack actor/workspace metadata.

### Existing local memories

Default existing local memories to:

- `workspace_kind = personal`
- `workspace_id = <local personal workspace>`
- `actor_id = <current local actor>`
- `actor_display_name = <current local actor display name>` when available

Rationale: legacy codemem behavior has been effectively personal, so migrating old local memory into personal scope preserves the least surprising interpretation.

### Existing synced memories with limited provenance

If a synced payload lacks actor/workspace fields:

- preserve current record behavior without rejecting the payload
- synthesize safe defaults rather than failing replication
- mark the memory as provenance-incomplete through null/default fields that can be upgraded later

Recommended fallback order:

1. use explicit actor/workspace fields if present
2. otherwise derive limited provenance from existing replication metadata (`clock_device_id`, transport peer, import key shape)
3. otherwise fall back to a legacy/unknown actor marker plus conservative scope defaults

The exact unknown-marker representation can be finalized during implementation, but the system must not silently pretend unknown provenance is fully trusted authorship.

## Trust-state semantics

Trust is intentionally scoped down in MVP.

Recommended MVP stance:

- keep a `trust_state` field in the model so future ranking/policy work has a place to attach
- do not make trust_state a prerequisite for the first identity-aware sync release
- treat trust primarily as a future retrieval/ranking refinement, not a hard auth policy

Likely initial values:

- `trusted`
- `unreviewed`
- `legacy_unknown`

But the concrete semantics should be finalized in `codemem-d2a.7`, not overbuilt now.

## Data model implications

The implementation should expect changes in at least these areas:

- local memory persistence schema
- replication payload schema for memory items and related synced entities
- sync peer configuration and UI for per-peer scope controls
- retrieval APIs and pack/search ranking paths
- viewer display for contributor/workspace context

This document does **not** lock the final column names, but it does lock the canonical concepts that the schema/API must represent.

## Recommended PR stack for MVP

### PR 1 - model/spec

- this design doc
- bead/spec linkage

### PR 2 - local provenance + workspace persistence

- add actor/workspace provenance fields to stored memory records
- introduce explicit personal/shared workspace defaults
- implement migration-safe defaults for existing local data

### PR 3 - sync propagation + peer-specific scope controls

- extend replication payloads to carry provenance metadata
- preserve compatibility with peers missing those fields
- expose per-peer project scope controls in backend + viewer UI

### PR 4 - contributor-aware retrieval

- add actor/workspace filters
- add personal-first retrieval bias
- keep widening behavior explicit and conservative

## Acceptance criteria

This foundation is successful when:

1. The first identity-aware sync iteration has a documented actor/workspace/provenance contract.
2. Existing personal local-first usage remains valid with safe defaults.
3. Existing synced data has a migration/defaulting story that does not require perfect metadata from all peers.
4. The MVP path is explicitly scoped to personal/shared boundaries, provenance, retrieval bias, and per-peer sync controls.
5. Heavyweight auth, trust policy, and relay infrastructure are clearly deferred rather than half-implied.

## Open questions for follow-up beads

- What exact shape should `actor_id` take in config and UI for the local actor profile?
- Should workspace IDs be user-visible names, opaque IDs, or both in the first UI pass?
- Should actor/workspace filters be exposed first in pack/search APIs, viewer UI, or both simultaneously?
- How much provenance should be surfaced directly in result cards versus tucked behind detail views?
- When shared memories are disabled for a peer, should that be enforced purely by sync topology, retrieval defaults, or both?
