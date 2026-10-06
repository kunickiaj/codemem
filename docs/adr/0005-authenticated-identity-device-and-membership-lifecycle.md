# ADR 0005: Authenticated Identity, device, and membership lifecycle

**Date:** 2026-10-05  
**Status:** Accepted for product boundaries; protocol and implementation gates remain open  
**Amends:** [ADR 0004](0004-authenticated-identity-and-live-relay-boundaries.md) (specific decisions listed below)  
**Related ADRs:** [ADR 0001](0001-project-recipient-policy-boundaries.md), [ADR 0002](0002-legacy-team-hardening-boundaries.md)  
**Related contract:** [Coordinator account-link protocol](../contracts/coordinator-auth-protocol.md)  
**Affected areas:** coordinator auth, device enrollment, Team invitations, recipient policy, memory control  
**Related task:** `codemem-e8j15.12`; implementation slices remain separately tracked and gated

## Summary

A verified account owner can add a fresh device to their existing Identity
without asking a Team admin or another trusted device. That device then gets
the Team eligibility its Identity already has. Signing in does not create new
Team memberships or Project grants; existing authorization still applies.

This ADR also records what the current code cannot do yet, so nobody mistakes
the auth groundwork for a finished lifecycle.

## Context

ADR 0004 approved optional Google sign-in and account linking for one existing
Identity per coordinator. Since then, the product direction has been clarified:

- People expect to sign in on a new laptop and get back to their Teams.
  ADR 0004 required approval from an existing trusted device for *every*
  additional device, which makes a lost or replaced laptop an admin ticket.
- Today's Team invitation always creates a brand-new Identity. An existing
  Identity cannot use that flow to join another Team without taking a new ID.
