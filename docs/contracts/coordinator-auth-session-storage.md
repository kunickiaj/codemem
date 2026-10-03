# Coordinator auth session storage candidate

**Status:** Reviewed storage contract; browser routes remain disabled.

## Purpose and boundary

This optional store persists browser account-management sessions for the
[coordinator auth protocol](coordinator-auth-protocol.md). A browser session is
separate from persistent device enrollment and never admits sync, creates an
actor, changes an enrollment, or grants Project access.

Google scopes remain `openid email profile`. The store retains no Google access,
refresh, or ID tokens, and it requests no offline access. A typed name/avatar
projection remains required future OIDC work; it is not account authority and
does not permit arbitrary server-side remote fetches.

This contract does not implement cookies, OIDC handlers, CSRF, routes,
cryptographic signing, or prove those integrations. Local storage tests do not
replace validation of those future handlers.

## Trusted inputs and returned record

`CoordinatorAuthLinkConfig` is loaded trusted server configuration, never
client JSON:

```ts
{ coordinatorId, issuer, revision, enabled }
```

The browser credential is exactly 32 random bytes from a trusted generator.
Only its 64-character hash is accepted by this store; raw credentials are never
stored, accepted as input, or returned. The server creates a fresh UUID
`sessionId` for each session.

Successful reads return server metadata only:

```ts
{ sessionId, identityId, linkId, account: { issuer, subject }, expiresAtMs }
```

`account` is the exact configured issuer/subject reference. This DTO contains
no bearer credential, Google token, profile claim, or default actor selection.

## Store interface

Source candidate: `packages/core/src/coordinator-auth-session.ts`.

| Method | Required behavior |
| --- | --- |
| `redeemAuthLinkSession({ attemptId, browserTransactionHash, credentialHash }, cfg)` | The original browser alone redeems one finalized link attempt and receives a newly minted session record. |
| `signInWithAuthAccount({ browserTransactionHash, account: { issuer, subject }, credentialHash }, cfg)` | Unchanged trusted internal compatibility helper. It is not the future public-handler path and does not apply the admission limit. |
| `signInWithConsumedBrowserTransaction({ browserTransactionHash, account: { issuer, subject }, credentialHash }, browserCfg)` | Future public handlers **must** use this post-OIDC seam after independently verifying OIDC/JWS, original browser binding, CSRF, and Origin. It requires a consumed current-config sign-in transaction and applies the per-link admission limit; see the [admission contract](coordinator-auth-session-admission.md). |
| `readAuthSession(hash, cfg)` | Returns the DTO only while the session, link, and configuration remain live. |
| `signOutAuthSession(hash, { coordinatorId })` | Idempotently revokes only the targeted session. |
| `revokeAuthAccountLink({ linkId }, { coordinatorId })` | Future configured-admin-only operation; its caller must already be authenticated. |

Identity comes from the active exact issuer/subject link, never email or a
default actor. An unknown account gets no session. A changed configuration
revision denies existing sessions, but a fresh sign-in for the same
issuer/subject may use the new configuration.

The consumed-transaction seam accepts hashes and internal session metadata only;
it does not accept or return raw credentials or provider tokens. Its result is
not an HTTP response or a substitute for live session lookup.

## Lifetime and invalidation

Sessions have an eight-hour absolute lifetime with no silent renewal. Their
creation time must be safe non-negative epoch milliseconds no greater than
`Number.MAX_SAFE_INTEGER - 28_800_000`; SQL derives expiry as
`created_at_ms + 28800000`.

`readAuthSession` denies an expired or revoked session, disabled or changed
configuration, or revoked/inactive link. Revoking a link denies all of its
sessions on their next use. Logout is uniform even when auth is disabled or the
hash is unknown: report `signed_out`, without changing enrollments, keys, links,
or Projects.

Link revocation requires configured-admin authentication at the future call site
and writes one redacted audit receipt. It does not attribute a shared credential
to an individual person. It retains the full link tombstone and its
uniqueness reservation; a later sign-in cannot recreate the link.
If an original audit row is corrupt or missing, revocation still takes effect
and denies access. The store reports `auth_session_persistence_incomplete` when
it cannot write or verify the audit receipt; an error does not undo that revocation.

## Atomic redemption

Redemption applies only to the original browser, within two minutes after
finalization and before the original ten-minute attempt deadline. It atomically:

1. validates active exact link/config and the browser transaction hash;
2. inserts a receipt guarded by `INSERT ... SELECT` with a fresh session UUID;
3. inserts the session and changes the attempt to `session_redeemed`.

SQLite uses one immediate transaction. D1 uses one atomic batch. The narrow
`ON CONFLICT(coordinator_id, browser_transaction_hash) DO NOTHING` applies only to the receipt;
it prevents replay, while CHECK and other constraint errors abort rather than
being ignored. Do not use `changes()` as authority.

After any post-commit read or backend failure, throw an uncertain-result error;
never report success. A replay never returns an old credential. There is no raw
secret retry: a lost response starts fresh OIDC and does not require device
approval.
An issue result describes the committed session, not perpetual authorization:
revocation racing with its read-back can make that session unusable immediately.
Every later protected use must call the live session lookup.

## Schema and deferred work

Migration `0018` adds two initially empty tables:
`coordinator_auth_session_receipts` and `coordinator_auth_sessions`. It remains
unchanged: no change to 0017, backfill, or foreign keys. Migration `0022` adds
the session-admission index; the current `AUTH_SESSION_SCHEMA_SQL` and fresh
Worker `schema.sql` include that index too. See the
[admission contract](coordinator-auth-session-admission.md).

Cleanup and retention work gates public routes. Until it is complete,
this candidate does not expose browser-session routes or claim retention
behavior.

Required parity tests cover the exact lifetime boundary, config rotation,
link-revocation denial, original-browser/two-minute redemption guards, replay,
lost-response uncertainty, logout isolation, and tombstone uniqueness. They do
not validate OIDC, cookies, CSRF, routes, or signer/device-proof integration.
