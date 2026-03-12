# Optional Relay / Coordinator Mode for Identity-Aware Shared Sync

**Bead:** `codemem-6pe`  
**Status:** Design  
**Date:** 2026-03-12

## Problem

Peer-to-peer sync is the right default for codemem: local-first, simple, no hosted dependency.

But once shared memory spans more teammates and more networks, pure peer-to-peer runs into practical friction:

- peers may not be mutually reachable because of NAT, VPN, sleep, or firewall realities
- updates can arrive only when specific devices are online together
- pairing scales awkwardly as the number of peers grows
- the product may need a more reliable shared-memory transport without becoming a mandatory cloud SaaS

We need a design for an optional relay/coordinator mode that improves reachability and fan-out while preserving the
local-first, no-central-service-required shape of codemem.

## Goals

- Keep pure peer-to-peer sync as the default and always-supported mode.
- Define an optional relay/coordinator that improves reliability for shared sync.
- Reuse the existing provenance and replication model as much as possible.
- Preserve end-user control over whether relay mode is enabled.
- Avoid inventing hosted accounts or a mandatory identity provider.

## Non-goals

- No mandatory always-online codemem cloud.
- No server-side semantic search or server-authoritative memory store in the first relay design.
- No enterprise auth/SSO/RBAC system.
- No replacement of device pairing with email/login identity.
- No assumption that relay mode and peer-to-peer mode are mutually exclusive.

## Recommended architecture stance

Use a **coordinator-plus-relay** model, not a server-authoritative database.

Recommended responsibilities for the optional service:

- rendezvous / reachability coordination for enrolled devices
- authenticated message relay for replication payloads when direct peer dial is unavailable
- optional durable queueing of encrypted replication envelopes for temporarily offline peers

What the relay should **not** own in the first version:

- canonical memory state
- actor registry truth
- search index or retrieval ranking
- policy decisions about visibility beyond transport enforcement

This keeps the relay as a transport helper, not a new product center of gravity.

## Core design decisions

### 1) Local databases stay authoritative

Each device still owns its local SQLite store.

Replication semantics remain the same:

- devices emit replication ops
- devices apply replication ops locally
- clocks/conflict rules remain device-side

The relay forwards or temporarily stores envelopes; it does not become the source of truth for memory contents.

### 2) Relay enrollment is device-based, not account-based

The current sync stack already has device identity material:

- device IDs
- public keys
- fingerprints
- pairing payloads

The first relay mode should extend that instead of inventing user accounts.

Recommended enrollment model:

- a relay instance has its own public endpoint and server identity
- a device enrolls by explicitly trusting that relay and registering its device public key
- relay membership is scoped to a shared sync group or workspace, not to a global codemem account

This keeps the auth story aligned with existing pair/trust mechanics.

### 3) Relay transport should preserve end-to-end provenance and, ideally, encryption

Relay mode should carry the same replication payloads and provenance fields used by peer-to-peer sync.

Preferred stance:

- the relay can inspect routing metadata
- the relay should not need to understand memory semantics beyond delivery metadata
- if feasible, payload bodies stay encrypted end-to-end between member devices

If the first implementation cannot achieve full body encryption immediately, that limitation should be explicit and not
misrepresented as zero-knowledge magic.

### 4) Relay groups map to intentional shared-sync scopes

The relay should not be a global inbox for every device everywhere.

Recommended unit of coordination:

- a relay-backed sync group representing a bounded shared collaboration context

That group may later align with a shared workspace, but the first design should keep the transport group distinct from
memory workspace semantics.

Reason:

- one relay group may transport multiple shared scopes
- memory visibility/workspace remains an item-level concern
- transport enrollment and retrieval scope should not collapse into one overloaded object too early

## Relay responsibilities

Minimum relay responsibilities:

1. authenticate enrolled devices
2. accept replication envelopes from a sender
3. route envelopes to intended peers or group members
4. queue envelopes temporarily for offline recipients
5. expose delivery status/health information back to devices

Optional but reasonable later responsibilities:

- membership roster distribution
- push notifications / wake-up hints
- relay-side anti-abuse rate limits

Not a responsibility in the first version:

- query answering
- pack building
- server-side merge resolution

## Auth and key story

### Relay identity

Each relay has a pinned identity, ideally comparable to the current peer fingerprint trust model.

Devices should explicitly trust a relay rather than silently accepting any host claiming to be one.

### Device authentication to relay

Recommended first pass:

- device signs a challenge or request with its existing sync private key
- relay verifies enrollment against the registered public key for that device

This avoids bolting on passwords or tokens as the primary auth model.

### Group membership

Recommended first pass:

- one enrolled device can invite another by exchanging a relay-group join payload
- join flow remains operator-driven and explicit, similar in spirit to current pairing

This keeps the product consistent: codemem still works by explicit trust relationships, just with a different transport.

## Coexistence with pure peer-to-peer

Relay mode should be additive, not a forked product.

Recommended coexistence rules:

- direct peer-to-peer remains enabled when configured and reachable
- relay mode is an additional transport path when direct dial fails or is unavailable
- the replication payload schema stays shared across both transports
- one device may use direct transport with some peers and relay transport for others

This avoids a painful either/or migration and keeps local setups simple.

## Delivery and conflict model

Do not invent a new merge system for relay mode.

Use the current replication clock model unchanged:

- relay forwards envelopes
- recipients apply the same clock/conflict resolution rules they already use

If relay queueing introduces duplicate delivery, idempotency must rely on the existing replication op identity rules.

## Failure modes and boundaries

### Relay offline

- direct peer-to-peer should still work when available
- relay-backed queued delivery pauses but local capture continues

### Device offline

- relay may queue envelopes up to a bounded retention window
- devices reconcile on reconnect using the normal replication cursor model

### Relay compromise

Design assumption:

- relay compromise must not imply server-authoritative deletion or mutation of local memory
- if payload encryption is not end-to-end in the first version, document clearly that the relay can inspect transported
  payload bodies

### Membership mistakes

- removing a device from a relay group should stop new deliveries
- it should not be expected to retroactively erase already-synced memories from local peers

That is a visibility/data-lifecycle problem, not a transport trick.

## Rollout recommendation

1. Keep peer-to-peer as the only shipping mode until relay design is explicitly chosen.
2. Build relay support behind an opt-in transport configuration.
3. Start with coordinator-assisted delivery for sync ops, not server-side storage/search.
4. Add offline queueing only if direct relay forwarding is not enough.

## Out of scope for the first implementation

- hosted multi-tenant codemem accounts
- central search over team memory
- server-side pack generation
- cross-group policy inheritance
- full audit/compliance system

## Acceptance criteria

This design is successful when:

1. Relay responsibilities are clearly bounded to coordination/transport.
2. The auth and key story builds on existing device trust rather than introducing a mandatory account system.
3. Coexistence rules with pure peer-to-peer sync are explicit.
4. Failure modes and local-first boundaries are named clearly enough to guide implementation.
