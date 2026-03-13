# Remote Coordinator Admin Access Control

**Bead:** `codemem-y4m`  
**Status:** Design  
**Date:** 2026-03-13

## Problem

Coordinator-backed discovery now has two distinct classes of operation:

- device participation operations
  - register presence
  - look up peers
- coordinator administration operations
  - enroll devices
  - list enrolled devices
  - rename device display names
  - disable or remove devices

The first class can reasonably use device-key auth. The second class must not.

If remote mutation endpoints are exposed without a separate admin capability, any enrolled device could potentially
reconfigure or remove peers it does not own.

## Goal

Define a staged remote admin model that keeps the coordinator MVP safe enough to extend without pretending we already have
full identity, RBAC, or delegated admin.

## Non-goals

- No account system or SSO.
- No full multi-role permission model.
- No hosted codemem identity service.
- No conflation of discovery groups with memory-sharing policy.

## Recommended staged model

### Stage 0: local built-in coordinator admin

Applies only to the built-in coordinator running against a local SQLite DB.

Admin boundary:

- OS/filesystem access

Implication:

- local CLI management commands are acceptable without extra auth because whoever can run them already controls the local
  coordinator DB.

### Stage 1: remote admin via explicit operator secret

For remote coordinators (including Cloudflare/self-hosted HTTP deployments), the first safe admin model should be a
simple operator-managed admin secret.

Recommended shape:

- one coordinator-wide admin secret, or one per group if we want narrower blast radius
- sent via dedicated admin header (for example `X-Codemem-Coordinator-Admin`)
- used only for remote admin endpoints

This is intentionally boring.

Why this is the right first stage:

- easy for self-hosters to understand
- straightforward to implement across Python and Worker runtimes
- clearly separates device participation auth from admin auth
- avoids overloading device keys with admin power

### Stage 2: explicit admin identities/keys

Later, if the operator-secret model proves too coarse, move to a stronger admin model:

- `group_admins` or equivalent store
- admin public keys or signed admin requests
- possibly multiple admins per group

But that should come after Stage 1 is working, not before.

### Stage 3: optional self-service device actions

Possible later extension:

- allow a device to update only its own non-sensitive metadata
- maybe allow self-remove

Not allowed in Stage 1:

- one device mutating other devices
- open self-enrollment based only on group name

## Operation classes

### Device-key auth operations

These remain authenticated by the enrolled device's existing sync keypair:

- `POST /v1/presence`
- `GET /v1/peers`

These are participation operations, not admin operations.

### Admin-secret operations

These should require explicit remote admin capability:

- list enrolled devices
- enroll a new device
- rename a device display name
- disable a device
- remove a device

## API boundary recommendation

Keep device and admin surfaces separate.

Suggested split:

- `/v1/presence`
- `/v1/peers`
- `/v1/admin/devices`
- `/v1/admin/devices/<device_id>`

This makes it harder to accidentally apply the wrong auth rule to the wrong endpoint.

## Config surface for Stage 1

If/when remote admin ships, the operator would configure something like:

- `sync_coordinator_admin_secret`

This should be treated as a sensitive local config value and never surfaced casually in UI copy.

## Built-in coordinator implication

The local built-in coordinator can still use direct CLI commands against its SQLite DB without implementing the remote
admin secret flow.

That means we can safely ship local management commands now while remote admin remains blocked on this design.

## Acceptance criteria

This design is successful when:

1. Device participation auth and remote admin auth are clearly separated.
2. Stage 1 recommends a pragmatic remote admin model that is simple and safe enough to ship.
3. The design explains why local built-in coordinator admin is a different case.
4. Future evolution toward stronger admin identity is possible without blocking Stage 1.
