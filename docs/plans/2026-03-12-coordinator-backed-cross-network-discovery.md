# Coordinator-Backed Cross-Network Discovery

**Bead:** `codemem-sw7`  
**Status:** Design  
**Date:** 2026-03-12

## Problem

codemem's current sync model works best when peers have stable reachable addresses or can discover each other on the
same LAN via mDNS. In practice, one of the main real-world failure modes is different:

- peers are often reachable, but their addresses change frequently
- peers go online and offline at different times
- mDNS does not reliably cross VPN or broader network boundaries

That means the immediate user pain is not primarily "we need a relay transport now." The main issue is durable,
cross-network discovery and presence.

## Goal

Add an optional, self-hosted coordinator service that gives codemem devices a stable cross-network discovery plane.

The first slice should:

- let devices register current reachable addresses and liveness with a coordinator
- let trusted devices look up current dial candidates for peers through that coordinator
- keep direct peer-to-peer sync as the data path
- remain runtime-agnostic, with a Cloudflare Worker reference deployment

## Non-goals

- No codemem-operated public service.
- No server-authoritative memory store.
- No relay/proxy transport in the first slice.
- No offline message queue in the first slice.
- No account system, email login, or SSO.

## Architecture stance

Use a **coordinator-only MVP** for discovery/presence, not a full coordinator-plus-relay implementation yet.

### Why this cut

- it directly addresses unstable addresses across VPN/network boundaries
- it preserves codemem's current local-first direct-sync model
- it avoids overbuilding transport infrastructure before it is actually needed
- it keeps the door open for later relay and buffer support

## Deployment model

The coordinator is:

- self-hosted or operator-run
- reachable at a stable public or private address
- defined by a small HTTP contract

Reference deployment:

- Cloudflare Worker is the canonical example because it is cheap and easy to operate

But the protocol should stay runtime-agnostic so the same coordinator can also be implemented as any tiny HTTP service.

## Trust and auth model

### Device identity

Reuse codemem's existing device trust model:

- device IDs
- public keys
- fingerprints

### Coordinator auth

The first slice should assume **device-key auth only**:

- devices sign coordinator requests with the same sync key material they already use
- the coordinator stores an explicit allowlist or enrollment record for accepted device public keys
- no passwords, user accounts, or codemem-hosted identity service

### Enrollment

Enrollment remains explicit and operator-controlled.

The simplest first pass is:

- an operator creates a coordinator group
- devices are explicitly enrolled into that group with their public keys / fingerprints

This can later be wrapped in a better UX, but the first version should optimize for clarity and safety.

## Coordinator responsibilities

The coordinator should do only four things in v1:

1. authenticate enrolled devices
2. accept presence/address registrations from those devices
3. answer peer lookup requests for devices in the same group
4. expose enough metadata to reason about freshness (`last_seen_at`, last registration)

What it should **not** do in v1:

- relay replication payloads
- queue memory ops for offline devices
- decide visibility or sync policy
- store or inspect memory content
- answer search queries

## Coordinator data model

Suggested logical records:

### Group

- `group_id`
- `display_name` (optional)
- `created_at`

### Enrolled device

- `group_id`
- `device_id`
- `public_key`
- `fingerprint`
- `display_name` (optional)
- `enabled`
- `created_at`

### Presence record

- `group_id`
- `device_id`
- `addresses` (normalized dial candidates)
- `last_seen_at`
- `expires_at`
- optional capability flags reserved for later (`supports_relay`, `supports_queueing`)

The first implementation can keep this very small. The main requirement is that presence expires automatically when a
device stops refreshing.

## HTTP contract

Recommended minimal endpoints:

### Auth headers

Reuse the existing sync request signing model unchanged.

Coordinator requests should carry:

- `X-Opencode-Device`
- `X-Opencode-Timestamp`
- `X-Opencode-Nonce`
- `X-Opencode-Signature`

Verification should reuse the same canonical request format and device-key signature verification logic currently used by
peer sync HTTP endpoints.

### `POST /v1/presence`

Used by a device to publish its current reachability.

Request body:

```json
{
  "group_id": "team-alpha",
  "fingerprint": "SHA256:...",
  "public_key": "ssh-ed25519 AAAA...",
  "addresses": ["http://203.0.113.10:7337", "http://100.64.0.5:7337"],
  "ttl_s": 180,
  "display_name": "laptop",
  "capabilities": {
    "supports_relay": false,
    "supports_queueing": false
  }
}
```

Behavior:

- device identity (`device_id`, fingerprint)
- group identifier
- signed auth headers using existing device key material
- list of current candidate addresses
- optional metadata like display name / capabilities

Response body:

```json
{
  "ok": true,
  "group_id": "team-alpha",
  "device_id": "dev-123",
  "addresses": ["http://203.0.113.10:7337", "http://100.64.0.5:7337"],
  "expires_at": "2026-03-12T22:00:00Z"
}
```

Notes:

