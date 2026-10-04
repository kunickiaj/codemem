# Coordinator browser form guard

**Status:** Reviewed helper capability. It is unmounted, not exported from a package entrypoint, and enables no browser route.

## Purpose and boundary

`packages/core/src/coordinator-browser-form-guard.ts` validates one caller-selected browser form request before a future handler performs a live store operation.

```ts
const result = await guardBrowserForm({
  request, scope, csrfKey, action: "transaction_attempt", limiter,
  clientKey: trustedPlatformClientKey(request),
});
if (!result.ok) return result;
// Resolve result.cookieHash and result.attemptId in the live store next.
```

It does not authenticate or authorize. A valid cookie and CSRF MAC can exist for a cookie with no database row, and therefore grants no account, session, link, cancellation, recovery, enrollment, or Project access.

## Source API

| Input | Rule |
| --- | --- |
| `request` | Native `Request`; native method, URL, headers, and body are read once in the initial snapshot. |
| `scope` | Trusted CSRF scope: configured canonical HTTPS public origin, coordinator ID, and 64-character lowercase revision. |
| `csrfKey` | Already imported opaque server CSRF key. |
| `action` | Fixed caller choice: `transaction_attempt`, `session_logout`, or `signin_start`; selects cookie kind and exact fields. |
| `limiter` | Injected `InMemoryRequestRateLimiter`. |
| `clientKey` | Trusted platform identity, never an untrusted request header. |
| `limit` | Optional safe integer from 1 through 1,000; default 20. Must remain fixed per coordinator and reused limiter. |

The promise returns a frozen success object, or frozen `{ ok: false, error }` with `retryAfterS` only for rate limiting:

```ts
{ ok: true, action: "session_logout", cookieHash }
{ ok: true, action: "transaction_attempt", cookieHash, attemptId }
{ ok: true, action: "signin_start", cookieHash }
{ ok: false, error: "rate_limited", retryAfterS: 1 }
```

Success never includes CSRF, body bytes, a cookie credential, server key, or message. `cookieHash` is an internal commitment: never return or log it. Rejection labels are internal; future HTTP code must normalize them and never echo input or actor values.

## Check order

Before its first `await`, the guard snapshots required own-data parameters and
scope, then native Request method, URL, headers, and body. Accessors, missing
required data, reflection faults, and malformed limiter results fail as
`invalid_input`. The limiter's `check` may be an inherited data method; it is
captured once and invoked with its original receiver. Invalid CSRF key handles
fail later as `csrf_invalid`.

1. Require `POST`. Earlier denials neither call the limiter nor consume the body.
2. Require request URL origin and exact `Origin` header to equal the configured public origin.
3. Validate `clientKey`: trimmed, 1–128 characters, without control, format, or surrogate code points. Validate limit, then check the limiter.
4. Require form media type and valid bounded `Content-Length` when supplied.
5. Parse and hash the selected canonical cookie, read the bounded body, parse fixed fields, check CSRF shape, and verify its native MAC.

Forged cross-site requests must not spend the victim's rate bucket, so the cheap
Origin comparisons run before the limiter and without reading the body.

Only `allowed === true` admits a limiter result. A thrown check or malformed
result is `invalid_input`. A denial is `rate_limited`, with its finite numeric
`retryAfterS` rounded up and clamped to 1–3,600 seconds. Allowed results must have
a nonnegative integer retry hint.

Buckets use this JSON key, so all three actions share a coordinator/client bucket while coordinators remain separate:

```ts
JSON.stringify(["browser-form", coordinatorId, clientKey])
```

The underlying limiter also includes the numeric limit in its internal key.
The guard therefore pins the first valid limit for each coordinator and injected
limiter instance. Later calls with a different limit return `invalid_input`
without calling the limiter or reading the body, even for another action or
client. Wrong-Origin requests and invalid client keys or limits cannot pin this
policy. Window rollover and failed limiter checks do not reset it; another
coordinator or limiter instance has an independent policy.

This small registry retains only coordinator IDs and numeric limits, not
configuration snapshots, keys, cookies or authority. It follows the injected
limiter's lifetime. Mounting must supply a stable coordinator-wide limit and
must not create a fresh limiter per request to evade the invariant.

## Request policy

The request URL's normalized origin must equal trusted configuration, and the `Origin` header must be an exact match. Missing, `null`, comma-joined/duplicate, case-variant, default-port variant, and slash-variant header values fail. There is no `Referer` or forwarded-header fallback; Origin identifies browser context, not a user.

`Content-Type` must be ASCII `application/x-www-form-urlencoded`, bare or with
one `charset=utf-8` parameter and optional HTTP whitespace around parts. Matching
is case-insensitive; other parameters fail. A supplied `Content-Length` must be
1–10 ASCII digits. Over 4,096 rejects before reads; a smaller declaration is not
proof of actual size.

The guard does not consume a body on earlier denial. Its original body snapshot goes to the helper that limits actual bytes to 4,096 and owns them before parsing. See [browser form-body parsing](coordinator-browser-form-body.md) for reader lifecycle and strict encoding.

The action is private caller policy, not a browser choice:

| Action | Cookie kind | Exact fields |
| --- | --- | --- |
| `transaction_attempt` | `transaction` | `csrf`, `attempt_id` |
| `session_logout` | `session` | `csrf` |
| `signin_start` | `start` | `csrf` |

Future link confirmation and cancellation both use the transaction action and must resolve the original cookie-bound attempt before mutation.

## Cookie, CSRF, and live state

The guard selects only the action's cookie kind, while the shared parser checks
ambiguity and malformed values across all known cookie names. It rejects
absence or malformed input, hashes a present canonical credential, and retains
its opaque secret only for CSRF verification. See
[browser credentials](coordinator-browser-credential.md) and
[browser CSRF tokens](coordinator-browser-csrf.md).

`csrf_invalid` covers malformed token shape or failed MAC. A missing/wrong key handle reaches this late validation path. Before mounting, deployment must import an independent valid 32-byte key; this helper does not provision, load, cache, rotate, or otherwise manage keys. All instances need compatible server key material.

After success, authenticated handlers still need a fresh database lookup using
the original cookie binding, account/transaction state checks, and an atomic
store mutation. `signin_start` has no live start row: its handler must refuse an
existing active ceremony and commit durable unique-binder admission before
appending a promoted transaction header. A valid start MAC does not issue a
transaction, enforce one-shot admission, promote a cookie, or grant account
access. `Verified` means transport bindings passed, not authenticated.

## Limiter and deployment limits

The caller owns limiter lifetime. Core's in-memory limiter is per isolate: buckets disappear on eviction and do not provide a fleet-wide ceiling. Creating an application per Worker fetch also creates a new limiter and defeats that lifetime. This helper does not repair old Worker limiter scope or change caches, environment/configuration, or runtime factories.

Fleet-wide limits need upstream shared enforcement and deployment decisions. Trusted client-key sourcing is likewise a mount-time decision: `CF-Connecting-IP` has same-zone Worker spoofing considerations, and this helper does not choose an IPv6 `/64` grouping policy. Transport slow-sender deadlines remain outside the guard and body reader.

## Integration status

Current coordinator routes do not mount this helper. Browser use still needs route wiring, trusted client identity, independent key provisioning, live-store authorization and mutation design, browser validation, and an operator-approved shared-key deployment plan. Existing OIDC/provider setup, including Google configuration, does not change that status.

The unmounted [sign-in-start factory](coordinator-browser-signin-start.md) uses
`signin_start` for GET-page/POST-admission orchestration. A guard success is still
only one step before durable admission, not authentication or cookie promotion.
