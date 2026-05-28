# Authenticated owner-aware sync follow-up

Status: design follow-up
Date: 2026-05-27
Related: `2026-05-27-scope-revocation-cleanup-plan.md`, `2026-03-08-identity-aware-sync-shared-memory-foundation.md`, `2026-03-12-actor-registry-peer-assignment-contract.md`, `2026-04-30-sharing-domain-scope-design.md`

## Problem

The 0.34 cleanup stack deletes stale peer-received rows only when device provenance and Space authorization make the decision safe. That is intentionally conservative. Today `actor_id`, `actor_display_name`, and same-person peer claims are self-reported local metadata. They help presentation and retrieval, but they do not prove who owns a memory or who may authorize deletion on another device.

The future owner-aware model should let one authenticated person use multiple devices as one owner, but it must not weaken the current rule: until identity is authenticated, cleanup authority comes from `origin_device_id` / source provenance and Space membership, not display identity.

## Current authority model

- `origin_device_id` identifies the source device that can author authoritative memory updates and cleanup for its own rows.
- `clock_device_id` / replication op source provenance must match the row provenance before receiver cleanup may delete a peer-received row.
- `scope_id` / Space membership decides whether a receiver is currently authorized to retain data.
- `actor_id`, display name, and claimed-local-actor state are not authorization inputs for deletion, grant, or reassignment authority.

This remains the runtime contract for 0.34.

## Target authenticated model

Introduce an authenticated owner identity above actors and devices:

- `owner_id`: stable authenticated principal for a person or service account.
- device binding: a signed relationship between `owner_id` and one or more device keys.
- actor binding: an authenticated relationship between `owner_id` and one or more local actor records.
- Space grant binding: membership grants issued to device keys and, later, optionally to owner identities with auditable device expansion.

Under that model, a receiver could treat memories from another device owned by the same authenticated `owner_id` as same-owner data, while still preserving source provenance for audit and conflict resolution.

## Migration questions

1. How does a local actor become bound to an authenticated owner without rewriting historical rows blindly?
2. Should historical rows gain `owner_id` lazily during read/sync, or through an explicit migration with review?
3. How are compromised or retired device keys removed from an owner without implying impossible erasure from offline copies?
4. Should Space membership be granted to owner identities, device keys, or both?
5. What proof travels in replication ops so receivers can verify owner/device binding offline?

## Runtime migration shape

1. Add authenticated owner records and signed device-owner bindings.
2. Keep existing `actor_id` and `origin_device_id` fields; add owner metadata rather than replacing them.
3. Mark rows as owner-verified only when their source device binding is verified at or before receipt.
4. Allow same-owner cleanup/reassignment behavior only for owner-verified rows.
5. Keep unverified/self-reported rows on the current device/provenance path.

## Non-goals

- No actor/display-name-based authority.
- No cleanup based solely on a peer claiming to belong to the local person.
- No guarantee of erasure from offline devices, backups, copied databases, or malicious peers.
- No coordinator data path requirement; the coordinator may publish identity/grant metadata, but memory payloads stay peer-to-peer.
- No broad schema rename from `scope_id` to product terminology.

## Decision

The cleanup protocol remains device/provenance-aware until authenticated owner identity exists. The future design should add owner verification as a strictly stronger proof layer, not reinterpret today’s self-reported actor metadata as authority.
