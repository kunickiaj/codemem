# Coordinator Identity enrollment contract

**Status:** Draft proposed protocol. Not implemented, runtime-enabled, or approval to activate authentication, provider configuration, Team gating, or deployment.

**Decision basis:** [ADR 0005](../adr/0005-authenticated-identity-device-and-membership-lifecycle.md). This translates accepted product boundaries into a security-review target; detailed mechanisms remain approval-gated.

## Purpose and non-goals

One Identity may have many device keys and belong to many Teams. A verified account owner may add a fresh key to an **existing active linked Identity** without routine Team-admin or old-device approval. The fresh-device ceremony grants no new membership, Project scope, recovery right, relay admission, or browser-to-sync authority. Invitation admission is a separate commit, described below.

This is not the legacy first-account-link ceremony, an account replacement, Google-account switch, revoked-link restoration, general recovery system, or automatic adoption of a populated local store. A browser session ends at its own expiry/logout; it is not a device revocation or sync grant.

## Authority boundary

| Fact | Authority | Never inferred from |
| --- | --- | --- |
| Existing Identity for an account | Server lookup of active exact `issuer` + `sub` link | Client actor ID, email, name, label, invitation claim |
| Fresh key possession | Signature by that exact pending key | Browser session or invitation bearer |
| Account ownership for this attempt | Verified provider result bound to original browser transaction; freshness policy unresolved | Retained Google token or profile fields |
| Team membership / Project scope | Current server policy and membership records | Device enrollment or browser sign-in |
| New-person admission | Reviewed invitation or operator bootstrap policy | Ordinary sign-in alone |
| Group enrollment / sync transport | Separately authorized per-group eligibility; derivation contract unresolved | Identity binding alone or discovery-group membership as a Project grant |
| Controller review | Existing reviewed controller/admin authority for first-account linking | Fresh-key possession or owner enrollment as a new controller attestation |

The local backend retains its private key and local proofs. The coordinator stores commitments and safe audit facts only; no private proof is available by GET, polling, logs, or durable browser storage. A fresh-key signature proves possession only. It cannot authorize itself, an Identity, a Team, or an invite. The existing no-retained-Google-token rule applies unchanged.

## Entry paths

| Path | Identity result | Account/link rule | Device result |
| --- | --- | --- | --- |
| Legacy existing-Identity first link | Existing Identity | Existing controller/admin review unchanged | Existing enrolled signer only; no new enrollment |
| Fresh device for active linked account | Existing linked Identity | Server resolves exact active `issuer` + `sub` | Bind one pending fresh key after dual proof |
| Existing authenticated Identity accepts another Team invite | Same existing Identity | Verify its current active link; do not create another link | Preserve device bindings; add only invited Team membership |
| New-person authenticated Team invite | New assigned Identity | Explicit verified-account binding in a separately reviewed admission ceremony | Bind invitation's pending device |
| Operator first owner | New first Identity | Operator- or invitation-trusted bootstrap, separately reviewed | Enroll in discovery group before a Team exists |

A discovery group is enrollment/discovery infrastructure, not a Team and grants nothing. The first-owner path must not create an auth-needs-Team cycle.

Existing `legacy_enrollment`, `project_share`, `add_device`, and `team_member` invitation paths retain their current behavior; this draft does not reroute them. Today's `team_member` path still mints a server-assigned Identity. Authentication requirements for legacy/unlinked invitation recipients remain a separate compatibility decision.

## Fresh-device ceremony

The existing account-link two-proof literal-loopback pattern is the preferred model where it fits. Its current `authorizeRequest` requires an existing enabled enrollment, so it cannot start enrollment for an unknown, unregistered key. A new bounded, throttled public start is required; its route, schema, and error enums are intentionally unchosen.

