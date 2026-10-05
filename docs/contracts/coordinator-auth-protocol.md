# Coordinator account-link protocol candidate

**Status:** Reviewed contract for optional persistence implementation; runtime routes remain disabled

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
ownership; neither its result nor a caller label supplies the controller authority below.

The runtime generates:

- a 32-byte random runtime verifier and sends only SHA-256 of its raw bytes;
- a separate 32-byte random browser-start code and sends only SHA-256 of its raw bytes;
- a random public `attemptId`, which is not a credential.

The coordinator stores a pending attempt with the coordinator ID, actor ID,
enrolled device ID, pinned public key and fingerprint, runtime-verifier and browser-start commitments,
group ID, configured issuer, and auth-config revision. Those fields and the local callback
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
The planned CLI (not implemented or publicly routed yet) builds the private browser-start URL locally with the one-time start
code. The code is not a Google credential or permission grant; it prevents a
public attempt ID alone from claiming that device's flow. Do not share or log
the start URL.
`parseCoordinatorAuthLoopback` implements this exact syntax check, including an
explicit canonical decimal port from 1 through 65535. Preserve the returned
destination verbatim, including `:80`; URL normalization is not an authorization
step. The helper is not yet wired into runtime routes. The listener accepts one
GET for its outstanding attempt and returns a `no-store` response.

## Browser OIDC and confirmation

The planned browser entry presents the start code through a same-origin
CSRF-protected POST; no public start route exists yet.
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

The unmounted `createCoordinatorBrowserLinkHandlers` continuation receives only
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
failure. General maintenance and route activation remain separate work.

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

After device finalization, the local listener returns the browser to
`GET /auth/link/complete?attempt_id=...` at the coordinator. The unmounted
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
stored. These handlers remain unmounted; opt-in signed device routes, the local
listener, and actual browser navigation still need integration and validation.

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
authentication and link operations. Absent or disabled configuration leaves all
four routes at `404`; the default Worker does not wire this option yet.

| Route | Signed input and result |
| --- | --- |
| `POST /v1/auth/link-attempts` | Requires `group_id`, `attempt_id`, `runtime_verifier_hash`, `browser_start_hash`, and the literal `loopback_redirect`. Returns public status plus controller-derived `identity_id` and configured `coordinator_id`, never proofs or a private start URL. |
| `GET /v1/auth/link-attempts/:attemptId?group_id=...` | The attempt device's signed request reads public status; a different device and a missing attempt both receive an unavailable response. |
| `POST /v1/auth/link-attempts/:attemptId/finalize` | Exact purpose, coordinator/attempt/group/Identity/device/fingerprint fields and canonical raw `runtime_verifier`/`completion` proofs. The path and body attempt must match; the server hashes decoded 32-byte proofs. Client-nominated proof hashes are rejected. |
| `POST /v1/auth/link-attempts/:attemptId/cancel` | Signed `group_id` only; fails the requester's bound attempt and retires its temporary provider material before reporting success. |

Bodies are limited to 4 KiB and exact fields. Authentication uses the existing
stored enrollment key, signature, timestamp and nonce, with a separate
per-device quota using the existing limits; SQL
still supplies the reviewed controller authority. Browser sessions or Google
claims are not device authorization. Storage or cleanup faults report no success
and disclose no proof or private cause. The local command, listener, and real
browser checks remain separate work; this option changes no enrollment or access.

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

Linking requires an active controller attestation for the initiating key, created
only by an admin-authenticated ownership review in this slice. A legacy caller-provided `recipient_actor_id`, enrollment
`identity_id`, invitation claim, or request label cannot authorize linking.

Persist controller attestations with coordinator ID, existing actor ID, group ID,
device ID, exact stored public key/fingerprint, authority-source receipt ID,
revision, creation time, and revocation time. They add no parallel Identity registry.
The [controller storage contract](coordinator-auth-controller-storage.md) defines
this first persistence slice; routes and account/session writes remain separate.
Legacy enrollment rows begin with no attestation; do not backfill caller claims
as trusted evidence. An authenticated coordinator admin explicitly reviews the
existing actor/device binding and records an evidence reference/digest. Authority
comes from the configured admin credential, not caller-supplied audit actor labels.
The admin supplies the existing actor ID and reviewed evidence digest. A non-null
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
An unattested legacy device must wait for explicit admin review; never bootstrap
a controller from its own signature or a Google account alone.

## Atomic consume-and-bind transaction

One transaction must:

1. guard the live pending attempt and recheck expiry, state, controller proof,
   live enrollment, issuer, config revision, and both secrets;
2. verify one-to-one account-to-Identity uniqueness across active **and revoked**
   rows, then bind the verified issuer/subject to the existing actor; and
3. consume the proofs and attempt, persist a redacted audit record, and create no
   actor, enrollment, or device grant.

Any conflict, backend error, or race rolls back. A consumed retry cannot return a
session secret. Transaction and callback replays fail closed.
SQLite uses an immediate transaction. D1 uses a guarded atomic batch: all writes
depend on the winning attempt transition. Its first conditional UPDATE contains
every live predicate: state/expiry, proof hashes, active attestation/revision,
exact group/device/public key/fingerprint matching both attempt and attestation,
enabled enrollment, null-or-matching Identity, unarchived group, and config revision.
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
role. Sensitive linking and new-device approval require fresh OIDC plus the
original controller or admin proof.
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
