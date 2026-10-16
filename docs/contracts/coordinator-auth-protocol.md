# Coordinator account-link protocol candidate

**Status:** Optional flow, disabled by default; live Google/provider enablement remains a separate approval

## Purpose and limits

This candidate implements the optional coordinator account-management flow
approved in [ADR 0004](../adr/0004-authenticated-identity-and-live-relay-boundaries.md).
It completes a link only for an existing Identity and device; it creates no
actor, device enrollment, Project access, sync admission, recovery path, relay,
production coordinator configuration or provider deployment, or mandatory-auth
activation.

The mapping remains one Google account to one existing actor-backed Identity per
coordinator, and one link per Identity. Issuer plus subject is the account key;
email, name, and picture never prove ownership or select an Identity. Revoked
link rows remain uniqueness conflicts.

A first link has one of two authority sources: an admin-reviewed controller
attestation, or a planned device claim for an enrolled device whose Identity is
unassigned or matches the requested Identity. Device claims pass the complete
device-claim eligibility guard; attested links keep their existing attestation
checks. See [Device-claim first link](#device-claim-first-link-planned).

The coordinator HTTPS origin is configured and pinned. Google uses `openid email
profile`; the flow requests neither `offline_access` nor Google's
`access_type=offline`, and retains no Google access,
refresh, or ID token after the ceremony. Use a mature portable OIDC library for
authorization-code validation, including S256 PKCE, `state`, and `nonce`.
Use `openid-client` 6.x with explicit JWS validation through
[`enableNonRepudiationChecks`](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md).
If UserInfo is needed, pass the verified ID-token subject to `fetchUserInfo`;
never skip that match. Provider endpoints come only from trusted configuration
and validated discovery, not request parameters.

## Attempt creation

For initial linking, the runtime starts a 10-minute, single-use attempt over the
pinned coordinator origin. It supplies its existing signed-device request;
`authorizeRequest` in `coordinator-api.ts` checks the group/enrollment, stored public key,
signature, freshness, and nonce. That check proves key possession, not Identity
ownership; neither its result nor a caller label is link authority by itself.
Authority comes from a controller attestation or from the device-claim guard below.

The runtime generates:

- a 32-byte random runtime verifier and sends only SHA-256 of its raw bytes;
- a separate 32-byte random browser-start code and sends only SHA-256 of its raw bytes;
- a random public `attemptId`, which is not a credential.

The coordinator stores a pending attempt with the coordinator ID, actor ID,
enrolled device ID, pinned public key and fingerprint, runtime-verifier and browser-start commitments,
group ID, configured issuer, and auth-config revision. Every attempt (planned)
also records its server-derived authority kind. Those fields and the local callback
target are immutable. The runtime does not create or receive the browser-completion
secret at attempt creation; knowing both proofs at initiation would defeat their separation.

The runtime binds and holds its loopback listener before creating the attempt,
then registers this literal destination exactly:

```text
http://127.0.0.1:<selected-port>/codemem/auth/complete
http://[::1]:<selected-port>/codemem/auth/complete
```

The coordinator rejects another scheme, hostname, credentials, query, fragment,
path, external override, or later destination change. Creation returns trusted
coordinator/attempt metadata, not the raw runtime verifier or completion secret.
The device command builds the private browser-start URL locally with the
one-time start code. Browser routes mount only through explicit optional server
configuration; default coordinators leave them off. The code
is not a Google credential or permission grant; it prevents a
public attempt ID alone from claiming that device's flow. Do not share or log
the start URL.
`parseCoordinatorAuthLoopback` implements this exact syntax check, including an
explicit canonical decimal port from 1 through 65535. Preserve the returned
destination verbatim, including `:80`; URL normalization is not an authorization
step. Signed device creation validates this target. The listener accepts one
GET for its outstanding attempt, matching the exact literal Host and port,
saved path, and only `attempt_id` plus canonical `completion`. It rejects other
methods, duplicate or extra parameters, absolute-form targets, and prefetch or
non-navigation requests, and returns a `no-store`, `no-referrer` response.

## Browser OIDC and confirmation

The browser-entry handlers implement `GET /auth/link/start?attempt_id=...&start_code=...`
as a page only: it does not claim an attempt or start provider authorization.
GET and POST reject URLs longer than 8,192 characters before parsing the URL or
query, reading cookies, or calling the provider or store.
The page uses the existing pre-start cookie and CSRF token, with exactly
`csrf`, `attempt_id`, and `start_code` in a POST to the clean `/auth/link/start`
address. The optional app composition mounts this entry with the callback,
confirmation, completion, account, and logout handlers as one setup.

The POST checks exact Origin before spending the shared browser-form quota,
requires the cookie-bound CSRF token and canonical 32-byte code, and promotes
the same pre-start cookie value only after atomic admission. Existing transaction
cookies block a new start; existing browser sessions remain untouched. The form
page uses `Referrer-Policy: same-origin` so its POST retains a usable Origin;
the separate provider-continuation page uses `no-referrer` and carries no start
code. Gateways must omit the private handoff query, Referer, and form body from
logs. No account, device, or sharing permission comes from opening this page.

The atomic claim matches its raw-byte hash to the signed device attempt's saved
commitment before recording the browser cookie binding. Missing or wrong codes
leave the attempt and provider material untouched. Once claimed, the original
browser binding controls progress; the code cannot claim another browser.
Public creation must require the commitment, and public start must require the
code. Nullable legacy commitments exist only for internal compatibility; they
are not a public fallback, and blind compatibility claims cannot bypass a saved
non-null commitment. The device still does not know the later completion secret.

Initiation creates a host-only `__Host-codemem-auth-transaction` cookie with
`HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`, plus a CSRF value.
The browser transaction binds the exact attempt and
OIDC `state`, `nonce`, and PKCE verifier. The configured OIDC redirect URI is a
preconfigured HTTPS coordinator callback only, with `response_mode=query`.

Browser-transaction persistence is implemented but pending handler integration under the [browser-transaction storage contract](coordinator-auth-browser-transaction.md): it stores only transaction commitments and pending SDK nonce/PKCE material, not cookies or CSRF values. Future route work must retain the approved CSRF value **and** same-origin/Origin validation; it must not replace that protection with Origin-only checks. The callback remains a fixed configured HTTPS URI, never one derived from a request header, and the existing stored device attempt alone controls the literal loopback second hop.

The storage contract now supports explicit sign-in cancellation and trusted-config
retirement before callback, but neither is an HTTP handler. Public routes still
need the required cookie, CSRF, Origin, proof, and failure-order integration;
retirement is not physical cleanup or capacity recovery.

At that callback, the coordinator verifies the browser cookie and exact state,
nonce, PKCE, issuer, signature, audience, expiry, and provider subject. It holds
only verified minimal account claims and the confirmed issuer/subject in the
pending attempt. The callback writes no link, enrollment, browser session, or
Identity binding.

The confirmation page names the account, target Identity, and requesting device.
Its explicit confirmation requires CSRF protection and same-origin validation.
On success, the coordinator generates the separate random 32-byte completion
secret and stores only SHA-256 of its raw bytes. Proofs use canonical base64url
encoding in transit; hash comparisons use constant-time comparison. The browser receives an explicit link only to the immutable loopback URL
with `attempt_id` and `completion` query fields. It uses `Cache-Control:
no-store`, `Referrer-Policy: no-referrer`, and a restrictive CSP.

The `createCoordinatorBrowserLinkHandlers` continuation receives only
the existing callback's verification outcome and original browser binding. It offers
the confirmation screen but creates no account link, session, or stored profile.
Confirmation builds the return page before writing and sends its private link
only after the store confirms the write. The requesting device still supplies
its independent proof before the link becomes permanent.

Confirm and cancel POSTs use the existing exact-Origin and CSRF guard and resolve
the attempt through the original browser cookie. Cancellation affects only that
attempt and explicitly retires its temporary provider material before reporting
success or clearing the transaction cookie. A storage or cleanup fault returns
an error without clearing the cookie; no rollback is promised after a committed
failure. General maintenance runs only through an explicit operator call or
the optional scheduled handler; no request performs a general purge.

If the confirmation screen is lost or reloaded, its verified attempt is not
reopened and the profile is not reconstructed from storage. The user must cancel
from the requesting device or wait for expiry and start again. If confirmation
commits but its return page is lost, the original confirmation form can still
cancel the attempt. Scheduled maintenance must finish erasing temporary material
when a cancellation commits but its cleanup fails.

Runtime polling requires the attempt device's signed request; browser polling
requires its original transaction cookie. A public attempt ID is not authorization.
Polling exposes status only. It never returns a browser-completion secret, raw
account details, provider tokens, or a session secret. A callback replay, expired
attempt, state mismatch, or consumed attempt fails closed.

Once the local listener receives the completion proof, it offers an explicit
`Finish linking` link to `GET /auth/link/complete?attempt_id=...` at the runtime's
pinned coordinator origin. The link includes only its own public attempt ID,
never a proof or a browser-supplied return target, and uses `no-referrer`.
The listener does not redirect automatically. The
completion handler checks the original transaction cookie before showing status.
A confirmed attempt shows a read-only waiting page; a finalized attempt offers
an explicit CSRF-protected `POST /auth/link/complete` form. GET never creates a
session or clears a cookie.

The POST must also confirm finalized state before preserving an existing live
browser session or redeeming a new one. Preservation atomically consumes the
attempt while keeping the existing session unchanged, so replaying without that
session cannot mint another. New issuance uses the cookie-bound atomic redeem,
never the trusted compatibility method. Session credentials leave the server
only after an issued result; rejection or uncertainty preserves the transaction
cookie. Existing sessions are not replaced, and initial-link profiles are not
stored. The optional composition connects these handlers and signed device
routes. Actual browser navigation, live Google setup, and remote database
verification remain pilot requirements.

### Persisted attempt states

| Transition | Driver and guard |
| --- | --- |
| `pending` → `browser_claimed` | First browser claim records its transaction-cookie hash; further claims fail |
| `browser_claimed` → `oidc_verified` | Callback matches cookie, state, nonce, PKCE and verified claims; account fields become immutable |
| `oidc_verified` → `confirmed` | Same browser confirms once with CSRF proof; completion-secret hash written once |
| `confirmed` → `finalized` | Signed device finalization and all atomic authority/proof checks below |
| `finalized` → `session_redeemed` | Original browser redeems once within two minutes, with active link/config and CSRF checks |
| Any unfinished state → `expired` | Ten-minute attempt deadline passed; no new link or session |
| Any unfinished state → `failed` | Cancellation by the attempt's signed device request or original browser transaction cookie, or irrecoverable provider/config failure; no grants |

The ten-minute deadline applies through finalization; session redemption must
also occur before that original deadline. Wrong proofs fail without consuming
the attempt or overwriting state. Restart retains authoritative state; it never
reopens consumed attempts or creates browser ownership from a request label.

## Runtime finalization and ownership

The device API is opt-in through `createCoordinatorApp({ authLink: ... })` with
trusted browser configuration and a store factory that supplies both request
authentication and link operations. Absent or disabled configuration leaves the
four attempt routes at `404`. The configured Worker mounts them when optional
browser authentication is ready.

| Route | Signed input and result |
| --- | --- |
| `POST /v1/auth/link-attempts` | Requires `group_id`, `identity_id`, `authority`, `attempt_id`, `runtime_verifier_hash`, `browser_start_hash`, and the literal `loopback_redirect`. Returns public status, server-evaluated `identity_id` and `authority`, and configured `coordinator_id`, never proofs or a private start URL. |
| `GET /v1/auth/link-attempts/:attemptId?group_id=...` | The attempt device's signed request reads public status; a different device and a missing attempt both receive an unavailable response. |
| `POST /v1/auth/link-attempts/:attemptId/finalize` | Exact purpose, coordinator/attempt/group/Identity/device/fingerprint fields and canonical raw `runtime_verifier`/`completion` proofs. The path and body attempt must match; the server hashes decoded 32-byte proofs. Client-nominated proof hashes are rejected. |
| `POST /v1/auth/link-attempts/:attemptId/cancel` | Signed `group_id` only; fails the requester's bound attempt and retires its temporary provider material before reporting success. |

Bodies are limited to 4 KiB and exact fields. Authentication uses the existing
stored enrollment key, signature, timestamp and nonce, with a separate
per-device quota using the existing limits; SQL
still supplies the attempt's authority. Browser sessions or Google
claims are not device authorization. Storage or cleanup faults report no success
and disclose no proof or private cause. The local command and listener are
implemented, along with optional app mounting; real browser checks remain outstanding.
This option changes no enrollment or access.

### Current-account link status

`GET /v1/auth/account-link-status?group_id=...&coordinator_origin=...&identity_id=...` reports the
signed device's own account-link state. It requires the ready browser-auth adapter, not merely the
legacy link-attempt option; absent or unavailable browser auth returns `503`.
Requests must use the configured callback origin, contain exactly one `group_id`
and one `coordinator_origin` and one `identity_id` query parameter and no body, and pass existing
enrollment, signature, nonce and rate-limit checks. The signed `coordinator_origin` must equal the configured
callback origin, preventing another coordinator from forwarding the request to
read account metadata. Responses are never cached.

The version-2 response includes `coordinatorId`, `groupId`, `deviceId`,
`fingerprint`, `identityId`, `state`, `authority`, and `account`. Review-required
and conflict responses contain no Identity, authority or account metadata.
Linked responses allow only an optional display name and verified email;
provider subjects, proofs, tokens and credentials are not returned.

The read rechecks current controller, enrollment and revocation evidence before
returning metadata. Revoked links remain tombstones and are not replaced. Apart
from normal request nonce admission, this operation changes no accounts, reviews,
enrollments, grants, history or ownership. It does not advertise or introduce a
requirement to use Google for legacy coordinator requests.

#### Version 2 status

The account-link feature is unreleased, so version 2 replaces version 1 with no
compatibility negotiation. The server implements this contract; the matched
client/runtime and viewer changes must land before release or activation.
Ordinary signed-device sync routes do not change.

Requests carry exactly three query parameters: `group_id`, `coordinator_origin`,
and `identity_id`. `identity_id` is the running profile's current Identity. It
is not secret, but it hints at a person, so the server treats it as a question,
never as a selector or an authority. It may appear in platform request logs, as
`group_id` already does.

```json
{ "version": 2, "coordinatorId": "...", "groupId": "...", "deviceId": "...",
  "fingerprint": "...", "identityId": "...", "state": "unlinked",
  "authority": "device_claim", "account": null }
```

`authority` names the link's source, or the source a new link would use. The
server evaluates these rules in order:

| Condition | `state` | `identityId` | `authority` |
| --- | --- | --- | --- |
| The device's committed device claim and its unique active attestation name different Identities | `conflict` | `null` | `null` |
| The device ID or key has a committed device claim, and the exact current enrollment still agrees with it | `linked` or `revoked` | Claim Identity | `device_claim` |
| The device ID or key has a committed device claim that no longer agrees (new key, assigned to another Identity, or archived or disabled) | `conflict` | `null` | `null` |
| One active attestation matches the exact enrolled key | `unlinked`, `linked`, or `revoked` | Attested Identity | `controller_attestation` |
| The [eligibility guard](#eligibility) passes for `identity_id` | `unlinked` | `identity_id` | `device_claim` |
| Anything else | `review_required` | `null` | `null` |

An unlinked attestation for a different requested Identity reports
`review_required`, with null Identity and authority. An existing linked or revoked
attestation still reports its bound Identity, with account metadata masked when
the requested Identity differs.

For `device_claim`, `unlinked` means only that this device may start an attempt
for that Identity. Nothing is verified, reserved, or linked until the same
operation's device finalization commits after Google verification. Clients must
not describe it as a Google-verified or linked state.

Account metadata appears only for this device's own link, and only when the link
Identity equals `identity_id`; otherwise `account` is `null`. A requested Identity
that belongs to someone else gets a generic `review_required`, never that
Identity's email, Google metadata, link state, or authority. The read is
read-only: it creates no attempt, claim, attestation, grant, or link, and it
never reports a device claim as an operator review.

First-link availability reveals one bit: a signed enrolled device can distinguish
an eligible requested Identity from one it cannot claim, including because of
an existing coordinator footprint. This disclosure is accepted for first-link
readiness; it does not reveal which record caused a denial.

Every request counts against the existing authenticated-device quota, whose key
must not depend on the requested Identity. There is no bulk lookup or detailed
denial endpoint.

The Node client `readCoordinatorAccountLinkStatus` uses an existing-file read-only
device snapshot and the existing matching signing key. It performs no database
maintenance, schema initialization or key generation. Read-only means no SQL,
schema, key or history changes; SQLite may create or update its normal WAL/SHM
coordination files, so the profile directory may need to be writable. Reads use
committed WAL data rather than an immutable or main-file-only snapshot that could
miss a key change. Requests use manual
redirect handling and a ten-second header/body deadline; response bodies are
limited to 16 KiB. The matched client must validate the exact version-2 shape and
requested group/device/fingerprint tuple, copying only allowed display fields.
The old decoder must be replaced before release, without a dual-version fallback.

The store API is `readAccountLinkStatus(signer, config, { identityId })` on both
SQLite and D1. Its final SQL statement reads source authority, current enrollment,
tombstones and display metadata together. Committed device claims use historical
proof, while the current signed enrollment must still match. Create passes the
trusted optional `expectedIdentityId` pin for either authority kind; the atomic
store checks repeat the source and Identity constraints, not just HTTP readiness.

Failures return fixed unsupported/unavailable results, never an inferred unlinked
or Google-required state. Embedded callers must still match the reported Identity
to their current local Identity, pin the coordinator when starting a link, and
recheck their current context before displaying account metadata or acting on it.

### Signed-device route errors

| Route | Condition | Response |
| --- | --- | --- |
| Create or finalize | The authenticated, enabled enrolled signer has a verified signature and nonce, but its stored controller review is absent, inactive, or no longer matches, including concurrent enrollment or group changes. For a device-claim request or attempt, the eligibility guard fails instead. | `403 auth_link_review_required` |
| Create | The attempt ID conflicts with a different immutable create request | `409 auth_link_conflict` (attempt conflict only) |
| Create | The requested `identity_id` or `authority` no longer matches the server's evaluation | `403 auth_link_review_required`; no attempt is created |
| Finalize | A matched finalization conflicts with an existing account-link binding, including a revoked tombstone | `409 auth_link_conflict` |
| Any signed route | Bad signatures or proofs, disabled enrollment, archived group, expiry, unavailable attempt, or another failed guard | Existing generic response; do not reveal controller or account-link state |

The `403` applies only after the signed request reaches the controller check.
Only the finalization `409 auth_link_conflict` indicates an account-link conflict;
the same label on create is an attempt conflict. Clients must match the request
stage, status, and exact error label, not infer a binding from any `409` response.
Neither rejection identifies an account or Identity, grants access, or replaces a link.
A failed device-claim guard never says which check failed.

All mounted device-link responses, including errors, use `Cache-Control: no-store`.
Custom signature headers do not provide the caching protections of a standard
`Authorization` header; every status poll must reach the signer check and current
attempt state instead of a cached response.

The device pins the coordinator and Identity from creation, then signs polling,
finalization, and cancellation with its existing key. Expiry-response validation
allows the existing five-minute signature clock tolerance; the device still
waits at most ten local minutes, and the coordinator enforces its own attempt
deadline. Neither a status response nor a loopback proof alone reports success:
the device requires its own proof-bearing finalization response. A lost final
reply may be retried once with a fresh signed nonce.

Embedded callers can supply `expectedIdentityId`, `expectedCoordinatorId`, and
`assertCurrentContext` to `linkCoordinatorAccount`. Expected IDs and callback types
are validated before local access. A context callback must return `true`; a false
result, thrown error, or rejected promise produces `context_changed`. The callback
runs before local access, attempt creation, private browser-link delivery, and each
finalization POST, including retries. Waiting for the callback honors caller
cancellation and the link's ten-minute deadline, including the first check before
local access. A late callback cannot release a browser link after cancellation.
Creation replies with a different expected
Identity or coordinator produce `identity_mismatch` before the browser link is
released. These checks do not replace the existing loopback and final-response
proofs; omitted options keep proof and result verification unchanged. Cancellation
is checked before creation and browser-link delivery even without a context hook.

If cancellation cannot be confirmed after a mismatch or context change, the result
is `cancellation_unconfirmed`. Callers must not report that nothing changed when a
finalization response or cleanup outcome is uncertain; read authoritative account
status before offering another linking attempt.

### Optional app lifetime and maintenance

`captureCoordinatorBrowserAuthOptions` captures server-owned configuration, an
already-imported independent CSRF key, and optional SDK transport settings.
It returns an opaque handle: secrets live only in a private lookup, so logging
or serializing the handle exposes no credentials. Copied or forged enabled
handles cannot build handlers or run maintenance.
`createCoordinatorBrowserAuth` builds all existing handler sets before mounting
anything. A disabled setup leaves auth routes at `404`; an invalid or failed
explicit setup returns fixed, uncached `503` responses on auth paths while
leaving legacy routes available.

An explicitly configured Worker keeps one browser-form limiter and one device
request limiter. It pins the first D1 binding and rejects a different reference
instead of mixing stores or resetting quotas. Each cold request owns its setup
I/O; only completed results cross requests, and warm requests reuse them.
Concurrent cold requests may repeat discovery, but share the captured key,
configuration, and quota state. Local tests exercise separate native HTTP
request contexts; they do not guarantee production binding-update behavior.

When optional auth is enabled, the shared device limiter also enforces the
existing limits on legacy routes across requests: 120 reads and 30 mutations
per device per minute, per isolate. Default and disabled Workers keep their
existing behavior. The first completed setup result is cached even if setup
fails; a transient cold-start discovery failure requires a new Worker instance
before auth becomes available, while legacy routes remain usable.

`maintainCoordinatorBrowserAuth` runs existing attempt maintenance, browser
retirement, sign-in transaction purge, guarded session purge, and guarded
receipt purge in that order. Each stage gets one to eight batches (default four)
with its existing row limit; failures stop the run without exposing raw causes.
Historical controller, account-link, link-attempt, and audit records are not
deleted. The optional Worker schedules this work with `ctx.waitUntil`; no cron
trigger or live cleanup is enabled by this change.
Before enabling a live cron, add sanitized maintenance-result reporting and
check the batch budget against the deployment's D1 query allowance.

Changing configuration or the CSRF key requires a new reviewed Worker instance.
Before disabling auth, explicitly retire pending provider material; an in-flight
request may still require a follow-up retirement pass. Review platform logging
for private URL, Referer, and body exposure before enabling a live pilot.

The runtime signs a finalization `POST` for the same attempt. It presents the
original runtime verifier and the browser-completion secret; the coordinator
matches them to that attempt's expected commitment and secret hash, then rejects
reuse. The existing request signature covers method, path/query, timestamp,
nonce, and the exact body digest. The finalization body must include purpose
`coordinator-account-link-v1`, coordinator ID, attempt ID, group ID, actor ID,
device ID, fingerprint, and both proofs. Compare every field to server-owned
attempt state. The signed attempt ID binds the provider account: only the
coordinator holds the verified issuer/subject, frozen at `oidc_verified` and
confirmed by the browser. The runtime neither supplies nor learns those claims.
The canonical signature does not sign the origin; explicit purpose and
coordinator ID in the body prevent cross-coordinator replay.

Attested linking requires an active controller attestation for the initiating key, created
only by an admin-authenticated ownership review in this slice. The configured
review-route source and tests are ready, but publishing that route, applying its
schema to a live deployment, and enabling Google remain separate approvals. A
legacy caller-provided `recipient_actor_id`, enrollment
`identity_id`, invitation claim, or request label cannot authorize linking. The
planned device-claim path treats the local Identity only as a claim that its
guard checks, never as authority on its own.

Persist controller attestations with coordinator ID, existing actor ID, group ID,
device ID, exact stored public key/fingerprint, authority-source receipt ID,
revision, creation time, and revocation time. They add no parallel Identity registry.
The [controller storage contract](coordinator-auth-controller-storage.md) defines
this first persistence slice; browser and account/session routes remain separate.
Legacy enrollment rows begin with no attestation; do not backfill caller claims
as trusted evidence. An authenticated coordinator admin explicitly reviews the
existing actor/device binding and records a server-computed evidence digest.
Authority comes from the configured admin credential, not caller-supplied audit
actor labels. The admin request supplies the existing actor ID; only an explicit
confirmation carrying the preceding preview digest can create the record. A non-null
enrollment `identity_id` must equal that actor ID; reject a mismatch. If it is null,
the reviewed admin attestation is the actor source and records that fact, without
rewriting enrollment. Later null-to-different-actor changes invalidate the proof.
Admin credential checks use constant-time digest comparisons, never browser
session or actor-label claims as admin authority.

Additional controllers require a single-use signed approval from an active
attested controller, bound to the exact replacement/additional key and Identity;
this optional link slice does not enable that enrollment or recovery operation.
For linking, read the active attestation for the initiating enrolled key and keep
its receipt ID/revision in the attempt. A changed key, disabled enrollment,
archived group, revoked attestation, or mismatched Identity invalidates it.
An unattested legacy device either uses an eligible device claim or waits for
admin review. Neither its signature nor a Google account alone creates a
controller, and a device claim never creates one.

## Device-claim first link (planned)

**Status:** Internal Core readiness, attempt creation, browser transitions, and
atomic device-claim finalization are implemented. The finalization batch consumes
only a confirmed attempt and writes its immutable proof, account link, and
creation audit together. Exact finalization retries read the retained receipt;
they never insert the proof again. Completed status and browser resolution check
historical proof/link/audit pins instead of rerunning first-binding eligibility.
Device-authenticated status requires a current enrolled, unrevoked key: the
original key or an exact shared assignment as described below. Finalization
retries still require the original key's current enrollment and no device/key
revocation.

Core account-session issuance, redemption, sign-in, profile/account reads, and
operator link revocation accept device-claim links only with coherent retained
attempt, immutable proof, link, and creation-audit provenance. They do not require
the original device to remain active. Session/profile checks still require an
active link and current session/configuration pins. Revocation preserves the
proof and link tombstone and records the original authority kind in its audit.
Owner enrollment and privileged invite/grant proofs remain attestation-only,
even if the device-claimed Identity later receives grants.

External creation remains attestation-only; device-claim HTTP mode, external
routes, and Viewer support are not enabled by these internal Core operations.

A device claim lets an enrolled device link Google to the running profile's
current Identity without a separate admin review. A matching enrollment Identity
is reused; an unassigned legacy enrollment uses trust on first use.

The coordinator learns that the holder of the enrolled key and the
holder of a verified Google account agreed on the same Identity during one
attempt. It cannot see who unlocked the device.

An Identity with no coordinator footprint is first-come under this trust model.
An administrator can revoke a mistaken link, but revocation preserves its
tombstone; reclaiming or transferring that Identity requires a separately
approved recovery policy, not another first-link attempt.

The user's explicit **Link Google** action, with the current Identity pinned,
plus the normal Google consent and confirmation pages, is the claim
confirmation. There is no extra checkbox or admin step. The confirmation page
names the Identity and device as it does today, and says that this link comes
from the device key and Google sign-in, not an admin review.

A device claim yields Google sign-in for that Identity and nothing else. It
creates no controller attestation, Identity-group grant, enrollment assignment,
ownership binding, key, scope, or owner-enrollment right, and changes no
enrollment or history. The link cannot authorize another device or owner
enrollment, even if grants for the Identity appear later. Upgrading a device-claim
link with stronger proof is out of scope.

### Authority model

Each row states its authority source in an `authority_kind` column and refers
only to the record of that kind:

| Table | `controller_attestation` row | `device_claim` row |
| --- | --- | --- |
| `coordinator_auth_link_attempts` | Attestation ID, review receipt ID, and revision 1 | All three controller columns null. `identity_id` holds the pending claim. |
| `coordinator_auth_device_claims` (new) | Not used | One immutable row per committed claim |
| `coordinator_auth_account_links` | `controller_attestation_id` set, `device_claim_id` null | `device_claim_id` set, `controller_attestation_id` null |
| `coordinator_auth_link_audit_log` | Same as account links | Same as account links |

A `CHECK` constraint on each table enforces that pairing. Readers also check it
through `readAuthLinkAttemptAuthority` and `readAuthLinkRecordAuthority` in
`coordinator-auth-link-authority.ts`, and treat any mismatch as no authority. The
kind is server-owned: no transition changes it, and the request only states
which kind the client expects.

The readers validate row shape, not ownership or caller permission. Link creation
and in-flight transitions resolve their source and rerun its live eligibility
checks. A kind string alone never authorizes an operation.

After finalization, the source fields are immutable historical provenance.
Consumers of an existing link validate the active, unrevoked link and that
provenance, plus their own current session, grant, or key-possession requirements.
They do not require the link-creation controller, device, or signer to remain
active, enrolled, reachable, or unrevoked. Current device-authenticated requests
still authenticate their present signer; that is not a reauthorization of the
link's historical source.

New writes must name their authority kind explicitly. There is no default that
silently turns an omitted kind into administrator-reviewed authority.

`coordinator_auth_device_claims` is the committed proof. It stores the
coordinator ID, claim ID, Identity, group ID, device ID, exact public key and
fingerprint, canonical key ID, the link attempt ID, issuer, auth-config revision,
and creation time. It is unique per coordinator on Identity, device ID, key ID,
and attempt ID, so each device, key, and Identity can hold at most one committed
claim, ever. Triggers reject updates, deletes, and replacing inserts, following
the device-ownership bindings. Link revocation leaves the claim in place as a
tombstone.

Account links keep their existing uniques on link ID, issuer plus subject,
Identity, and attempt ID, including revoked rows, and add one on
`device_claim_id`. References are logical, as elsewhere in the coordinator
schema: there are no declared foreign keys, because local SQLite stores do not
enable them. The finalization batch writes the references together, and readers
join on them exactly. Comparisons on nullable reference columns use `IS`, not `=`.

The controller attestation table is unchanged, and no attestation row is ever
written for a device claim. Attested authority queries also require the attempt's
`authority_kind = 'controller_attestation'`.

### Schema migration

The reviewed leaf source is `packages/core/src/coordinator-auth-link-authority-upgrade.ts`.
The operator command calls its explicit transaction; store opening never runs it.
It is not installed in the Worker's migration directory. SQLite and native D1 fixture
tests exercise the same copy/check/swap SQL, including rollback at each swap.
It rejects unknown schema and dependencies rather than rebuilding them silently.
Fresh auth storage now uses explicit authority kinds. HTTP link creation still
accepts only controller attestations; internal Core link and account-session
operations also support device claims as described above. Fresh SQLite
auth storage installs the committed-proof table without enabling external
device-claim creation.
Owner enrollment requires an attestation-backed link without rechecking its old
controller or device. Existing auth storage is not rebuilt on open, and ordinary
device-signed sync remains unchanged. Optional auth on an old schema returns
`503 coordinator_auth_schema_upgrade_required`, with operator instructions, before
querying the new columns or starting provider discovery. The fixed
`X-Codemem-Auth-Error` header carries the same code to CLI and Viewer clients.
Disabled auth stays disabled.
No authority upgrade is automatically applied through the Worker migration directory.

#### Operator cutover

Do not deploy new auth writers against a legacy schema. Stop admitting new link
attempts, drain or expire existing attempts using the existing deployment, then
pause all optional-auth writers. Back up SQLite; for D1, take a Time Travel bookmark and export.
Keep ordinary device-signed sync separate from this auth pause.

If new auth writers were deployed prematurely, restore the previous deployment
before draining attempts; the new schema check also refuses legacy maintenance.

For an existing local coordinator database, explicitly run:

```text
codemem coordinator upgrade-auth-schema --db-path coordinator.sqlite --json
```

This opens only that existing file, validates the recognized legacy schema and
retained provenance, then commits the three-table copy/check/swap and proof schema
in one immediate transaction. A failed assertion aborts everything; do not repair
references, delete history, or invent controller IDs to force it through.

For D1, export the exact reviewed source without opening any database:

```text
codemem coordinator upgrade-auth-schema --export-sql > coordinator-auth-upgrade.sql
```

The file targets Wrangler's remote SQL-file import (`wrangler d1 execute --remote
--file`), which requires separate operator approval and confirmation of the
deployed import service's atomicity. No remote import is tested or run here.

The native D1 tests prove the programmatic path: execute the exported
`AUTH_LINK_AUTHORITY_CUTOVER_STATEMENTS` array in one `db.batch()` while auth
writers remain paused. The file contains complete proof triggers; never split
it on semicolons.
Do not replay the historical migration directory on a deployment without a ledger.
The export command performs no remote execution and grants no rollout approval.

Before resuming auth writers, verify row counts and every preserved column, proof
immutability, and an enabled auth request against the upgraded database. Deploy
the matching writers as part of that controlled cutover; restart SQLite auth
composition if it was stopped during setup. Device-claim creation remains disabled.

The three legacy link tables declare `controller_attestation_id` as `NOT NULL`, and
SQLite cannot relax that with `ALTER TABLE`. The schema change therefore rebuilds
those tables by creating a replacement, copying every row with
`authority_kind = 'controller_attestation'`, checking row counts, swapping names,
and recreating indexes. The proof definition matches the separate additive migration
`0032_device_claim_proofs.sql`; the explicit cutover also installs that leaf schema
in the same transaction or D1 batch. Existing rows keep every value.

The copy must contain executable assertions, not merely `SELECT` results. Create
a migration-owned check table with `passed INTEGER NOT NULL CHECK (passed = 1)`
and insert each count and full-row equality result as 1 or 0 before any table
swap. A mismatch inserts 0, fails the constraint, and aborts the transaction.

An unexpected pre-existing check-table name also aborts; it is never cleared or
reused. Remove only that migration-owned table after all assertions succeed.

This work ships migration code and local tests only. Nothing is applied to a
live D1 database or a user's database without a separate approval. Before any
live apply:

1. Pause affected auth writers, require live link attempts to finish or expire,
   and recognize the exact legacy schema that supported only attestation-backed
   links. Run read-only preflight queries for tables, dependencies, and row
   counts, and validate every reference with `isAuthControllerId`.

   Existing completed links retain their known legacy authority kind and
   immutable historical tuple; their original controller need not still exist.
   Retained source or audit records must agree with that tuple, including
   receipts, revisions, coordinator, Identity, and attempt references where
   present. Expired or failed attempts confer no authority and keep their
   historical references; revoked records are also preserved.

   An unknown schema, malformed references, inconsistent retained provenance, or
   any remaining live attempt aborts with an actionable operator report. Known
   historical provenance is not a default for new writes or a reconstructed
   operator attestation. Never drop, repair, or silently promote a bad row.
2. Take a D1 Time Travel bookmark and an export.
3. Pause affected auth writers and apply only the reviewed upgrade file through
   a verified atomic execution path. Do not assume a migration ledger or replay
   the existing migration directory.
4. Re-check row counts and compare every preserved column in every existing row,
   using exact projections or deterministic hashes rather than sampling.

An existing SQLite coordinator store also requires an explicit upgrade. Opening
a store or reading account status must never rebuild its tables automatically.
Fresh stores use the new schema directly; old stores fail with an actionable
upgrade-required result until an operator runs the reviewed migration.

Cloudflare documents transactional rollback for Worker `db.batch()` and failure
recovery for remote SQL-file import. Wrangler 4.127.1 uses the D1 import service
for remote `execute --file`; it does not apply that file one statement at a time
through its command-query path. The exact copy/check/swap file must still pass
non-live D1 runtime tests, including injected failures before and after each
table swap and deliberately failing the check-table assertion, before those
guarantees are used for a rollout. That assertion failure must roll back the
entire import, including all previously executed copy and DDL statements.

The D1 file has no explicit `BEGIN` or `COMMIT`; D1 owns that transaction. A local
SQLite upgrade uses an explicit immediate transaction. Neither path may rely on
`PRAGMA foreign_keys = OFF`: D1 enforces foreign keys, and deferring checks does
not suppress cascading deletes. Preflight and fixtures must cover referenced
tables, triggers, indexes, and views, as well as row contents.

The old auth writer omits `authority_kind`, while the new schema requires it.
The code/schema cutover therefore needs a coordinated writer pause, not an
implicit administrator default or a compatibility shim. Time Travel restore is
a separately controlled recovery operation that overwrites current data, not a
routine rollback step.

References: [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[remote SQL-file execution](https://developers.cloudflare.com/d1/get-started/),
[D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/), and
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

The coordinator and viewer ship together. Ordinary signed-device sync routes,
enrollments, keys, and memory history do not change.

### Eligibility

The internal `readAuthDeviceClaimReadiness` store method now evaluates the shared
guard in `coordinator-auth-device-claim-eligibility.ts` on SQLite and D1. It reads
only and returns no account metadata or committed proof. Existing external status
and creation contracts remain unchanged. Trusted Core creation now explicitly
names `authority.kind`; `device_claim` also pins the current local Identity and
requires a browser-start commitment. Its atomic INSERT uses this same guard and
the existing quotas; exact retry rechecks both the full tuple and live eligibility
without extending its deadline. The canonical key ID is derived from the pinned
public key, not stored as a new attempt column. Creation and eligibility reads
create no committed proof; only successful finalization commits one.
Current HTTP creation still selects only `controller_attestation`. Trusted Core
device-claim status, browser-start claim, browser exchange and resolution, OIDC
verification, confirmation, and pre-finalization destination reads now recheck
the shared eligibility guard inside the winning SQL statement. Each operation
captures fresh key aliases and pins the stored source, target, config, and
commitments; a stale capture fails closed rather than bypassing the guard.
Original device or browser cancellation proof can release an uncommitted
attempt even after enrollment changes. Time-based maintenance also expires these
attempts without requiring live enrollment and clears their account subject;
neither operation creates ownership proof or removes retained quota history.
Trusted Core finalization now atomically consumes the confirmed attempt and
commits its immutable device proof, account link, and audit. Exact retries read
the retained receipt without reinserting proof. Core sign-in, sessions, profiles,
and operator revocation validate the committed device provenance; device proof
still supplies no owner-enrollment or privileged grant/invite authority.
External device-claim creation remains disabled until the matched status,
server/client, and Viewer contracts and complete-flow tests are ready.

One guard decides whether a device claim may exist. The coordinator runs it as a
single SQL statement that binds its inputs once through a CTE, keeping at most
100 bound parameters. For device-claim attempts it runs at status reads,
creation, creation retries, the browser start-code claim, OIDC verification,
confirmation, the completion-destination read, and finalization. Attested
attempts keep their current checks. A failed guard fails closed and never says
which check failed.

"Target" means the signer's exact enrollment: group, device ID, public key,
fingerprint, and canonical key ID. "Claim" means the requested Identity. "Live"
means an attempt in `pending`, `browser_claimed`, `oidc_verified`, or `confirmed`
before its deadline, other than the attempt being checked.

| Subject | The guard denies when |
| --- | --- |
| Target enrollment | It is missing, disabled, in an archived group, or has a non-null `identity_id` that differs from the claim |
| Target revocation | A coordinator-wide revocation exists for the device ID or key ID |
| Other enrollments of the target device or key | Any has a non-null `identity_id` other than the claim |
| Attestations for the target device or key | Any is revoked or names another Identity. An active matching attestation uses the attested path instead. |
| Ownership bindings for the target device or key | The bound Identity is not the claim |
| Consumed invites bound to the target device, key, or fingerprint, unless revoked before consumption | `assigned_identity_id` or `target_identity_id` is set to another Identity |
| Legacy team completions | A device decision for the target is `excluded`, or includes it with another Identity |
| Owner-enrollment attempts for the target | One is live |
| Device claims for the target | A committed claim exists for the device ID or key ID |
| Link attempts from the target | A live device-claim attempt names another Identity |
| Account links for the claim | Any exists, active or revoked |
| Device claims for the claim | A committed claim exists |
| Enrollments naming the claim | One belongs to another device or key without the exact same-record peer assignment described below |
| Attestations naming the claim | One, active or revoked, belongs to another device or key (`identity_id` or `enrollment_identity_id`) |
| Ownership bindings naming the claim | One belongs to another device or key |
| Identity-group grants for the claim | Any exists, active or revoked |
| Invites naming the claim | An unrevoked invite assigns or targets it and is still pending, or is bound to another device or key |
| Invite Identity footprints | `recipient_actor_id` names the claim and is bound to another device or key, or `inviter_actor_id` names the claim and `inviter_device_id` is another device |
| Legacy team completions naming the claim | Another device/key names it without the exact current assignment described below; the current device with another key, or current key under another device, always denies |
| Owner-enrollment attempts for the claim | One is live |
| Link attempts for the claim | A live attempt of either kind comes from another device or key |

These are not contradictions, and must not block a claim:

- records about other people in the same group or Team;
- unrelated labels and display names that do not name the claim; a claimed
  Identity tied to another device is ambiguous without an exact current assignment;
- expired, cancelled, failed, or retired attempts of either flow, including
  attempts that reached OIDC verification;
- invites that expired or were revoked before being consumed;
- legacy completion memberships that neither name the claim nor assign it to
  another device or key;
- evidence that agrees with both the target and the claim.

An exact current assignment is an included, enabled decision for the current
device, authenticated enrollment fingerprint, and requested Identity in the latest
completion for the current group and coordinator. Core validates the entire manifest
with `normalizeCoordinatorLegacyTeamCompletionManifest` and checks its candidate,
version, and completion time against the stored row. Its raw JSON must also equal
`canonicalCoordinatorLegacyTeamCompletionManifestJson(normalized)` exactly, so
duplicate keys and other ambiguous encodings cannot authorize an exception.
Missing or malformed evidence
does not grant an exception. One capped record becomes `assignment_snapshot`, the
15th named input; the winning statement rechecks its exact bytes, metadata, latest
record, current enrollment, and device/key revocations in a materialized CTE.
A captured positive assignment must still exist even if its disappearance would
otherwise leave the Identity eligible under the no-footprint policy. That stale
operation fails; a new operation captures fresh evidence.

Only other included, enabled devices with different fingerprints in that same
validated record may share the Identity without blocking first link. An enrollment
naming the Identity still denies unless the peer is enabled in the
current group and its device ID, current fingerprint, and Identity match an
included, enabled decision in that same record. Its current key must parse as
Ed25519 and differ canonically from the requester key; key aliases cannot qualify.
The captured assignment carries those distinct key texts and the statement
matches them against the live enrollment. All other
eligibility checks remain in force. This evidence supplies device-claim eligibility,
never controller, owner-enrollment, invite, or grant authority.

After first link, another device with that exact current assignment may read the
same Identity's linked or revoked status. The reader still validates the historical
attempt, proof, link, and creation audit; its origin key need not equal the reader's
current key. Without the exact assignment, guessing an Identity exposes no new
link or account metadata. A current requester ownership binding or any enrollment
of its device or canonical key naming another Identity denies this shared read,
even if the old completion still names the requested Identity. The requester's
attestations in this coordinator also deny access when revoked or naming another
Identity, including in another group or through a text alias of the same key.
Consumed invitations assigning this requester to another Identity, and its
committed account-link history for another Identity, also deny the shared read.
Later token revocation or missing historical controllers do not erase those pins.
These checks do not require the historical claim's origin device or controller
to remain active.
This read exception never permits a second binding or
replacement of a committed or revoked link.

The local Identity comes from the current profile context, whether config or
environment selects it. The viewer and runtime pin that context and stop on any
change; the coordinator does not treat one local source as more trustworthy than
the other.

### Pending claim and committed proof

A pending claim is only a link attempt with `authority_kind = 'device_claim'`.
It pins the device key and claimed Identity before Google starts. It uses the
normal ten-minute deadline, quotas, start code, runtime verifier, and
cancellation, and it reserves nothing after it ends. Creation is a single
`INSERT … SELECT` that includes the guard, so competing live claims serialize
there. An exact retry with the same attempt ID, key, Identity, and commitments
returns the existing attempt.

Expiry, failure, and cancellation leave no claim record and no link. After any of
them, including cancellation after OIDC verification, the device may start a new
attempt once the guard passes again; the existing per-device quotas still apply.
`link_id` stays null until finalization.

Finalization commits in one SQLite immediate transaction or one D1 batch:

1. Consume the attempt, with its proofs and the guard.
2. Insert the device-claims row from the consumed attempt.
3. Insert the account link that references that claim.
4. Insert the redacted audit row.

A unique conflict on the claim (Identity, device, or key) or on the link
(Identity, or issuer plus subject) rolls back the whole batch and returns
`409 auth_link_conflict`. Only this committed claim and link use up the first
claim. If the outcome is unknown, read status before offering another attempt.

### Operator-only consumers

Device claims must never pass as operator approval:

- Owner-enrollment start, callback, and commit accept only account links with
  `authority_kind = 'controller_attestation'`. The owner attempt's existing
  check that all link pins are non-null rejects a device-claim link as a
  second barrier.
- Identity-group grants come only from active attestations or consumed
  `team_member` invites. A device-claim link is never accepted as the
  account-ownership proof for either path.
- The separate existing-Identity invitation-acceptance protocol must require an
  attestation-backed link before it can use that link as account-ownership
  proof. Until that protocol is implemented and reviewed, device-claim links
  are denied by default. Existing device-signed legacy invite flows are unchanged.
- Admin review, attestation revocation, and link revocation stay
  admin-authenticated. Link revocation works on both kinds and keeps tombstones.
- Status and audit output never present a device claim as a review.

### Request changes

`POST /v1/auth/link-attempts` adds two required fields: `identity_id` (the
current local Identity) and `authority` (the kind that the client's status read
reported). The server repeats its own evaluation. If the kind or Identity no
longer matches, it returns `403 auth_link_review_required` and creates nothing.
The response adds `authority`. Finalize and cancel bodies do not change.

`linkCoordinatorAccount` takes the current Identity and expected authority. The
viewer passes the values from the status it displayed when the user clicks
**Link Google**; a status read or poll never starts an attempt. The CLI resolves
the same readiness for its current profile and uses the same linking runtime,
without a new flag or an administrator-only default. Neither caller selects
authority independently of the coordinator's read-only readiness result.

## Atomic consume-and-bind transaction

One transaction must:

1. guard the live pending attempt and recheck expiry, state, the attempt's
   authority (active attestation or device-claim guard), live enrollment,
   issuer, config revision, and both secrets;
2. verify one-to-one account-to-Identity uniqueness across active **and revoked**
   rows, then bind the verified issuer/subject to the existing actor; and
3. consume the proofs and attempt, persist a redacted audit record, and create no
   actor, enrollment, or device grant.

Any conflict, backend error, or race rolls back. A consumed retry cannot return a
session secret. Transaction and callback replays fail closed.
SQLite uses an immediate transaction. D1 uses a guarded atomic batch: all writes
depend on the winning attempt transition. Its first conditional UPDATE contains
every live predicate: state/expiry, proof hashes, the source-specific authority
check, exact group/device/public key/fingerprint, enabled enrollment,
null-or-matching Identity, unarchived group, and config revision. An attested
attempt also matches the active attestation and revision; a device-claim attempt
instead reruns the device-claim eligibility guard.
There is no existing enrollment key-revision column to rely on; compare the live
key values. Link and audit writes depend only on that winning consume token, not
on later fallible guards. Use full UNIQUE indexes on `(coordinator_id, issuer,
subject)` and `(coordinator_id, actor_id)`, including revoked rows; uniqueness
conflicts abort the batch. Read back the receipt and link to confirm the effect.
A consumed receipt without a link is an invariant failure, never success. A
zero-row guard is not success; never use `INSERT OR IGNORE` to hide a link conflict.

## Browser management session

Later sign-ins to an existing active link use the normal browser OIDC ceremony
and resolve exact issuer/subject to that link. They require no runtime loopback
or fresh device approval, and cannot invoke the initial-link helper to enroll or
reassign devices. An unknown account remains unlinked; it gets no management
session or new actor. Initial linking follows the separate dual-proof flow above.

After OIDC/JWS verification and the original cookie, CSRF, and Origin checks,
future public handlers **must** issue a normal sign-in session through
`signInWithConsumedBrowserTransaction`, as defined by the
[session admission contract](coordinator-auth-session-admission.md). The older
`signInWithAuthAccount` helper remains trusted internal only and is not a public
handler substitute.

Successful device finalization does not return a browser cookie to the CLI and
does not treat a runtime credential as a browser session. The original browser
transaction cookie can redeem finalized status once; only that browser then gets
the account-management session. A new requester cannot follow the authorization
link to redeem it.

The session cookie is `__Host-codemem-session`: an opaque random 32-byte value,
`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and no `Domain`. The server stores
only its hash with coordinator, link, actor, auth-config revision, issued-at, expiry, and revocation
state. Its initial absolute lifetime is eight hours and has no silent indefinite
extension; it has no device fingerprint because browser-session life is separate
from device status.

`POST` logout requires CSRF protection, revokes the server session row, and
clears the cookie. It does not revoke links or devices. Sessions end when their
link is revoked or provider configuration is disabled or changed. Management
authorization still uses existing role checks; this flow grants no administrator
role. Sensitive **first-account linking** requires fresh OIDC plus the original
controller or admin proof, or an eligible device claim. That legacy/bootstrap rule does not authorize future
owner enrollment of a fresh key for an already active linked Identity; the
separate [Identity enrollment contract](coordinator-identity-enrollment.md) is
a proposed, review-gated protocol for that path and is not implemented or an
activation approval.
Every protected request rechecks live session expiry/revocation, active link,
config revision, and the action's authorization. Session credentials are bearer
secrets even though they are not Google tokens; never return them to the CLI,
put them in URLs, or include them in polling, logs, or audit records. Replacing
a session rotates its credential rather than adopting a caller-supplied value.

Old eligible normal-sign-in session rows and receipts may later be removed only
by the separate trusted explicit [guarded-session retention capability](coordinator-auth-session-retention.md). It creates no logout/revoke hook or public handler; browser transaction, cookie, OIDC/JWS, CSRF, and Origin requirements are unchanged.

Only configured-admin authentication can revoke an account link in this slice,
with a redacted audit receipt; user sessions cannot self-revoke the link yet.
Revocation denies every related session immediately on its next request and keeps
the account/Identity tombstone. Replacing that link requires a future reviewed
workflow, not a fresh login or enrollment upsert.

The browser session is never sync admission. No supported headless or remote-login
flow is claimed.

## Display and test requirements

A profile picture URL is an untrusted remote asset. Rendering and fetch policy
need UI review; the server must not fetch arbitrary URLs, and Google tokens must
not be cached to refresh an icon.

Required tests cover expiry boundaries; callback and finalization replay; mixed
proofs; redirect downgrade and mutation; browser transaction-cookie theft; a compromised
local host retaining callback material; no persistent Google tokens; logout not
revoking a device; proof authority and source on every path; and transaction
races or backend failures failing closed. Test plans must not describe a
headless or remote-login path as supported.
Both backends must test revoked-link uniqueness and re-enrollment with another
key between initiation and finalization (no link and no consumed attempt). Test
cross-coordinator signed-body replay, one-shot confirmation, competing browser
claims, and lost session-redemption responses without leaking bearer credentials.

Device-claim tests run on both backends and cover:

- schema: preserved rows after the rebuild, kind/reference `CHECK` rejections,
  claim immutability triggers, and rollback of the entire upgrade on a failing
  copy-equality assertion;
- the primary case: an unassigned legacy device with unrelated group members
  present links its own Identity;
- each guard row as a separate rejection, plus each listed non-contradiction
  still succeeding;
- the claim appearing in a consumed invite or completion tied to another
  device/key, including recipient and inviter Identity footprints;
- races: two devices claiming one Identity, one device claiming two Identities,
  and a Google account already linked or revoked;
- mid-flow changes before each transition: disabled, revoked, re-keyed,
  archived, assigned, or newly attested;
- OIDC verification, then cancellation or failure, then a successful retry;
- owner-enrollment start, callback, and commit, plus grant issuance, rejecting a
  device-claim link even when grants exist;
- existing-Identity invite acceptance rejecting a device-claim link as its
  account-ownership proof;
- status privacy: no metadata for another person's Identity, no writes, and
  different requested Identities sharing the same authenticated-device quota;
- attested behavior unchanged.
- historical link consumers continue to accept a valid active attested link
  after its original controller or device is revoked or removed, while current
  session, key-possession, grant, and link-revocation checks remain enforced;
- schema upgrades preserve valid completed legacy links with historical-only
  source pins, including after their original controller was removed, and reject
  contradictions in any source or creation audit that is still retained.
