# Coordinator Identity enrollment contract

**Status:** Security-reviewed registration boundary; endpoint contracts and implementation remain gated. Not runtime-enabled or approval to activate authentication, provider configuration, Team gating, or deployment.

**Decision basis:** [ADR 0005](../adr/0005-authenticated-identity-device-and-membership-lifecycle.md). This translates accepted product boundaries into a security-review target; detailed mechanisms remain approval-gated.

## Purpose and non-goals

One Identity may have many device keys and belong to many Teams. A verified account owner may add a fresh key to an **existing active linked Identity** without routine Team-admin or old-device approval. The fresh-device ceremony grants no new membership, Project scope, recovery right, relay admission, or browser-to-sync authority. Invitation admission is a separate commit, described below.

This is not the legacy first-account-link ceremony, an account replacement, Google-account switch, revoked-link restoration, general recovery system, or automatic adoption of a populated local store. A browser session ends at its own expiry/logout; it is not a device revocation or sync grant.

## Standards first

Authentication remains the existing coordinator's Google OIDC authorization-code
flow, verified by its maintained OIDC library. Preserve state, nonce, PKCE S256,
issuer/audience checks, and the coordinator's HTTPS callback. Do not add a custom
identity credential, coordinator OAuth authorization server, token endpoint, or
DPoP layer merely to register a device key.

Device registration is an authenticated application authorization action, not a
second authentication protocol. It requires explicit owner confirmation protected
by CSRF/Origin checks and proof of possession of the key being registered. Any
pending request or signed challenge must be scoped, short-lived, single-use, and
bound to the intended coordinator, operation, and key. The reviewed browser/runtime
binding is described below; exact endpoints, quotas and native D1 commit checks
must be specified before the registration endpoint can be implemented.

