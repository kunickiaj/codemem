# Coordinator auth session admission

**Status:** Reviewed storage capability; browser handlers remain disabled.

## Purpose and boundary

`signInWithConsumedBrowserTransaction` is the only future public-handler seam
for issuing a management session after a normal sign-in ceremony. It accepts
trusted internal results, not HTTP JSON:

```ts
await store.signInWithConsumedBrowserTransaction(
  { browserTransactionHash, account: { issuer, subject }, credentialHash },
  trustedBrowserConfig,
);
// => { kind: "issued", session: { sessionId, identityId, linkId, account, expiresAtMs } }
// or { kind: "rejected", error }
```

The caller must first complete actual OIDC/JWS validation and preserve the
original browser-cookie binding, CSRF, and Origin prerequisites. Input shape
validation and a consumed row do not verify account claims. Credentials and
transaction commitments arrive as hashes. The method neither accepts nor
returns a raw cookie credential, provider token, token blob, nonce, PKCE verifier,
or claim token.

`CoordinatorAuthSession` is internal server metadata. A future HTTP response
needs a safe projection and a live lookup for every protected request; the DTO
is not a bearer credential or authorization cache.

This seam creates no initial account link, enrollment, actor, Project access,
role, permission source, recovery path, or sync admission. It does not enable
provider registration, deployment, mandatory sync, relay, or browser routes.

## Admission requirements

The trusted browser configuration must be enabled and match the transaction's
exact coordinator, issuer, revision, and canonical HTTPS redirect URI. The
transaction must be a `signin` row with no attempt, be `consumed`, have a claim
token, and have cleared its nonce and PKCE verifier. Its creation and consumption
times must be at or before `now`; it must remain unexpired.

The verified account subject must match an existing active account link under
the configured issuer. The link's identity, issuer, and subject are carried
through the issued session. A transaction used by a link attempt, an old receipt,
or a reused browser transaction cannot mint another session.

Rejections are internal, generic labels such as `transaction_unavailable`,
`account_not_linked`, or `session_limited`. Future public handlers must
normalize them and must not reveal whether configuration, browser binding,
account linkage, or a quota caused the denial.

## Atomic issue and replay behavior

One atomic SQLite transaction or D1 batch inserts a sign-in receipt with
`INSERT ... SELECT`, then inserts the session using the same fresh server UUID.
The receipt conflict rule gives one contender ownership; it does not turn a
losing contender into a successful
read or reuse an older receipt. Admission authority stays in the guarded insert,
not in post-failure diagnostic reads, so there is no read-then-admit race.

The session receives the existing eight-hour absolute expiry. It has no timeout
refresh and no silent renewal. A post-commit read failure is uncertain rather
than success; callers must start a new ceremony instead of retrying a raw
credential.

## Ten-session policy

This admission seam rejects when 10 sessions already count for the linked
account at one coordinator under the current configuration revision. The count
requires the coherent live link identity, issuer, and subject, an unrevoked
link/session, and expiry after
`now`. Sessions created later than a rolled-back clock still reserve a slot;
the count deliberately includes these future-born rows.

Older-revision sessions do not count. Configuration rotation therefore permits
a fresh sign-in instead of causing an eight-hour lockout. A link created under
an older revision remains a valid immutable link for normal sign-in; its creation
revision need not equal the current configuration revision.

At the cap, the new session is not issued. The coordinator does not evict another
browser, log it out, or refresh any session. A lost cookie can therefore block a
new sign-in until its absolute expiry. No per-session remote sign-out exists;
another browser can only sign out its own session. A configured admin can revoke
the whole link to deny all sessions, but that does not restore sign-in access.
A committed session whose cookie response was lost or never delivered also
occupies a slot until expiry. Enrollment and background sync are unaffected.

Call this seam only within the trusted request that consumed the transaction
and verified the provider account. The transaction stores no verified subject,
so the account binding depends on that caller; it is not a public endpoint for
client-supplied transaction hashes or claims.

`redeemAuthLinkSession` remains its separate one-time initial-link flow. Its
first redeemed session counts when a later normal sign-in uses this seam, but
its own redemption behavior is unchanged. The legacy
`signInWithAuthAccount` helper remains a trusted internal compatibility method,
unchanged and uncapped; callers of it do not receive a global session budget.
There is no request-driven or configuration option for this limit.

## Storage and migration

Migration `0022` adds only:

```sql
CREATE INDEX IF NOT EXISTS idx_auth_sessions_link_config_expiry
  ON coordinator_auth_sessions(coordinator_id, link_id, auth_config_revision, expires_at_ms);
```

The index matches the fresh schema constant and Worker schema. No columns,
foreign keys, backfill, timers, startup sweep, or change to historical migration
`0018` is part of this work. Old trusted methods do not depend on the browser
transaction table; this new seam requires that table and its migrations.

## Remaining gates

There is no session, receipt, or transaction purge here. Sign-in retained-capacity
recovery and readiness gates remain pending, including the retained 4,096
sign-in-transaction limit. Upstream per-client rate limiting is a deployment
requirement, not an accepted risk.

Future handler work must still validate CSRF, cookies, OIDC/JWS, and browser
behavior, including IPv4 and IPv6 loopback handling. It must not treat this
storage capability as approval for recovery, provider setup, deployment, or a
non-browser credential flow.