- ADR 0004 and the protocol contract use phrases ("login never writes
  `identity_devices`", "binding requires controller approval") that read as
  permanent rules but were written for the initial linking ceremony only.

Terms used below:

- **Identity:** one actor-backed principal (ADR 0001, Decision 1). Its ID is an
  actor ID.
- **Device:** one runtime key pair. A device belongs to exactly one Identity.
- **Team:** a policy Team (ADR 0001, Decision 2), a set of Identities.
- **Discovery group:** a coordinator group used for enrollment and peer
  discovery. It is not a Team and grants nothing.
- **Enrollment:** coordinator record that a device key belongs to a group and,
  once bound, to an Identity.

## Decision

### 1. Identity, devices, and Teams

- Each runtime uses one Identity. An Identity can have many devices and belong
  to many Teams. Team membership and Project authorization attach to the
  Identity, never to a device or a browser session.
- One Google account maps to one Identity per coordinator (unchanged from
  ADR 0004). Separate Personal and Work Identities need separate accounts or
  coordinators. Privileges never union across profiles.
- An unknown account (no active link) cannot use ordinary sign-in to claim an
  Identity or receive its session. First-time invitation/bootstrap remains a
  separate reviewed flow; an arbitrary actor ID is never an ownership claim.

### 2. Owner enrollment of a fresh device

- A verified owner can enroll a fresh device key into their existing Identity
  **without** separate Team-admin or trusted-device approval.
- The enrollment must prove both:
  1. account ownership, through a fresh OIDC sign-in that resolves to the
     Identity's active account link; and
  2. possession of the new device key, through a signature bound to the same
     short-lived enrollment attempt.
- Prefer reusing the two-proof literal-loopback pattern from the account-link
  protocol. The new enrollment protocol still needs review; a browser session
  or leaked start URL alone must not suffice to enroll a key.
- The confirmation page names the account, the Identity, and the new device.
- Enrollment never creates Team membership or Project grants. The new device
  inherits only what the Identity already has, filtered by each Team's
  device-eligibility mode. The normal authenticated-Team path must permit
  owner-enrolled devices without another admin approval. An existing explicit
  `reviewed_allowlist` policy is not silently widened: its conversion or continued
  exceptional use needs an explicit policy decision. Device exclusions remain
  effective in either path.
- A runtime that already holds local memories under another local actor is not
  silently adopted. That path goes through the migration review in Section 6.

**Clarifying "login never writes `identity_devices`":** sign-in alone (OIDC plus
a browser session) never creates or changes a device binding, enrollment, or
grant. A separate, explicitly confirmed enrollment ceremony, which uses a fresh
sign-in as one of its two proofs, may bind the device. The binding comes from
that ceremony, not from the login.

### 3. Team invitations and first-owner bootstrap

- An Identity that already exists can accept another Team's invitation without
  minting a new Identity. The invitation must target or be redeemed by that
  existing Identity under a reviewed contract (open decision A).
- The current "new person" invitation, which mints a fresh Identity, stays
  available for people who have no Identity yet.
- The first owner of a coordinator needs a bootstrap protocol that works before
  any Team exists. Operator- or invitation-based trust creates the first
  Identity and device enrollment in a discovery group; authentication and Team
  creation follow. This avoids a cycle where auth needs a Team and the Team
  needs auth. A discovery group never stands in for a Team.
- Existing-owner linking through admin controller review (protocol
  "Runtime finalization and ownership") is the legacy and bootstrap exception.
  It is not the normal flow for every new device or person.

### 4. Auth-required Teams and readiness

- Product code must not label a newly created Team as "auth-required and ready"
  today. Signed device permissions and required-auth enforcement do not exist.
- Converting an existing Team to auth-required needs an explicit readiness
  review. The review lists each member Identity, its account-link status, and
  its eligible devices. No member is silently stranded: the admin either fixes
  the gap or makes an explicit decision for that member.
- Whether auth-required is a Team property, a Project-wide rule, or both, and
  how overlapping independent grants interact, is open (decision B). Do not
  impose a strictest-rule-wins Project policy without explicit approval.

### 5. Revocation and exclusion are three different actions

| Action | Effect | Does not affect |
| --- | --- | --- |
| Remove an Identity from a Team | All its devices lose that Team's grants | Direct grants and other Teams |
| Revoke a device globally | That device loses all Identity-derived access on the coordinator | Other devices of the Identity |
| Exclude a device from one Team | That device loses only that Team's grants | Its enrollment and other grants |

- Revoked memberships, revoked devices, and exclusions stay as tombstones.
  Re-adding needs a new explicit decision, not an enrollment upsert.
- Where required auth applies, legacy enrollment must not silently restore
  access that a tombstone removed (no silent legacy downgrade).
- Already-delivered copies are not erased remotely. A peer that learns of a
  revocation enforces it immediately; an offline peer relies on permission
  expiry (the approved 24-hour ceiling).
- Browser logout ends the browser session only. It never revokes a device.
- No separate recovery framework is authorized. Nothing restores revoked or
  lost signing keys. With an intact account link, replacing a lost device means
  enrolling a fresh key and revoking the old one. Loss of usable account ownership
  still goes through the separately gated admin-assisted recovery path.

### 6. Memory control and migration

- Control over a memory (edit, delete, visibility, rescoping) follows verified
  Identity and Project authority. It is separate from historical authorship
  (`actor_id`), the originating device (`origin_device_id`), and which stores
  hold replicas.
- Today's control check is an implementation fact, not a lasting guarantee:
  `memoryOwnedBySelf` in [`store.ts`](../../packages/core/src/store.ts) accepts
  matching `actor_id`, the local or claimed same-actor `origin_device_id`, or a
  legacy sync actor. It stays until a verified-control protocol replaces it.
- Existing populated stores migrate only through explicit, reviewed ownership
  evidence. No merges by matching name or email. No rewrite of authorship.
  Local-only legacy stores stay untouched by default.

### 7. Live relay

- The relay stays optional, live-only, end-to-end encrypted, and used only when
  direct paths fail (ADR 0004). It applies the same scoped Identity and device
  authorization as direct sync. A browser session is never a sync grant.

## Amendments to ADR 0004

ADR 0004 stays as the historical record. These statements change:

| ADR 0004 statement | Now |
| --- | --- |
| "Additional devices require explicit approval from an existing trusted device" | Superseded for account-linked Identities by owner enrollment (Section 2). The trusted-device add-device invitation remains as an alternative path. |
| "Login never writes `identity_devices`" | Kept, and clarified: login alone never mutates; a separately confirmed enrollment ceremony may bind (Section 2). |
| "If all trusted device keys are lost, the coordinator admin can explicitly approve a replacement" | With an intact account link, owner enrollment can replace a lost device. Admin-assisted recovery without a usable link remains separately gated; this ADR does not activate it. |
| Binding "requires proof from a device that already controls that Identity" | Applies to the initial account link (legacy/bootstrap), not to later device enrollment. |
| "Existing device and provenance-based deletion authority stays unchanged" | Kept as current behavior only until a verified-control protocol exists (Section 6). |

The [account-link protocol](../contracts/coordinator-auth-protocol.md) line
"new-device approval require[s] fresh OIDC plus the original controller or
admin proof" must be updated to match Section 2 before enrollment code lands.

## Alternatives considered

### Keep trusted-device approval for every new device (ADR 0004 as written)
- **Pros:** Smallest change; a stolen account alone cannot add a device.
- **Cons:** Losing your only device becomes an admin ticket; every new laptop
  needs the old one online.
- **Why rejected:** The product owner chose account ownership plus new-key
  proof as sufficient. The open account-compromise decision (E) covers the risk.

### Let login itself enroll the device
- **Pros:** Fewest steps.
- **Cons:** A stolen browser session or pasted callback URL could add a key;
  no proof that the key holder finished login.
- **Why rejected:** Breaks the two-proof safeguard and the "login grants
  nothing" rule.

### Require Team-admin approval for each device
- **Pros:** Admins see every key.
- **Cons:** Turns a personal device change into Team work, once per Team.
- **Why rejected:** Membership attaches to the Identity; per-Team exclusion
  already gives admins control where they need it.

### Mint a new Identity per Team invitation (current behavior)
- **Pros:** Already implemented and tested.
- **Cons:** One person becomes several Identities; grants and devices split.
- **Why rejected:** Conflicts with one Identity in many Teams.

### Auto-link accounts or merge Identities by email or name
- **Pros:** Easy migration.
- **Cons:** Email is not an ownership proof; wrong merges leak data.
- **Why rejected:** ADR 0004 already forbids it; reaffirmed here.

## Rework assessment

Based on the current code paths, most auth groundwork is reusable. The real
rework is in invitation and enrollment orchestration; enforcement and
Identity-level control are new work, not rewrites of shipped features.

| Area | Current code | Assessment |
| --- | --- | --- |
| Google issuer+subject links, uniqueness, tombstones | [`coordinator-auth-link.ts`](../../packages/core/src/coordinator-auth-link.ts) | Reuse |
| 8-hour browser sessions | [`coordinator-auth-session.ts`](../../packages/core/src/coordinator-auth-session.ts) | Reuse |
| Two-proof loopback ceremony | [`coordinator-account-link-runtime.ts`](../../packages/core/src/coordinator-account-link-runtime.ts) | Reuse the pattern for enrollment |
| Signed device requests | `authorizeRequest` in [`coordinator-api.ts`](../../packages/core/src/coordinator-api.ts) | Reuse |
| Admin legacy ownership review | [`coordinator-auth-controller-review-route.ts`](../../packages/core/src/coordinator-auth-controller-review-route.ts) | Reuse as bootstrap/legacy path |
| Recipient scope and onboarding machinery | [`recipient-policy-onboarding.ts`](../../packages/core/src/recipient-policy-onboarding.ts) | Reuse |
| Team invitation | `createInvite` mints `identity:<random>` for every `team_member` invite ([SQLite](../../packages/core/src/better-sqlite-coordinator-store.ts), [D1](../../packages/core/src/d1-coordinator-store.ts)); `POST /v1/admin/invites` rejects a caller-supplied `assigned_identity_id`; acceptance calls `assertAddDeviceIdentityAdoptionAllowed`, which requires any other local Identity to be unused | Rework: add an existing-Identity path |
| Add-device | `POST /v1/invites/add-device` requires a signed request from an enrolled device already bound to the Identity; the viewer route requires the target to be the local actor ([`sync.ts`](../../packages/viewer-server/src/routes/sync.ts)) | Rework: add owner enrollment that needs no existing device |
| Device revocation | `/v1/admin/devices/disable` and `/remove` act on one group at a time | New: global device revocation distinct from per-Team exclusion (`policy_team_device_decisions`) |
| Signed 24-hour permissions, required-auth enforcement | No implementation | New |
| Identity-level memory control | `memoryOwnedBySelf` uses actor and device provenance | New |

Preserve every existing safeguard: exact issuer+subject keys, revoked-row
uniqueness, hashed one-time secrets, literal loopback, signed nonces, atomic
consume-and-bind, and fail-closed errors.

## Open decisions (must stay explicit)

- **A. Bootstrap and existing-Identity invitation contract.** How an invitation
  targets an existing Identity, what the redeeming device proves, and how the
  first owner is created before any Team exists.
- **B. Auth-required scope.** Team property, Project-wide rule, or both, and
  how overlapping independent grants combine. Strictest-wins is not approved.
- **C. Signed device permissions.** The issuer must be a trusted coordinator
  authority, never the device itself. The permission binds Identity, device,
  key, scope, policy versions, and revocation state. The 24-hour offline
  ceiling is a prior product decision; the wire format and peer enforcement
  remain a security gate.
- **D. Historical memory control.** How migration grants Identity-level control
  over old memories without rewriting authorship or origin fields.
- **E. Account compromise and freshness.** How recent the sign-in must be for
  enrollment, whether enrollment notifies other devices, and how fast
  revocation reaches online and offline peers.

## Consequences

### Positive
- Replacing or adding a laptop no longer needs an admin or the old device.
- One person keeps one Identity across Teams; grants stop fragmenting.
- Revocation choices match what admins actually mean.
- Most shipped auth code and safeguards carry forward unchanged.

### Negative
- Account takeover plus a fresh device now reaches the Identity's existing
  access without another human check. Decision E must mitigate this before
  owner enrollment ships.
- Two invitation paths (new person, existing Identity) need clear UI.
- Current control and deletion behavior stays provenance-based for a while.
- Required auth stays unavailable until decisions B and C close.

## Implementation order and acceptance checks

Each step is separately reviewed. None of them enables required-auth
enforcement, relay activation, provider configuration, coordinator
provisioning, D1 schema changes on live deployments, or deployment; those
remain separate approvals.

1. **Contracts.** Update the account-link protocol for Section 2; write the
   decision A contract. *Check:* security review signs off on proofs, replay,
   and conflict cases.
2. **Existing-Identity Team invitation.** *Check:* accepting a second Team's
   invite on an enrolled device mints no actor, keeps memories and devices,
   and adds only that Team membership.
3. **Owner fresh-device enrollment** (optional auth only). *Check:* login alone
   writes no binding; missing either proof creates no binding or grant;
   an unknown account cannot claim an actor; the new device gets only
   eligibility the Identity already had.
4. **Revocation primitives.** *Check:* Team removal, global device revocation,
   and per-Team exclusion each change only their own grants; tombstones block
   silent re-adds; logout revokes nothing.
5. **Readiness review** (read-only). *Check:* every unready member is listed;
   no Team shows "ready" for required auth.
6. **Signed permissions and required-auth enforcement**, after decisions B and C.
   *Check:* expired permission pauses affected sync while local use continues;
   learned revocation applies immediately; no legacy downgrade.
7. **Identity-level memory control**, after decision D. *Check:* no
   `actor_id` or `origin_device_id` rewrite; local-only stores untouched.

Relay work stays behind the separate ADR 0004 relay gates.
