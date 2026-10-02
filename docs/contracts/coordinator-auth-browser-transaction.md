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

The additive, initially empty `coordinator_auth_browser_transactions` table is
the only table in this slice.

| Field | Requirement |
| --- | --- |
| `coordinator_id`, `browser_transaction_hash` | Coordinator namespace and unique per-ceremony 32-byte CSPRNG receipt, encoded as 64 hex characters. |
| `purpose`, `attempt_id` | `signin` has no attempt; `link` requires an attempt. |
| `issuer`, `auth_config_revision`, `redirect_uri` | Exact trusted issuer/revision and canonical configured HTTPS callback URI. |
| `state_hash`, `binder_hash` | Separate SHA-256 digests of SDK state and original browser-cookie secret. |
| `nonce`, `pkce_verifier` | Raw pending-only OIDC material; clear both in the consuming update or expiration update. |
| `claim_token`, `consumed_at_ms`, `created_at_ms`, `expires_at_ms` | Server UUID claim token and safe epoch timestamps. |
| `state` | `pending`, `consumed`, or `expired`; consumed and expired are terminal. |

The table stores no raw state, profile, account subject, access token, refresh token, ID token, CSRF token, or cookie secret. It retains hashes, IDs, and terminal rows as burn proof; there is no deletion, compaction, or capacity recovery in this slice.

## Internal store interface

Only trusted internal route callers may use these methods. The store does not accept a direct JSON grant, verify an HTTP request, set a cookie, or implement CSRF, Origin, provider, or SDK validation.

| Method | Contract |
| --- | --- |
| `startAuthBrowserTransaction(input, cfg)` | Takes `signin` or `link` input, server-created `stateHash`, `binderHash`, nonce, and PKCE verifier. Returns only `{ kind: "started", expiresAtMs }`; it never returns secrets or hashes. The source creates the browser hash; callers cannot nominate it. |
| `consumeAuthBrowserTransaction({ stateHash, binderHash }, cfg)` | Internal callback-only consume. On success, returns `{ kind: "consumed", purpose, attemptId?, browserTransactionHash, nonce, pkceVerifier }` for the trusted SDK exchange. It first wins a fresh UUID claim token, then clears raw nonce/verifier in the same update. |
| `resolveAuthLinkBrowserTransaction({ attemptId, binderHash }, cfg)` | Returns only the matching browser transaction hash or `null`. It requires live configuration, TTL, the actual linked attempt, and matching browser binding; failed or expired attempts never resolve. It is not a read-only nonce endpoint. |
| `maintainAuthBrowserTransactions({ coordinatorId }, { limit })` | Explicit maintenance only. `limit` is 1 through 32 and defaults to 32; it expires eligible pending rows and clears nonce/verifier. |

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
consumed and expired rows. Expiration and maintenance cannot restore capacity.
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
required before public routes. A one-hour deletion design was rejected because
it has not shown preservation of replay, identity, hash, or quota-counter
evidence. This candidate makes no production-readiness, perpetual sign-in
quota, or public-route claim.

Before public routes, pre-callback browser or device cancellation and config
rotation must consume or explicitly expire the matching transaction. Until
those handlers exist, raw nonce/verifier can remain in a pending row after
authorization expires, until an explicit maintenance pass clears them; no timer
or automatic failure hook runs in this storage slice.
