# Coordinator browser account and logout
**Status:** Implemented as an unmounted factory. It does not register routes or
change the default Worker `404` behavior.
## Boundary
`createCoordinatorBrowserAccount` supplies only local current-account and logout
handlers:

```ts
const created = await createCoordinatorBrowserAccount({ config, csrfKey, store, limiter });
if (created.ok) {
  await created.handlers.account(request); // GET /auth/account
  await created.handlers.logout(request, clientKey); // POST /auth/logout
}
```
It creates no OIDC client, performs no network access, registers no route, and
does not create sessions, profiles, links, enrollments, devices, recovery,
sharing, sync, or Project access. Profile fields are presentation only: authority
comes from the live session's configured issuer and `identityId`, never a profile.
## Factory capture
The factory first captures trusted raw configuration with
`captureCoordinatorBrowserAuthConfig`. An own `config` value of `undefined` or
`enabled: false` configuration
returns `browser_auth_disabled` before it inspects the CSRF key, store, or limiter.
Invalid enabled configuration returns `browser_auth_config_invalid` with its fixed
field label. A disabled factory returns no handlers; it does not render a disabled
page.
For enabled configuration, the frozen context retains only secret-free store
configuration, the configured public origin, CSRF scope, sign-out scope, the
opaque imported key, captured store methods, and the injected limiter. Google
client settings are not retained. The input itself must have own data properties;
missing or malformed basic input returns `invalid_input`.
The supplied key is only checked as an object handle. Its opaque membership and
crypto material cannot be checked here: a forged `{}` can construct the factory,
but a later account-page token issue fails closed as `503 internal_error`. A
validly shaped request with that bad key fails the form guard as `403 csrf_invalid`.
The factory captures and binds these receiver methods before any handler call:
```ts
store.readAuthSessionAccount
store.readAuthSession
store.signOutAuthSession
```
The injected limiter is retained for the form guard. Replacing captured store
methods later cannot redirect a request. The shared limiter and imported key must
be the same ones used by the sign-in-start factory; the form guard pins its
coordinator limit at 20. The per-isolate limiter is not fleet-wide enforcement.
## Current account: `GET /auth/account`
The handler snapshots native method, URL, and the original `Cookie` header before
its first await. Only the exact configured URL is accepted: query, fragment,
origin, and path variations are different routes. A wrong method returns `405`
with `Allow: GET`; a different URL returns `404`.
Cookie absence, malformed cookies, and a dead current session all render the
signed-out notice with `200`; none writes or clears a cookie. For every present
valid session cookie, `readAuthSessionAccount(hash, storeConfig)` is a live read, so expiry,
link revocation, configuration revision, issuer, and enabled-state checks remain
in storage rather than in a stale page decision.
For a live result, the handler requires plain own-data session and account
records, the configured issuer, and a valid `identityId`. It then issues a fresh
session-purpose CSRF MAC and renders the current-account page. The page receives
only the display profile, issuer, identity ID, and CSRF token.
Markup never contains a session ID, link ID, provider subject, cookie, cookie
hash, or credential. Identity ID and bounded profile display data may appear.
Reader, key, DTO, crypto, or rendering failures return a redacted `503` with no
cookie change; they do not reveal a private cause.
The snapshot protects this handler from server-side request mutation, not from a
browser cookie race or a concurrent revocation after the read. Every protected
POST must make its own fresh live read.
## Logout: `POST /auth/logout`
Logout also snapshots native method, URL, and the original cookie header before
asynchronous work. It accepts only the exact configured URL. Wrong method is
`405` with `Allow: POST`; another URL is `404`. These route denials do not invoke
the guard, limiter, store, or cookie mutation.
In the same synchronous turn, it starts the shared `session_logout` form guard.
The guard requires the exact configured `Origin`, a valid session-cookie CSRF MAC,
and the fixed form shape before a live action. Origin denial is `403`; quota denial
is `429` with `Retry-After`; malformed known cookies and invalid CSRF are `403`.
Missing cookie maps to the actual public `200 signed_out` outcome, with no write
or clear. Transport and form failures use the guard's `415`, `413`, or `400`.
After a successful guard, the handler rereads the snapped cookie and requires the
same hash. A mismatch or unexpected cookie result is a redacted `503`, not a
best-effort logout. The guard's MAC and Origin checks are required even if a
credential is currently dead.
Before touching persistence, logout renders the `200 signed_out` response and
appends a session-clear header. If this pre-render fails, it returns `503` and
keeps the cookie for retry. It then reads the original hash live.
| Live read / mutation result | HTTP outcome | Cookie behavior |
| --- | --- | --- |
| `readAuthSession` is `null` | `200 already_signed_out` | Clear session; no write. |
| Live valid session; sign-out succeeds and confirmation read is `null` | `200 signed_out` | Clear session. |
| Session remains live after sign-out | `503 signout_unconfirmed` | Keep session cookie. |
| Read, DTO validation, mutation, confirmation, or render failure | `503 internal_error` | Keep session cookie. |
The sign-out call receives only the credential hash and configured coordinator
scope. Its returned value must be a plain own-data `{ kind: "signed_out" }` record.
The handler confirms current-config absence with another live read, not an
affected-row count. It never claims rollback after
an uncertain failure because the row may already be revoked and retry evidence is
needed.
Current-config absence is deliberately not durable revocation: it clears the
browser cookie but leaves an old row unchanged. If an operator later rolls back a
revision or clock condition, a retained row can become live again to a holder of
the raw credential. This follows the current null-read/no-write contract, not a claim that logout
revoked the row.
Repeated and concurrent logout calls are idempotent at the store boundary. A
response cannot conditionally clear only an older browser cookie, so normal
same-cookie response races remain. Expiry and link-revocation races can deny
access but cannot increase it.
## Responses and deployment limits
Normal pages add `Cache-Control: no-store` and use the reviewed auth renderer's
CSP and referrer policy. If notice rendering fails, the fallback is static,
non-private `503` text with `no-store`, `no-referrer`, and `nosniff` headers.
Outcome labels are diagnostic only and are never authorization evidence.
Each handler resolves a frozen `{ response, outcome }` record; the response is the
HTTP contract and the label is not a browser-visible authority signal.
The factory does not log cookies, hashes, credentials, session IDs, links,
subjects, provider values, CSRF material, or response objects. It creates no
cookie and has no fallback secret or key source.
Mounting still needs trusted platform client-key sourcing, a stable shared limiter,
fleet-wide rate enforcement, shared key provisioning and rotation, configuration
revision rollout, capacity cleanup, real browser validation, Google deployment,
Chrome cookie behavior, direct-sync compatibility, and the later `.8` continuation
gate. None is supplied by these unmounted handlers.