[OAuth Security BCP (RFC 9700)](https://www.rfc-editor.org/rfc/rfc9700) guides the
OAuth boundary. [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252) and
[PKCE (RFC 7636)](https://www.rfc-editor.org/rfc/rfc7636) apply if a runtime is an
OAuth native client; that is not today's confidential coordinator client. A local
application callback alone does not make a custom handoff RFC-compliant. Google's
callback remains HTTPS on the coordinator; this draft does not change client type.

The boundary below does not invent or duplicate OAuth. Removing a proof from an
existing flow still requires a threat-model review; calling another step
“standard” does not make that removal safe.

### Accepted enrollment authentication policy

An existing Google session may be used in a new, attempt-bound OIDC transaction,
followed by explicit device confirmation. Enrollment does not require fresh password
entry or a recent `auth_time` claim. An existing Codemem management cookie by itself
does not replace that transaction. Control of the Google session can therefore
authorize a new device; enrollment visibility, safe audit events, and device
revocation are required safeguards, not proof that account takeover is impossible.

Google [documents its OIDC parameters](https://developers.google.com/identity/openid-connect/openid-connect):
`prompt` supports `none`, `consent`, and `select_account`; optional `auth_time`
requires settings enablement. Do not assume that `max_age` or `prompt=login`
can force fresh credential entry. No provider settings change is authorized here.

## Authority boundary

| Fact | Authority | Never inferred from |
| --- | --- | --- |
| Existing Identity for an account | Server lookup of active exact `issuer` + `sub` link | Client actor ID, email, name, label, invitation claim |
| Fresh key possession | Signature by that exact pending key | Browser session or invitation bearer |
| Account ownership for this attempt | Verified provider result bound to original browser transaction; existing Google session permitted | Retained Google token, profile fields, or Codemem management cookie alone |
| Team membership / Project scope | Current peer-local recipient policy and authorized scope reconciliation | Device enrollment or browser sign-in |
| New-person admission | Reviewed invitation or operator bootstrap policy | Ordinary sign-in alone |
| Group enrollment / sync transport | Active server-trusted Identity group grant | Unreviewed enrollment actor claims or discovery-group membership as a Project grant |
| Controller review | Existing reviewed controller/admin authority for first-account linking | Fresh-key possession or owner enrollment as a new controller attestation |

The local backend retains its private key and local proofs. The coordinator stores commitments and safe audit facts only; no private proof is available by GET, polling, logs, or durable browser storage. A fresh-key signature proves possession only. It cannot authorize itself, an Identity, a Team, or an invite. The existing no-retained-Google-token rule applies unchanged.

## Entry paths

| Path | Identity result | Account/link rule | Device result |
| --- | --- | --- | --- |
| Legacy existing-Identity first link | Existing Identity | Existing controller/admin review unchanged | Existing enrolled signer only; no new enrollment |
| Fresh device for active linked account | Existing linked Identity | Server resolves exact active `issuer` + `sub` | Bind the pinned pending key after owner confirmation and signed completion |
| Existing authenticated Identity accepts another Team invite | Same existing Identity | Verify its current active link; do not create another link | Preserve device bindings; add only invited Team membership |
| New-person authenticated Team invite | New assigned Identity | Explicit verified-account binding in a separately reviewed admission ceremony | Bind invitation's pending device |
| Operator first owner | New first Identity | Operator- or invitation-trusted bootstrap, separately reviewed | Enroll in discovery group before a Team exists |

A discovery group is enrollment/discovery infrastructure, not a Team and grants nothing. The first-owner path must not create an auth-needs-Team cycle.

Existing `legacy_enrollment`, `project_share`, `add_device`, and `team_member` invitation paths retain their current behavior; this draft does not reroute them. Today's `team_member` path still mints a server-assigned Identity. Authentication requirements for legacy/unlinked invitation recipients remain a separate compatibility decision.

## Reviewed fresh-device registration boundary

Reuse existing OIDC, CSRF, signature, nonce and literal-loopback validation;
do not add another authentication protocol. Current `authorizeRequest` requires
an existing enabled enrollment, so a pending key needs a separately scoped
possession check. Creating a pending request grants nothing. Exact route/schema,
quotas and native D1 commit details still gate the endpoint.

1. The runtime checks local adoption eligibility, binds a literal loopback listener, and signs the pending request with the key being registered. The server verifies that signature without treating the key as enrolled. Coordinator/origin, purpose, key/fingerprint, device ID, attempt ID and callback address are fixed at start. No client-selected Identity or group grants are accepted.
2. The server creates one ten-minute, single-use request and stores only the browser-start commitment and other immutable bindings needed for the operation. Once OIDC resolves an Identity, it pins the active account-link row and the trusted Identity-group grant revision set. This path consumes no invitation.
3. The original browser claims the request and completes its own OIDC transaction. Use the documented `prompt=select_account` to make the selected account visible; this is not forced password entry. An existing Google session is accepted. State, nonce, PKCE and normal ID-token validation remain required; an existing Codemem session must not skip this purpose-bound transaction.
4. The server resolves only the verified exact `issuer` + `sub` to an active link. Unknown, revoked, conflicting, or replacement links deny the attempt; they do not reserve or preclaim an Identity indefinitely.
5. The CSRF/Origin-protected confirmation names the account, resolved Identity, device label and short key fingerprint. The local viewer or CLI shows the same fingerprint. Warn: continue only if this computer started enrollment; never paste a callback URL or completion code. The one-use completion secret is delivered only through the fixed loopback handoff.
6. Finalization is signed by the exact pending key and carries that completion secret, the purpose, coordinator ID and immutable request bindings. The server commits only after current-state checks pass. The original-cookie browser receives safe status after finalization; registration mints no new browser session.

The pending-key signature binds completion to the requested key. Intercepting a
completion secret alone cannot register another key. A separate runtime verifier
is optional defense-in-depth for this new operation, not a replacement for key
proof or a requirement to invent another credential. The existing first-account
link flow retains both of its reviewed secrets unchanged.

Neither a runtime verifier nor a signature stops an attacker who starts their own
request and persuades the owner to paste its completion URL back. Explicit
key/device confirmation, warnings, visible enrollment history and revocation are
required; do not claim loopback or PKCE prevents that social-engineering case.

## Attempt state and failure rules

| State | Allowed transition | Effect |
| --- | --- | --- |
| `pending` | Original browser claims | No Identity or grant mutation |
| `browser_claimed` | Verified OIDC resolves active link | Account binding becomes immutable |
| `oidc_verified` | Same browser confirms | Completion commitment written once |
| `confirmed` | Pending key signs completion for the same request | Atomic enrollment only |
| `finalized` | Original browser observes signed result | Safe status only; no new browser session |
| `expired` / `failed` / `retired` | Terminal | No grant change |

Attempts are short lived, single purpose, and idempotent only for the exact attempt/key/account tuple. Invitation attempts additionally bind their reviewed invitation snapshot. Cancellation racing commit returns the actual outcome. A failure may retire an attempt, including a proof failure; clients must not assume every invalid proof leaves it reusable. Restart reconciliation returns a safe status and never reconstructs browser secrets.

Public status contains no proof, provider claim, private loopback destination, or admission inference. Do not poll or log private handoff URLs, form bodies, proofs, tokens, or browser secrets.

## Atomic commit and eligibility

This section applies to fresh-device enrollment for an already-linked Identity,
not invitation admission. SQLite and D1 must make the same guarded decision
atomically. The winning compare checks only coordinator-owned facts: request and
completion commitment, pinned key, exact active account link, Identity-group grant
revision set, auth configuration revision, unarchived groups, no device/key
collision, and no coordinator-wide revocation record. The coordinator does not
store local Team membership versions or verify local database adoption eligibility.
A stale or zero-row compare is not success. An unconfirmed commit is unknown,
never success or a claim that nothing changed; reconcile through authorized status.

Commit may bind the fresh key to the resolved Identity only when all remain true:

- The link is active and exact, not replaced, switched, or revoked.
- No coordinator-wide device/key-revocation tombstone blocks it.
- The Identity's existing grants are preserved without adding Team-wide Project scope.

The runtime checks local adoption eligibility before starting and again before
local materialization. If local data changes after remote finalization, report
that the coordinator binding exists but local adoption failed; do not sync or
claim the remote binding was rolled back.

### Trusted Identity-group grants

Add a coordinator-owned, revisioned Identity/group grant independent of device
rows. Its reviewed issuance and revocation survive an old device going offline,
being disabled or removed. This is transport enrollment authority, not Team or
Project access. Finalization inserts only the pinned key into groups authorized
by current active grants; it does not create controller attestations or scopes.

Allowed initial provenance is an admin-reviewed controller attestation or a
consumed `team_member` invitation with a server-assigned Identity. Future
admin-issued `add_device` provenance must be recorded explicitly at issuance.
Existing `add_device` receipts cannot be distinguished reliably by issuer and
are not a safe automatic backfill source. Never infer grants from
`enrolled_devices.identity_id`, caller actor claims, `project_share`, or legacy
enrollment. Materializing a grant from old evidence requires explicit review of
that evidence, not a background guess.

### Coordinator-wide device revocation

Add durable device-ID and key-fingerprint revocation records independent of
enrollment rows. Current group removal hard-deletes rows and current enrollment
upserts can re-enable disabled devices; those paths are not global revocation.
Every enrollment writer, invite acceptance, join approval and signed-device
authorization must check the new record. Writers must compare it atomically with
their writes on both SQLite and D1. New owner registration is insert-only and
refuses existing device/key collisions; no silent resurrection or key replacement.

Per-Team exclusions do not block the Identity binding. They filter only that
Team's derived eligibility and must survive enrollment/upsert. A Team cannot veto
the device's unrelated memberships or direct grants. Today's `person_all_devices`
eligibility treats any decision row as a whole-Team conflict; scoped exclusion
support must be corrected and tested before the pilot claims this behavior.

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

1. Reviewed registration boundary, bounded endpoint contract (unmounted) and source-only foundation.
2. Trusted Identity-group grants and coordinator-wide revocation guards on every writer, with SQLite/D1 parity tests.
3. Owner registration and browser integration, including purpose/schema separation from first-account linking.
4. Device-eligibility semantics and existing-Identity invitation path.
5. Sign-in/enrollment UI, retaining the legacy reviewed-first-link exception.
6. Fake-provider browser, restart/offline, and direct-sync compatibility tests.
7. Live configuration approvals, then a live pilot.

No Team may claim required-auth readiness until the separate permission policy is built and approved. Reusable paused core helpers are unvalidated. Helpful debt work is limited to shared ownership checks across CLI/viewer, centralized validation, one DTO/protocol source, and SQLite/D1 parity tests—not unrelated refactors or a generic job framework.

## Acceptance matrix

| Scenario | Expected result | Source seam / test boundary |
| --- | --- | --- |
| Active linked owner + pinned pending-key signature + one-use completion | One eligible binding; no new membership or Project grant | New registration store contract; SQLite/D1 parity |
| Browser sign-in only, key signature only, or completion without pending-key signature | No binding or grant | Browser transaction + finalization integration |
| Unknown or revoked account attempts normal sign-in | No session, Identity claim, or reserved first link | Exact link lookup and tombstone tests |
| Fresh key calls existing signed route | Denied as unknown device | `authorizeRequest` behavior |
| Existing Identity accepts second Team invite | Same actor/devices; invited membership only | Invite create/accept shared contract |
| Invite bearer lacks provider binding or key proof | No admission or consumption success | Invite snapshot/commit race tests |
| Coordinator-wide device revocation before commit | No binding or access resurrection | Version compare and tombstone tests |
| Team exclusion before/after enrollment | Binding and unrelated access preserved; excluded Team access denied | Team eligibility and upsert tests |
| Populated local store attempts adoption | Conflict; no actor/provenance rewrite | Local eligibility guard tests |
| Cancellation, replay, restart, SQLite/D1 outage | Actual safe outcome; grants unchanged unless commit won | Idempotency and fault-injection parity tests |
| Attacker's start URL opened on owner's computer | Confirmation shows the attacker's key fingerprint and warns against pasting; enrollment cannot finish without loopback completion. If the owner pastes that secret to the attacker, enrollment can succeed and must be visible and revocable | Phishing, audit and revocation fixtures |
| Old device revoked after reviewed Identity-group grant | Grant persists; fresh owner registration needs no old-device approval | Transport-grant lifecycle tests |

## Unresolved decisions

- Exact pending-device endpoint shapes, rate limits, storage schema, and safe public error vocabulary.
- Existing-Identity invite targeting/redemption, eligible signing key, new-person first-binding proof, legacy unlinked-recipient compatibility, and first-owner bootstrap detail.
- Identity-group grant issuance/revocation revision protocol and native D1 compare/write implementation. Identity binding alone is insufficient for existing group-signed APIs.
- `reviewed_allowlist` conversion/default policy.
- Auth-required scope and overlapping Team/direct-grant policy; strictest Project rule is not approved.
- Signed permission issuer/wire format/enforcement and historical memory-control migration.
