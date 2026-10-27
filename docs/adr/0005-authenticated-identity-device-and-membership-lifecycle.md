# ADR 0005: Authenticated Identity, device, and membership lifecycle

**Date:** 2026-10-05

**Status:** Accepted for product boundaries; protocol and implementation gates remain open.
Amended 2026-10-26 by [Section 8](#8-sign-in-sets-the-devices-identity-amended-2026-10-26).

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

### 8. Sign-in sets the device's Identity (amended 2026-10-26)

**Why this changed.** Dogfooding showed that a person who used several machines
before Google linking can't reach one Identity through the product. Each old
install minted its own Identity and claimed the person's other devices, so
machines disagree about which Identity is "me". Legacy Team migration then
copied one machine's unverified claims into coordinator history. Owner recovery
records an account owner but never switches the device's own Identity, and the
only way to finish was a config edit, a local actor merge, and an admin review
approved with a credential stored on the same machine. That machine then showed
the Google profile without ever signing in. The decisions below replace that
path for ordinary users.

**Decision.** Signing in with Google on a device sets that device's Identity.

| Account state at sign-in | Result |
| --- | --- |
| No active link | Link the device's current Identity (the existing first-link flow). |
| Linked to the device's current Identity | The Identity stays. A device without its own claim, attestation, or binding gets an ownership binding (a self-bind, amended 2026-10-27), so it can manage the account too. |
| Linked to a different Identity | After explicit confirmation, rebind the device to the account's Identity (below). |

**Rebinding an enrolled device.**

- Rebinding requires three proofs bound to one short-lived attempt: an
  attempt-bound OIDC sign-in whose issuer and subject resolve to the target
  Identity's active link, a signature from the device's currently enrolled
  key, and a browser confirmation. The confirmation names the Google account,
  the device's current Identity, the target Identity, the device, and every
  Team effect listed below. A local review digest pins the local state, and
  any local change aborts the attempt.
- The device's current Identity must have no account link of its own. If it
  has one, the flow stops: accounts are never merged, and the user unlinks
  that account first with its own proof.
- The coordinator records an immutable device-to-Identity ownership binding and
  an audit event in one commit that covers every enrollment of that device key.
  The binding supersedes conflicting legacy Team history for that device
  without rewriting the history.
- An active device-claim link may authorize rebinding. This extends the
  operator-only consumer rule in the account-link protocol for this ceremony
  only. A device-claim link still can't authorize fresh-device enrollment,
  invitations, or grants without the existing qualification.
- The device then switches locally: the local actor and this device's binding
  change in one transaction, then the configured Identity follows. The old
  local actor stops being the local actor but stays an active, unmerged
  Identity, because the old Identity stays a Team member and a merged member
  blocks that Team's device eligibility (amended 2026-10-26). `actor_id` and
  `origin_device_id` on existing memories stay as they are (Section 6). Every capture or MCP process re-reads the
  Identity before writing and refuses to write under a superseded one.
- If the coordinator commit succeeds and the local switch fails, the device
  reports "coordinator bound, local switch pending" and resumes from a receipt.
  An unknown outcome means reading status before retrying. Nothing rolls back
  automatically.

**Teams and access.**

- Rebinding never moves Team memberships or Project grants. The target Identity
  keeps its own access. The device gets only what the target Identity already
  has, filtered by each Team's device-eligibility mode and existing exclusions.
  `reviewed_allowlist` Teams are not widened (Section 2).
- For each Team that the old Identity belonged to and the target Identity does
  not, the Viewer queues an existing-Identity membership request for that
  Team's admins (decision A). The old Identity stays a member until an admin
  acts, so other members' devices keep accepting that Identity's history.
- Peers learn about the change only through Team policy updates, never through
  a broadcast of the local merge. (Amended 2026-10-27.) An admin device's
  coordinator device list names the Identity each device's ownership binding
  points to. When that binding names the enrollment's new Identity, the key the
  admin device pinned still matches, and the admin device knows that Identity
  as active, it moves the device to that Identity, so its Projects follow the
  target Identity's access. The moved device counts as a plain coordinator
  enrollment, never as one of the admin's own devices. Otherwise the change
  stays an Identity conflict and the device gets nothing.

**Freshness and notice (narrows decision E).** Rebinding accepts an existing
Google browser session with account selection and does not force
reauthentication. Each rebind writes the audit event, appears on the Identity's
other devices at their next sync with a one-step revoke action, and is limited
to a small number per Identity per day.

**Migration and admin review.**

- Legacy Team migration records only the running device's own assignment as
  verified. Assignments for other devices are unverified labels and grant
  nothing until those devices prove them by rebinding or by their own sign-in.
- Admin review remains for first-owner bootstrap, for accounts where neither
  Identity has a link, for recovery without a usable account, and for
  contradictions that rebinding can't resolve. It is not the normal path for a
  person's own devices.

**What a device sees.**

- A device sees account profile details (name, email, picture), Refresh, and
  Unlink only after it holds its own claim, attestation, or ownership binding
  for that Identity. Another device shows only "Linked on another device" with
  the action to sign in here.
- Account status is per coordinator. The Viewer chooses an enabled enrollment
  to sign the request and does not ask the user for a group.

**Out of scope.** Several Identities on one device, splitting an Identity,
replacing an Identity's Google account, restoring revoked links, required-auth
enforcement, the live relay, and rewriting contradictory migration history.

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

### Repair migrated devices with owner recovery and admin review (Section 8)
- **Pros:** Already shipped in 0.47 betas, with no new coordinator schema.
- **Cons:** Records an owner without switching the device, needs an admin
  credential, leaves Refresh and Unlink unavailable, and lets a device show the
  account profile without its own sign-in.
- **Why rejected:** Not a path a user can finish, and it weakens per-device
  proof. Kept only for the admin cases listed in Section 8.

### Move Team memberships during rebinding (Section 8)
- **Pros:** The device keeps every Team in one step.
- **Cons:** Someone holding a victim's Google session could fold their own
  Identity's Teams into the victim's Identity. It also contradicts "sign-in
  grants nothing".
- **Why rejected:** Membership changes stay with Team admins.

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
  revocation reaches online and offline peers. Section 8 settles this for
  rebinding: no forced reauthentication, a mandatory audit event, notice on
  other devices, and a daily limit. Fresh-device enrollment stays open.

Section 8 also depends on decision A for membership requests and leaves
decision D unchanged: control of a merged alias's memories follows today's
provenance rules until D is decided.

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
- Rebinding (Section 8) needs a coordinator schema change and a Worker
  deployment, and someone holding a victim's Google session can fold their own
  enrolled device into the victim's Identity. The audit event, notice, and
  revoke action are the mitigation.
- Until a Team admin approves a membership request, a rebound device can't
  receive that Team's Projects through the target Identity.

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

### Section 8 slices (0.47.0 stable gate)

Stable 0.47.0 ships after slices S1 to S5. S6 waits on decision A. The
coordinator schema change and Worker deployment in S3 and S5 still need their
own approval.

- **S1. Stop new damage** (Core and Viewer). Legacy migration records only
  self-assignments as verified. My Account drops the group picker, disabled
  actions say why and what to do next, and owner recovery no longer leaves a
  half-switched state. *Check:* a two-machine fixture produces no cross-device
  binding, and the account card offers no action that does nothing.
- **S2. Account visibility.** Profile details, Refresh, and Unlink require the
  device's own claim, attestation, or ownership binding. Other devices show
  "Linked on another device". *Check:* an unproven peer of a linked Identity
  sees no name, email, or picture.
- **S3. Coordinator rebinding attempt** (schema change and Worker). One commit
  writes the ownership binding, sets the Identity on every enrollment of that
  key, and writes the audit event, on SQLite and D1. *Check:* missing any proof
  writes nothing. A current Identity with its own link is refused. An exact
  retry returns the same receipt, and a status read resolves an unknown
  outcome.
- **S4. Local switch.** Config, actor merge, device bindings, and a generation
  marker change in one transaction, with a resumable receipt. *Check:*
  authorship is unchanged, and a capture process holding the old Identity
  refuses to write.
- **S5. Change authority from the ownership binding** (Worker). Refresh and
  Unlink resolve through the binding. *Check:* a rebound device gets Refresh
  and Unlink, and an unproven peer gets neither.
- **S6. Team membership requests**, after decision A. *Check:* no membership
  moves without an admin action.