1. The fresh runtime creates a key pair, pins coordinator origin, discovery group, and server identity, binds a literal loopback listener, and submits a public start with its key and commitments. This proves no authority and grants nothing.
2. The server creates one short-lived pending-device attempt. It saves immutable coordinator/origin, group, server identity, exact key/fingerprint, attempt ID, browser-binding commitment, runtime-verifier commitment, and configuration versions. Once the verified account resolves an Identity, it pins the relevant membership and revocation versions before confirmation. This path consumes no invitation.
3. The original browser claims the attempt and completes an OIDC transaction bound to that attempt. Fresh network OIDC alone is not proof of fresh interactive authentication; acceptable `max_age`/prompt behavior, claim validation, and threshold remain security decisions.
4. The server resolves only the verified exact `issuer` + `sub` to an active link. Unknown, revoked, conflicting, or replacement links deny the attempt; they do not reserve or preclaim an Identity indefinitely.
5. The browser explicitly confirms the named account, resolved Identity, and pending device. It sends a one-time completion proof only to the exact loopback handoff. Original-cookie browser completion is available only after signed finalization.
6. The runtime finalizes with a request signed by the pending key carrying both independent secrets: the raw runtime verifier, committed at start and never sent to the browser, and the browser completion secret. Both must match their stored commitments and the same attempt. The signature proves key possession and replaces neither secret. The server commits only after current-state checks pass.

Example: possessing the key and a leaked completion secret is insufficient without the runtime verifier. A browser that signs in but cannot complete pending-key signed finalization with both secrets creates no device binding. Failed proof checks may retire the attempt.

## Attempt state and failure rules

| State | Allowed transition | Effect |
| --- | --- | --- |
| `pending` | Original browser claims | No Identity or grant mutation |
| `browser_claimed` | Verified OIDC resolves active link | Account binding becomes immutable |
| `oidc_verified` | Same browser confirms | Completion commitment written once |
| `confirmed` | Pending key finalizes with both proofs | Atomic enrollment only |
| `finalized` | Original browser observes signed result | Status/session handling only |
| `expired` / `failed` / `retired` | Terminal | No grant change |

Attempts are short lived, single purpose, and idempotent only for the exact attempt/key/account tuple. Invitation attempts additionally bind their reviewed invitation snapshot. Cancellation racing commit returns the actual outcome. A failure may retire an attempt, including a proof failure; clients must not assume every invalid proof leaves it reusable. Restart reconciliation returns a safe status and never reconstructs browser secrets.

Public status contains no proof, provider claim, private loopback destination, or admission inference. Do not poll or log private handoff URLs, form bodies, proofs, tokens, or browser secrets.

## Atomic commit and eligibility

This section applies to fresh-device enrollment for an already-linked Identity, not invitation admission. SQLite and D1 must make the same guarded decision atomically. The winning compare includes live attempt/proofs, exact current account link, pending key/device collision checks, current membership and revocation versions, group and server identity. A stale or zero-row compare is not success. An unconfirmed commit is reported as unknown, never as success or as unchanged; the client reconciles through authorized status.

Commit may bind the fresh key to the resolved Identity only when all remain true:

- The link is active and exact, not replaced, switched, or revoked.
- No coordinator-wide device/key-revocation tombstone blocks it.
- The Identity's existing grants are preserved without adding Team-wide Project scope.
- Local adoption is eligible.

Per-Team exclusions do not block the Identity binding. They filter only that Team's derived eligibility and must survive enrollment/upsert. A Team cannot veto the device's unrelated memberships or direct grants.

The normal authenticated-Team default must accept owner-enrolled devices. An existing `reviewed_allowlist` is not widened silently; retaining it or converting it to the default needs an explicit policy choice. Coordinator-wide device/key tombstones block re-enrollment; Team exclusions block only access through that Team. The approved 24-hour permission ceiling does not make permissions implemented: issuer, wire format, bindings, and enforcement remain separate gates.

Revocation before commit denies. After commit it follows the actual revocation mechanism; this contract makes no promise of instant offline erasure. Delivered replicas remain physical data. Browser logout and eight-hour session expiry do not revoke a device.

## Invitations, stores, and memory

An existing authenticated Identity accepting another Team invitation must add only the reviewed snapshot's Team membership and must not mint an actor or rebind a device. A verified provider result for this attempt that resolves to its existing active link proves account ownership; no new link is created. Invite possession is not account ownership; provider ownership is not admission. The commit needs the server-reviewed invite, verified ownership, and a scoped key-possession proof. Which existing enrolled key is eligible, and how a pending new device first enrolls, must be fixed in the separate invite protocol before implementation.

