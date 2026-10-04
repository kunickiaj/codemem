# Coordinator browser auth callback

**Status:** Reviewed implementation. The unmounted factory does not
register a route, enable a Worker endpoint, or prove a live provider or browser deployment.

## Boundary
`createCoordinatorBrowserAuthCallback` handles the configured OAuth callback
after the browser returns from the provider.

```ts
const created = await createCoordinatorBrowserAuthCallback({ config, store, completeLink });
const result = created.ok ? await created.handlers.callback(request) : created;
```

It accepts only a `GET` at the configured callback origin and path. The default
Worker remains `404`; it cannot enroll, link, grant access, admit sync, or recover.

## Factory capture
The factory captures raw trusted configuration with
`captureCoordinatorBrowserAuthConfig`, then creates one OIDC client from the
captured Google configuration. It retains frozen store configuration, public
origin, callback URI, OIDC client, and handlers.

It captures these store methods with their original receiver before any await:

- `consumeAuthBrowserTransaction`
- `readAuthSession`
- `signInWithConsumedBrowserTransaction`
- `recordAuthAccountProfile`

Replacing a method after construction cannot redirect a callback call. The
factory also requires `completeLink` to be an own data function; it has no
fallback continuation. OIDC discovery failures and invalid/disabled input
return fixed factory errors rather than handlers.

The same frozen raw configuration must feed browser start and callback. A
mounting layer must rebuild both factories when revision, client ID, client
secret, or redirect URI changes. No request selects an issuer, callback URI, or
authority.

## Request and transaction gates
The callback snapshots native `method`, `url`, and original `Cookie` header before
async work. This blocks server-side mutation, not concurrent browser-cookie races.

| Gate | Rule | Failure effect |
| --- | --- | --- |
| Method | Exact `GET` | `405`, `Allow: GET`; no cookie or store change. |
| URL | At most 8,192 characters; no `#`; exact configured origin and pathname | Invalid URL is `400`; different route is `404`; no mutation. |
| State | Exactly one decoded `URLSearchParams` value, 43–128 characters, matching `^[A-Za-z0-9._~-]+$` | `400`; no mutation. |
| Cookie | Every known auth cookie in the original header is well-formed; the transaction cookie is present | Invalid is `400`, absent is `403`; no mutation. |
| Consume | SHA-256 of decoded state plus transaction-cookie hash | Non-consumed result is `403`; no mutation. |

`URLSearchParams` decoding accepts percent-equivalent state spellings. State is
case-sensitive and unnormalized; the SDK validates other provider query fields
only after a matching atomic consume.

OAuth `GET` needs no CSRF form key, client-IP bucket, or `Origin` header. It
instead requires the original cookie, state, nonce, PKCE, and OIDC/JWS checks.
This does not relax the start form's Origin and CSRF requirements.

Consumption burns the matching pending row and clears nonce/PKCE before the SDK.
Wrong URI/state/cookie or rejected consume changes nothing, calls no provider,
sends no `Set-Cookie`, and never cancels by binder.

## OIDC verification and link dispatch
The callback calls the captured client with the full snapped callback URL and
the consumed state, nonce, and PKCE verifier. It uses the adapter default:
`fetchUserInfo` is off. The adapter validates the code flow and JWS; a verified
issuer must exactly equal the configured issuer.

For a consumed `link` transaction, the callback calls the frozen continuation
with this current API:

```ts
await completeLink({
  attemptId,
  browserTransactionHash,
  transactionCookie,     // opaque private BrowserCookieSecret
  transactionCookieHash,
  verification,          // frozen success or fixed failure result
});
```

The input is frozen. The callback returns the continuation `Response` unchanged
as `link_dispatched`, even after provider failure. The callback itself adds no
cookie, profile, session, or link-attempt change; the continuation owns its
response and must provide the appropriate no-store and referrer policy. A throw/non-`Response` returns `503`
`link_continuation_failed` without clearing the link cookie; `.8` owns lifecycle.

This actual API has separate cookie and hash fields; `verification` may contain
the adapter's fixed error label, never raw state, nonce, PKCE, code, token, or
provider-error text.

## Normal sign-in
Only a successfully consumed `signin` transaction may clear the transaction
cookie. Verification failure returns generic `403` and clears that cookie.

For a verified account, it reads the original session under frozen configuration.
A live session gets `303 /auth/account` and only the transaction clear: no new
session/profile/rotation and no automatic different-account switch.

Otherwise it creates a fresh eight-hour credential and builds `303` before
admission. It passes the consumed hash, verified account, and credential hash;
the session `Set-Cookie` leaves only after `issued`.

| Sign-in result | HTTP result | Cookies |
| --- | --- | --- |
| Issued; profile recorded | `303 /auth/account` | New session and transaction clear. |
| Issued; profile absent, rejected, or throws | `303 /auth/account` | New session and transaction clear. Outcome: `signed_in_profile_not_recorded`. |
| Verification or admission rejection | `403` generic notice | Transaction clear only. |
| Persistence/other throw after known sign-in consume | `503` generic notice | Transaction clear only. |

Profile recording follows only a fresh issued session and is best effort, never
a first link. The eight-hour session and ten-session budget remain unchanged.

## Public outcomes and response policy

Normal rendered notices use the fixed `auth_unavailable` title and text. They
do not disclose provider, token, configuration, cookie, or persistence causes.

| Outcome | Normal status |
| --- | ---: |
| `method_not_allowed` | 405 |
| `not_found` | 404 |
| `callback_invalid`, `state_invalid`, `cookie_invalid` | 400 |
| `cookie_missing`, `transaction_unavailable`, `verification_failed`, `signin_rejected` | 403 |
| `link_continuation_failed`, `internal_error` | 503 |
| `session_live`, `signed_in`, `signed_in_profile_not_recorded` | 303 |
| `link_dispatched` | Continuation-owned response |

If notice rendering fails, the fallback is static plain text with `no-store`
and a `503`; it retains any already-selected transaction clear policy but reports
`internal_error` rather than the selected failure label. Outcome labels are
diagnostic only, not authorization or lifecycle evidence: callers must use
durable state, and the required link continuation must own link cleanup. The
callback does not log or place raw cookies, hashes, state, nonce, PKCE, code,
tokens, callback URL, or private error causes in bodies, labels, or diagnostics.
The intentional session bearer `Set-Cookie` header is normal credential
delivery, not debug output.

## Lifecycle limits and remaining gates

- A commit-then-throw consume is unknown, so the cookie stays. A retry may find
  an already-consumed row or become the consume winner if the first write failed.
- A commit-then-throw admission can orphan a budget-counting session; its lost
  credential cannot recover.
- A different live account needs logout/switch. A clear cannot compare a newer
  transaction cookie from another in-flight response.
- Two distinct concurrent sign-ins that each snapshot no live session can both
  admit sessions. The browser may keep only one returned credential; the other
  session can remain unreachable while counting against the ten-session budget.
- `Max-Age=600` is only a browser hint, not age, freshness, permanence, or proof.
- Real Google/browser cookies, production routing, and deployment remain
  unverified. Stub continuations do not prove full enrollment.

Retention capacity and cleanup, fleet-wide rate/key provisioning, shared
configuration rollout, and a real link continuation remain separate gates.
Callback-only work does not make those capabilities live.
