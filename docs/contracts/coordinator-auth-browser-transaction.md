# Coordinator auth browser-transaction storage

**Status:** Reviewed storage capability; browser integration remains disabled. It does not enable browser routes, cookies, HTTP handlers, provider configuration, account sign-in, account linking, device approval, recovery, enrollment, or Project access.

## Purpose and terms

This optional store holds the short-lived, server-side half of a browser authorization ceremony. OAuth is the authorization-code exchange with a provider; OpenID Connect (OIDC) adds a verified account identity to that exchange. PKCE binds the authorization code to a verifier generated before the browser redirect. These terms do not grant authority: the existing runtime link-finalization verifier and browser-completion proof still decide link ownership.

The table supports either `signin` or `link`. A link transaction must bind one existing `attemptId`; sign-in has no attempt. A verified provider account alone cannot enroll, recover, grant Project access, or finalize a link. This table does not change the existing sign-in store's trusted-metadata interface.

## Trusted configuration and secrets

`CoordinatorAuthBrowserConfig` extends the trusted server link configuration with a canonical HTTPS `redirectUri`; it is not request JSON. Server-side configuration, not a `Host` header or browser input, chooses the callback URI. Disabled configuration denies start, consume, and resolve; maintenance may expire rows from an old revision regardless of current configuration.

The server generates a fresh receipt using 32 cryptographically random bytes, encoded as 64 hex characters. Future routes will put a separate secret in the browser cookie; this store accepts only its `binder_hash`. The per-ceremony receipt differs from the cookie binder and is copied into the existing attempt when a link starts.

`state_hash` is SHA-256 of raw SDK-generated state. `binder_hash` is SHA-256 of the fresh original browser-cookie secret. Raw state is never stored: after the digest match, the trusted callback supplies its full raw state only to the SDK as its expected state. The raw nonce and PKCE verifier remain pending-only material. The nonce may appear in the authorization URL; the verifier must never appear in a URL, public JSON, logs, or storage after consumption.

## Record

The additive `coordinator_auth_browser_transactions` table stores ceremonies.
Migration `0023` also adds the initially empty `coordinator_auth_signin_purge_floors`
table for [explicit sign-in cleanup](coordinator-auth-signin-purge.md).

| Field | Requirement |
| --- | --- |
| `coordinator_id`, `browser_transaction_hash` | Coordinator namespace and unique per-ceremony 32-byte CSPRNG receipt, encoded as 64 hex characters. |
| `purpose`, `attempt_id` | `signin` has no attempt; `link` requires an attempt. |
| `issuer`, `auth_config_revision`, `redirect_uri` | Exact trusted issuer/revision and canonical configured HTTPS callback URI. |
| `state_hash`, `binder_hash` | Separate SHA-256 digests of SDK state and original browser-cookie secret. |
| `nonce`, `pkce_verifier` | Raw pending-only OIDC material; clear both in the consuming update or expiration update. |
| `claim_token`, `consumed_at_ms`, `created_at_ms`, `expires_at_ms` | Server UUID claim token and safe epoch timestamps. |
| `state` | `pending`, `consumed`, or `expired`; consumed and expired are terminal. |

The table stores no raw state, profile, account subject, access token, refresh token, ID token, CSRF token, or cookie secret. It retains hashes, IDs, and terminal rows as burn proof. Explicit sign-in-only purge is the sole deletion exception for this table; it does not delete link rows or related proof records. Separate [guarded-session retention](coordinator-auth-session-retention.md) can delete only eligible session metadata and requires this transaction row to be absent.

## Internal store interface

Only trusted internal route callers may use these methods. The store does not accept a direct JSON grant, verify an HTTP request, set a cookie, or implement CSRF, Origin, provider, or SDK validation.