- the coordinator may normalize, deduplicate, or reorder addresses before storing them
- `public_key` may be omitted after initial enrollment if the coordinator already has it on file, but including it in the
  first contract keeps enrollment and registration easy to reason about

- `ok`
- normalized stored addresses
- presence expiry timestamp

### `GET /v1/peers`

Used by a device to ask for current dial candidates for other devices in the same group.

Query parameters:

- `group_id`

Response includes, per peer:

```json
{
  "items": [
    {
      "device_id": "dev-456",
      "fingerprint": "SHA256:...",
      "addresses": ["http://198.51.100.10:7337"],
      "last_seen_at": "2026-03-12T21:57:00Z",
      "expires_at": "2026-03-12T22:00:00Z",
      "stale": false,
      "display_name": "workstation",
      "capabilities": {
        "supports_relay": false,
        "supports_queueing": false
      }
    }
  ]
}
```

- `device_id`
- `fingerprint`
- `addresses`
- `last_seen_at`
- `stale` / freshness hint

Optional later endpoint:

### `GET /v1/peer/<device_id>`

Useful if we want single-peer lookup instead of fetching the whole group roster each time.

## Local codemem behavior

### Discovery sources

After this change, codemem should treat peer discovery as multi-source:

1. coordinator presence records (cross-network source of truth)
2. locally cached peer addresses (`sync_peers.addresses_json`)
3. mDNS (LAN-only supplemental source)

### Dial order

Recommended first-pass dial order:

1. fresh coordinator addresses
2. cached known-good addresses
3. mDNS-discovered addresses

Direct sync stays the data path. The coordinator only helps codemem find where to dial.

### Local persistence

Keep writing discovered addresses back into `sync_peers.addresses_json` as a cache. The coordinator is not replacing the
local peer table; it is becoming the cross-network source that refreshes it.

Minimum local persistence expectations:

- coordinator-returned addresses are merged into the existing local cache using the same normalization rules as mDNS and
  remembered addresses
- coordinator lookup must not create new peer trust entries implicitly; it only refreshes addresses for already-trusted
  peers in the same group
- the local cache remains usable when the coordinator is unavailable

## Refresh / lifecycle behavior

### Presence registration

Devices should refresh coordinator presence on a lightweight cadence, for example:

- at sync daemon startup
- after local address changes are detected
- periodically while sync is enabled

### Expiration

Presence records need TTL-based expiration so stale addresses disappear automatically.

This avoids a coordinator becoming a graveyard of old laptop IPs.

## Config and environment surface

Recommended first-pass config fields:

- `sync_coordinator_url: str | None = None`
- `sync_coordinator_group: str | None = None`
- `sync_coordinator_timeout_s: int = 3`
- `sync_coordinator_presence_ttl_s: int = 180`

Recommended environment variables:

- `CODEMEM_SYNC_COORDINATOR_URL`
- `CODEMEM_SYNC_COORDINATOR_GROUP`
- `CODEMEM_SYNC_COORDINATOR_TIMEOUT_S`
- `CODEMEM_SYNC_COORDINATOR_PRESENCE_TTL_S`

Enablement rule:

- coordinator-backed discovery is enabled when both `sync_coordinator_url` and `sync_coordinator_group` are set
- mDNS remains independently configurable via `sync_mdns`
- `sync_advertise` remains the source for which local addresses get published to peers and the coordinator

## Coexistence with later relay/buffer work

The coordinator design should reserve room for future transport help without implementing it yet.

Design constraints for v1:

- capability flags should allow a later relay role to be advertised
- group and device auth should be reusable if relay is added later
- peer lookup responses may later include relay hints, but do not in v1

This keeps the current work from blocking the future relay/buffer track.

## Cloudflare Worker reference deployment

The reference implementation should show:

- a tiny HTTP API implementing the above contract
- device-key request verification
- simple persistence for group/device/presence data

The first doc should stay explicit that Cloudflare Worker is just the canonical example, not the required runtime.

## Failure modes

### Coordinator unavailable

- codemem falls back to cached addresses and mDNS
- direct peer-to-peer may still work

### Stale coordinator presence

- peer lookup should surface freshness/expiry metadata
- sync should still attempt direct dial only against non-expired candidates by default

### Enrollment/auth mismatch

- coordinator denies registration/lookup
- codemem surfaces a clear configuration or trust error

## Rollout recommendation

1. Define the small coordinator HTTP contract.
2. Add coordinator config to codemem.
3. Implement coordinator-backed presence registration and lookup in the sync discovery path.
4. Provide a Cloudflare Worker reference deployment.
5. Document self-hosted setup and limits.

## Follow-on work explicitly deferred

- relay/proxy transport when direct dial fails
- buffered/offline delivery
- richer operator enrollment UX
- public hosted service model

## Acceptance criteria

This design is successful when:

1. The first slice clearly solves unstable cross-network discovery without requiring relay transport.
2. The coordinator stays self-hosted, device-authenticated, and runtime-agnostic.
3. Direct peer-to-peer sync remains the data path.
4. The design leaves clean extension points for later relay/buffer work without forcing them into v1.