For a new person joining an authenticated Team, a separate invitation admission commit assigns the new Identity, binds its verified account and pending device, and adds exactly the reviewed invitation's membership. Unlike ordinary fresh-device enrollment, this path may admit an unknown account using explicit invitation/operator authority. Its proof and atomic first-binding contract remain unresolved. Ordinary sign-in cannot claim any known Identity. Admin/invite authority must come from server-reviewed policy, not an unauthenticated new key.

Do not migrate `actor_id` or `origin_device_id`, merge by email/name, or infer ownership from a device. A populated local store refuses automatic adoption. A fresh store may install its local actor only after a distinct reviewed eligibility guard checks more than “zero memories”: existing grants, keys, and assignments also matter.

## Current seams and delivery order

Source evidence, not shipped enrollment evidence:

- [`authorizeRequest`](../../packages/core/src/coordinator-api.ts) loads an existing enrollment before checking its signature; it cannot authorize a pending unknown device.
- `POST /v1/admin/invites` forbids caller-supplied `assigned_identity_id`, and current invite kinds are limited to legacy, project-share, Team-member, and add-device paths in [`coordinator-api.ts`](../../packages/core/src/coordinator-api.ts).
- Current recipient acceptance calls `assertAddDeviceIdentityAdoptionAllowed` in [`coordinator-actions.ts`](../../packages/core/src/coordinator-actions.ts); the new populated-store guard needs review rather than assumption.
- The existing account-link flow and its SQLite/D1 guarded pattern are in the [coordinator auth protocol](coordinator-auth-protocol.md) and [link storage contract](coordinator-auth-link-storage.md).

1. Security approval of this contract and pending-device protocol.
2. Pending-device enrollment plus shared SQLite/D1 contract tests.
3. Existing-Identity invitation path.
4. Revocation and device-eligibility semantics.
5. Sign-in/enrollment UI, retaining the legacy reviewed-first-link exception.
6. Fake-provider browser, restart/offline, and direct-sync compatibility tests.
7. Live configuration approvals, then a live pilot.

No Team may claim required-auth readiness until the separate permission policy is built and approved. Reusable paused core helpers are unvalidated. Helpful debt work is limited to shared ownership checks across CLI/viewer, centralized validation, one DTO/protocol source, and SQLite/D1 parity tests—not unrelated refactors or a generic job framework.

## Acceptance matrix

| Scenario | Expected result | Source seam / test boundary |
| --- | --- | --- |
| Active linked owner + fresh matching key + both proofs | One eligible binding; no new membership or Project grant | New pending-device store contract; SQLite/D1 parity |
| Browser sign-in only, key signature only, or signed completion without runtime verifier | No binding or grant | Browser transaction + finalization integration |
| Unknown or revoked account attempts normal sign-in | No session, Identity claim, or reserved first link | Exact link lookup and tombstone tests |
| Fresh key calls existing signed route | Denied as unknown device | `authorizeRequest` behavior |
| Existing Identity accepts second Team invite | Same actor/devices; invited membership only | Invite create/accept shared contract |
| Invite bearer lacks provider binding or key proof | No admission or consumption success | Invite snapshot/commit race tests |
| Coordinator-wide device revocation before commit | No binding or access resurrection | Version compare and tombstone tests |
| Team exclusion before/after enrollment | Binding and unrelated access preserved; excluded Team access denied | Team eligibility and upsert tests |
| Populated local store attempts adoption | Conflict; no actor/provenance rewrite | Local eligibility guard tests |
| Cancellation, replay, restart, SQLite/D1 outage | Actual safe outcome; grants unchanged unless commit won | Idempotency and fault-injection parity tests |

## Unresolved decisions

- Fresh-interaction threshold and provider-claim validation for enrollment.
- Exact pending-device endpoint shapes, rate limits, storage schema, and safe public error vocabulary.
- Existing-Identity invite targeting/redemption, eligible signing key, new-person first-binding proof, legacy unlinked-recipient compatibility, and first-owner bootstrap detail.
- Authorized per-group enrollment derivation from existing Identity eligibility, including what the fresh-device commit writes. Identity binding alone is insufficient for existing group-signed APIs.
- `reviewed_allowlist` conversion/default policy.
- Auth-required scope and overlapping Team/direct-grant policy; strictest Project rule is not approved.
- Signed permission issuer/wire format/enforcement and historical memory-control migration.