| Method | Contract |
| --- | --- |
| `startAuthBrowserTransaction(input, cfg)` | Takes `signin` or `link` input, server-created `stateHash`, `binderHash`, nonce, and PKCE verifier. Returns only `{ kind: "started", expiresAtMs }`; it never returns secrets or hashes. The source creates the browser hash; callers cannot nominate it. |
| `consumeAuthBrowserTransaction({ stateHash, binderHash }, cfg)` | Internal callback-only consume. On success, returns `{ kind: "consumed", purpose, attemptId?, browserTransactionHash, nonce, pkceVerifier }` for the trusted SDK exchange. It first wins a fresh UUID claim token, then clears raw nonce/verifier in the same update. |
| `resolveAuthLinkBrowserTransaction({ attemptId, binderHash }, cfg)` | Returns only the matching browser transaction hash or `null`. It requires live configuration, TTL, the actual linked attempt, and matching browser binding; failed or expired attempts never resolve. It is not a read-only nonce endpoint. |
| `maintainAuthBrowserTransactions({ coordinatorId }, { limit })` | Explicit maintenance only. `limit` is 1 through 32 and defaults to 32; it expires eligible pending rows and clears nonce/verifier. |
| `cancelAuthSigninBrowserTransaction({ binderHash }, { coordinatorId })` | Explicit original-browser cancellation for a sign-in only. It returns `cancelled` for a matching pending or correctly expired row; every other match is `unavailable`. |
| `retireAuthBrowserTransactions(cfg, { attemptId?, limit? })` | Trusted-config retirement for stale pending rows. `limit` is 1 through 32 and defaults to 32. It returns bounded work, not an authorization decision. |

`startAuthBrowserTransaction` records the configured issuer, revision, and canonical callback URI. For a link, one atomic batch inserts the new transaction, selects the pending unclaimed existing attempt, claims that attempt with the new browser hash, and asserts the claim exists. A missing claim or unique conflict rolls back the entire batch: no orphan row and no statement-result interpretation may change this rule. Browser start copies the attempt's remaining TTL and never extends it. Link starts skip the sign-in quota, so a public sign-in flood cannot starve an already pending device link.

Browser handlers must claim attempts only through `startAuthBrowserTransaction`.
The legacy `claimAuthLinkAttempt` does not check this table's burned receipts
and must not be reachable from browser handlers.

`consumeAuthBrowserTransaction` requires enabled matching configuration, exact
issuer/revision/callback URI, unexpired `pending` state, and both hashes. A
wrong cookie, revision, issuer, redirect, or TTL leaves the row unchanged and
returns a redacted denial. A consumed transaction cannot retry; a fresh flow is
required. Consumption precedes the SDK exchange; the caller may record a verified
account or issue a session only after both consumption and verification succeed.

`resolveAuthLinkBrowserTransaction` also verifies the attempt's live browser
binding and state. It must not report whether the attempted match failed due to
the cookie, configuration, expiry, or attempt state.

## Limits, time, and maintenance

Sign-in start permits at most 1,024 new rows per coordinator per hour, counting
all history with `created_at > now - window` (strictly greater than). A hard
4,096-row limit counts all retained sign-in rows for that coordinator, including
consumed and expired rows. Expiration and ordinary maintenance cannot restore
capacity; only the separate, explicit sign-in purge can do so.
The internal store distinguishes used state/binder conflicts from quota errors;
future handlers must normalize public denials. Repeated starts do not refresh TTL.

`maintainAuthBrowserTransactions` expires only pending rows whose TTL is at or
before `now`, clears their nonce/verifier, and retains all hashes and IDs. It
returns `more = count === limit`; this may be a false positive. There are no
timers, startup sweeps, polling, route hooks, or automatic cleanup. Terminal
rows never reopen under clock rollback. An unobserved, unswept expiry during a
wall-clock rollback remains a known limitation of the approved store; no
monotonic clock floor is implemented.

Existing link limits remain unchanged: two active attempts per device, three per
Identity, six starts per device per hour, 60 per 30 days, and 10,000 retained
non-finished attempts per coordinator. These defaults are not measured costs.

## Cancellation and configuration retirement

For `cancelAuthSigninBrowserTransaction`, a future trusted handler must pass
only the original browser-cookie digest; a request cannot nominate a binder hash.
The store matches the coordinator, `signin` purpose, no attempt, and that digest.
For a pending match it sets `state` to `expired` and clears nonce/PKCE. It leaves
all hashes, the original deadline, claim fields, and other timestamps unchanged.

