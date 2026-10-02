# Coordinator auth link-attempt storage candidate

**Status:** Implementation candidate under review; not live or runtime-enabled.

## Purpose and boundary

This optional store persists the reviewed dual-proof account-link ceremony in
[the coordinator auth protocol](coordinator-auth-protocol.md). It links a
verified account to an existing controller-derived Identity; it never creates
or changes actors, enrollments, access, or sync admission.

It stores no raw Google access, refresh, or ID tokens. Profile and display
metadata remain required work for browser-session and OIDC integration; this
candidate does not remove those accepted requirements. OIDC handlers,
signatures, CSRF, browser cookies, session minting, and ephemeral OIDC request
material are out of scope. A future implementation must use mature-library
standard state, nonce, and PKCE handling; this contract specifies no custom
scheme.

## Trusted inputs and public result

`CoordinatorAuthLinkConfig` is immutable trusted server configuration, never
client JSON: `{ coordinatorId, issuer, revision, enabled }`. `revision` is 64
lowercase hex. Disabled configuration rejects mutations and makes status
`null`; an issuer or revision change denies progress.

The signer tuple (`groupId`, `deviceId`, exact `publicKey`, `fingerprint`) is
an already-verified request result, not Identity authority. Creation and
finalization still require the live controller-attestation SQL join.

All public status is limited to:

```json
{ "attemptId": "attempt-1", "state": "pending", "expiresAtMs": 600000 }
```

No result exposes hashes, raw subject, loopback URL, link ID, browser
credentials, provider claims, or secrets. Create additionally returns the
`identityId` derived from the active controller record. OIDC recording returns
only its target IDs: `identityId`, `groupId`, and `deviceId`. Other successful
mutations return `applied` or `existing` plus public status.

## Store interface

Source candidate: `packages/core/src/coordinator-auth-link.ts`.

| Method | Required transition and result |
| --- | --- |
| `createAuthLinkAttempt({ attemptId, signer, runtimeVerifierHash, loopbackRedirect }, config)` | Copies the active controller actor, key, review receipt, revision, issuer, config revision, and literal validated loopback target. Returns `created` or matching `existing` with controller-derived `identityId`. |
| `claimAuthLinkAttempt({ attemptId, browserTransactionHash }, config)` | Claims once: `pending` → `browser_claimed`; the same cookie hash may receive `existing` only while claimed. |
| `recordAuthLinkOidcVerified({ attemptId, browserTransactionHash, account }, config)` | Trusted, already-verified caller supplies exact configured issuer and subject; only a matching claimed cookie can freeze it: `browser_claimed` → `oidc_verified`. It validates no JWT or caller provenance. |
| `confirmAuthLinkAttempt({ attemptId, browserTransactionHash, completionSecretHash }, config)` | The coordinator generator supplies the hash once; no raw completion secret is returned, stored, or replayed. `oidc_verified` → `confirmed`. |
| `finalizeAuthLinkAttempt(body, config)` | Receives the verified signed-request bindings and server-computed proof hashes: purpose, coordinator, attempt, group, controller-derived actor, device, fingerprint, and matching signer. `confirmed` → `finalized`, with one link and audit effect. |
| `failAuthLinkAttempt({ attemptId, requester, reason }, config)` | Device may cancel only; matching browser may cancel or report provider/config failure. It terminally fails an unfinished attempt. |
| `getAuthLinkAttemptStatus(attemptId, requester, config)` | Authenticated matching device or claimed browser reads public status only; expiry is derived for unfinished attempts. |

`session_redeemed` belongs to the separate
[browser-session store](coordinator-auth-session-storage.md), not these linking operations.
Wrong proofs, malformed tuples, and request labels neither consume attempts nor
reveal their cause; errors stay redacted. A matching account or Identity on any
other attempt, including a revoked link, is `link_conflict`. Normal sign-in uses
the separate session store; replacing an account link remains future reviewed work.

## Time, fields, and persistence

Constructors accept optional `authClock`, in safe non-negative epoch
milliseconds; an invalid clock fails closed. Each attempt has a 10-minute
absolute TTL. Immutable attempt data includes the signed-body identity and
controller review receipt/revision, issuer/config revision, redirect commitment,
and proof commitments. Branch state writes are write-once; this store never
changes actor, enrollment, or access records.

Three additive, initially empty tables are required: `coordinator_auth_link_attempts`,
`coordinator_auth_account_links`, and `coordinator_auth_link_audit_log`.
Add identical DDL to `AUTH_LINK_SCHEMA_SQL`, fresh worker `schema.sql`, and
worker migration `0017`; do not add foreign-key cascades or backfill trust.
Unique constraints cover issuer/subject and Identity across revoked rows, and
namespace runtime, browser, and completion proof hashes. A finalization has one
link and one audit receipt.

SQLite uses an immediate transaction. D1 uses a batch whose guarded first
`UPDATE` contains every live predicate: config, expiry/state, both proofs,
attempt/signer key, active unrevoked controller, enabled matching enrollment,
unarchived group, and null-or-matching enrollment actor. Link and audit writes
depend only on that winning fresh link ID/token, avoiding snapshot races.
Unique conflicts abort the whole transaction as `link_conflict`; other backend
errors propagate rather than becoming domain errors. A consistent link-and-audit
read-back is required; missing data throws `auth_link_persistence_incomplete`.
A D1 post-commit read failure leaves the effect uncertain: exact retry may read
public status only and must create no extra effect or expose a secret.

## Validation and deferrals

Local backend parity and Worker D1 suites cover expiry, replay, competing claims,
config/controller changes, revoked-link uniqueness, proof errors, and rollback.
A regression forces SQL `changes()` to zero: finalization relies on the fresh
winning link ID, not a connection-local row counter. No remote D1 run or
deployment was performed. These tests do not prove OIDC, signatures, or cookie/CSRF
verification; those remain handler integration work.

Attempt cleanup and retention limits remain deferred. Until that work lands,
expired and failed rows remain stored; do not describe their evidence as deleted
when the ten-minute authorization window closes.
