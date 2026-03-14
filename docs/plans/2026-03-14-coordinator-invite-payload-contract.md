# Coordinator Invite Payload Contract

**Bead:** `codemem-q8q`  
**Status:** Design  
**Date:** 2026-03-14

## Goal

Define the canonical team-scoped invite artifact for coordinator-backed team onboarding.

This contract must be stable enough that:

- admins can generate invites
- teammates can import them
- a link/open wrapper can carry the same payload later
- the coordinator can implement either auto-admit or approval-required without changing the teammate-facing invite shape

## Recommended shape

Use a single JSON payload that is serialized as:

- a base64url-encoded import string
- optionally wrapped in a link later

Suggested top-level shape:

```json
{
  "v": 1,
  "kind": "coordinator_team_invite",
  "coordinator_url": "https://coord.example",
  "group_id": "team-alpha",
  "policy": "auto_admit",
  "token": "opaque-random-token",
  "expires_at": "2026-03-15T00:00:00Z",
  "team_name": "Team Alpha"
}
```

## Field semantics

- `v`
  - invite payload version
- `kind`
  - distinguishes invite payloads from future artifacts
- `coordinator_url`
  - base URL the teammate should talk to
- `group_id`
  - coordinator group namespace
- `policy`
  - `auto_admit` or `approval_required`
- `token`
  - opaque invite token stored by the coordinator
- `expires_at`
  - hard expiry for import/redeem
- `team_name`
  - optional display string for teammate UX

## Transport forms

Canonical artifact:

- base64url-encoded JSON payload

Optional link wrapper later:

- `codemem://join?payload=<encoded-payload>`
- or HTTPS wrapper that hands the payload to codemem

The payload contents remain the same regardless of transport.

## Coordinator-side storage

Suggested invite record:

- `invite_id`
- `group_id`
- `token`
- `policy`
- `expires_at`
- `created_at`
- `created_by`
- `revoked_at` nullable
- optional `team_name_snapshot`

This keeps the payload itself small and lets the coordinator enforce expiration/revocation.

## Join redemption request

Suggested teammate join request body:

```json
{
  "token": "opaque-random-token",
  "device_id": "dev-123",
  "public_key": "ssh-ed25519 AAAA...",
  "fingerprint": "SHA256:...",
  "display_name": "laptop"
}
```

This does not require the device to already be enrolled.

## Join response states

### Auto admit

```json
{
  "ok": true,
  "status": "enrolled",
  "group_id": "team-alpha",
  "policy": "auto_admit"
}
```

### Approval required

```json
{
  "ok": true,
  "status": "pending",
  "group_id": "team-alpha",
  "policy": "approval_required"
}
```

### Failure

- `invalid_token`
- `expired_token`
- `revoked_token`
- `already_enrolled`

## Acceptance criteria

This contract is successful when:

1. The same payload can support paste/import and link/open entry points.
2. Policy mode is explicit in the payload.
3. Auto-admit and approval-required are both representable without changing teammate-facing shape.
4. The contract is concrete enough for admin generation and teammate import implementation.