An already expired matching row with cleared nonce/PKCE returns `cancelled`, so
retry is idempotent. A wrong cookie or coordinator, missing row, consumed row,
or link row returns `unavailable` without a state change. Explicit cookie-owner
intent may expire its own future-born row after wall-clock rollback; this is
deliberately different from time-based retirement.

`retireAuthBrowserTransactions` receives the current configuration from trusted
server state, never browser or request JSON. It considers only pending rows for
that coordinator. General retirement considers rows created at or before `now`.
It expires rows whose
deadline passed, configuration is disabled, or issuer, revision, or redirect URI
does not match. For a link row, it also expires when the linked attempt is no
longer the actual unexpired `browser_claimed` attempt with the matching browser
hash and configuration.

Run sweeps only with the committed current configuration. A stale Worker
instance can otherwise retire newer ceremonies during a rollout; handlers must
refresh the authoritative configuration before sweeping.

Retirement changes only `state` to `expired` and clears nonce/PKCE. It preserves
the original deadline, hashes, claims, and retained burn record. A terminal row
does not become live if matching configuration returns. General retirement
leaves future-born rows untouched. With an explicit `attemptId`, it can also
clear a future-born link transaction whose attempt has already lost authority;
a future-born live ceremony is still left alone.

`processedCount` and `more` report bounded writes only: `more` is true when the
processed count equals the limit and can be a false positive. They must not
authorize a request, restore capacity, or drive a cached active-row count.
The limit defaults to 32 and accepts integers from 1 through 32. An optional
`attemptId` restricts retirement to that link ceremony.
Unused options must be omitted; explicit `undefined` is rejected. The write cap
does not bound reads: finding eligible rows can scan the coordinator's pending
transactions and check their link attempts.
Retirement adds no deletion, compaction, capacity recovery, migration, timer,
startup sweep, polling, or route hook. Existing expiry-only maintenance remains
unchanged.

Internal callers must treat method inputs as data. Reflection of caller-owned
objects can invoke a JavaScript `Proxy` reflection trap; such errors fail closed.
The store does not read accessor properties or coerce values, but this does not
mean every possible in-process input is inert. Actual HTTP JSON cannot carry a
JavaScript `Proxy`.

## Schema and integration gates

Migration `0020` adds the table as a constant and the Worker fresh schema must
match both store constructors. It creates only the new schema: no auth-row
backfill, sweep, registry, or change to historical migrations 0017–0019.

Browser route integration is required before public routes can exist. It must
use a host-only `__Host-` cookie with `HttpOnly`, `Secure`, `SameSite=Lax`, and
a ten-minute lifetime; retain the approved CSRF value plus Origin gating; and
use the fixed configured HTTPS callback. Do not persist a CSRF field here or
downgrade this to Origin-only protection. The callback GET must use the fixed
HTTPS endpoint, while the existing literal loopback second hop remains tied to
the stored device attempt.

Cleanup/capacity recovery and normal per-link session-receipt growth are still
required before public routes. Retirement clears nonce/PKCE fields but keeps rows
and hashes, so it cannot recover the retained 4,096-row sign-in cap. The separate
explicit sign-in purge is not secure erasure from database pages, logs,
or backups.
A one-hour deletion design without a durable floor was rejected because it had
not shown preservation of replay, identity, hash, or quota-counter evidence.
The explicit two-hour purge uses a monotonic floor to preserve quota counting
across clock rollback while retaining related replay records. This storage slice makes no
production-readiness, perpetual sign-in quota, or public-route claim.

Before public routes, handlers must integrate pre-callback browser and device
cancellation plus configuration rotation. A future link-browser cancellation
must resolve the original binder, fail the link attempt, then retire that attempt.
A device cancellation must verify its exact signed proof, fail the device attempt,
then retire it. A cleanup failure cannot restore attempt authority; cleanup can
be retried for the same transaction, while restarting authentication needs a new
ceremony. No route, CSP, CSRF, loopback, provider-configuration, or
deployment behavior changes here.

The user-approved policy for the later admission slice rejects new sign-ins at
10 active browser sessions per link and coordinator, without silently evicting
existing sessions. It does not affect enrollment or background sync and is not
implemented by this storage slice.
