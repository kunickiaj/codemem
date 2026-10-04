# Coordinator browser sign-in start

**Status:** Reviewed implementation. The factory exposes unmounted handlers only;
it does not register routes or enable browser sign-in.

## Boundary

`createCoordinatorBrowserSigninStart` captures trusted raw configuration, imports
no key, and creates one maintained OIDC client. The caller supplies an already
imported `BrowserCsrfKey`, a reused limiter, and a store.

```ts
handlers.signInPage(request); // GET /auth/sign-in
handlers.signInStart(request, clientKey); // POST /auth/sign-in
```

It exposes no callback, account, logout, cancellation, cleanup, or route
registration handler. It does not issue an account session, enroll a device,
grant access, or change device sharing.

## Factory inputs and capture

The factory accepts `config`, `csrfKey`, `store`, `limiter`, and optional trusted OIDC `fetch`/timeout wiring. It captures own-data inputs and freezes its context. Later mutations to caller input do not change its configuration or client.

The config follows [browser-auth configuration capture](coordinator-browser-auth-config.md). Disabled config returns `browser_auth_disabled`; invalid config returns `browser_auth_config_invalid` with only its fixed field label.

The factory builds its OIDC client from captured trusted config. Discovery or provider-configuration failure returns the adapter's fixed factory error. Tests use a fake Google issuer transport; no live Google setup is part of this slice.

The supplied CSRF key is opaque. The factory cannot prevalidate its membership
or material. With an invalid handle, a GET requiring a form MAC fails closed with
`503 internal_error`; an otherwise-valid new-start POST returns
`403 csrf_invalid`. Neither issues cookies or writes storage. Mounting must import
the correct independent key before calling the factory.

Only `startAuthBrowserTransaction` and `readAuthSession` are retained from the store. The source captures each method and its original receiver; later store method replacement cannot redirect these calls.

The limiter is reused rather than created per request. Its lifetime, trusted client-key source, fleet-wide limit, key provisioning, and retention capacity remain caller and deployment duties.

## GET sign-in page

`signInPage` accepts only the exact `GET /auth/sign-in` URL derived from the configured public origin. A query string is not the route. Wrong method returns `405` with `Allow: GET`; a different URL returns `404`.

The handler first refuses a malformed transaction cookie with `400`, or a valid transaction cookie with `409 signin_in_progress`. It neither rotates cookies nor writes storage on either refusal, including reloads and missing start cookies.

Next it reads a present session cookie through `readAuthSession`. A live session gets a fixed `303` redirect to `/auth/account`, with no session rotation.

Otherwise, an existing valid start cookie is reused without resetting its `Max-Age`; a new start cookie is issued only when absent. The page receives a fresh start-purpose CSRF token and renders only the fixed sign-in form.

The browser cookie lifetime is 600 seconds. `Max-Age` starts when a browser receives a header; it is not server age, permanent one-shot evidence, or proof that the response arrived.

## POST sign-in start

`signInStart` accepts only the exact `POST /auth/sign-in` URL. Before any async work, it snapshots native method, URL, and original `Cookie` header. Later request mutation cannot change cookie, session, or promotion decisions.

It starts the shared form guard in the same synchronous turn. The guard checks the exact configured Origin before spending quota, then applies the reused limiter and requires the start-purpose CSRF form format. It accepts no account grant or caller-chosen action.

Origin rejection (`403`), rate limiting (`429`), and invalid client/fault (`503`) take priority over an existing transaction cookie. After those outcomes, an existing valid transaction cookie returns `409 signin_in_progress` without a mutation, even if the start cookie is missing or the page was reloaded.

Only a valid `signin_start` guard result proceeds to the live-session check. A
live session redirects to the fixed account URL without promotion. For a new
admission, the handler rereads the original cookie snapshot and requires the same
start-cookie hash before obtaining SDK material.

Only then does the OIDC client create fresh SDK state, nonce, and S256 PKCE
material. The state hash is SHA-256 of UTF-8 raw state. Raw state is not stored;
the durable transaction holds its hash plus pending nonce and verifier. The nonce
also appears in the deliberate provider link; the verifier stays in private
server/store handling.

The handler validates and renders the continuation page and builds its success response before insertion. It appends, never sets, both `Set-Cookie` headers: the same-value promoted transaction cookie and cleared start cookie. Those headers leave only after `startAuthBrowserTransaction` reports `started`.

The store's unique binder prevents duplicate admission only while its transaction row remains retained. If the winning response is lost, the browser cannot redisplay authorization material because only the state hash was stored; a retry may report conflict or in-progress until the cookie expires.

## Public outcomes

When page rendering works, handlers return these fixed outcomes and statuses. Notices do not expose parser, provider, persistence, or crypto causes.

| Outcome | HTTP status | Condition |
| --- | ---: | --- |
| `signin_page` | 200 | Exact GET rendered the form. |
| `signin_started` | 200 | Durable start committed; continuation page and promotion headers returned. |
| `session_live` | 303 | Live session redirects to fixed account URL. |
| `signin_in_progress` / `start_conflict` | 409 | Existing transaction / durable binder conflict. |
| `method_not_allowed` / `not_found` | 405 / 404 | Exact handler route check failed. |
| `cookie_invalid` | 400 or 403 | Transaction-cookie refusal / form-guard cookie denial. |
| `form_invalid` | 400 | Invalid form. |
| `origin_rejected` / `cookie_missing` / `csrf_invalid` | 403 | Origin or start credential/CSRF gate failed. |
| `unsupported_media_type` / `body_too_large` | 415 / 413 | Form transport failed. |
| `rate_limited` | 429 | Guard denied quota; includes `Retry-After`. |
| `start_limited` / `provider_request_failed` / `internal_error` | 503 | Capacity, OIDC request, or redacted failure. |

Known transaction conflicts, limits, and persistence failures produce a fixed notice with no cookie change, cancellation, cleanup, or rotation. By default a conflict keeps the start cookie so an in-flight ceremony is not reset.

If styled notice rendering or crypto fails, the fallback must itself not throw: it returns a fixed non-private plain-text `503` with `Cache-Control: no-store`.

The continuation response is an explicit provider link, not an automatic redirect.
It is not evidence that a browser stored either cookie or visited the provider.

No post-start result may cancel or clean up a pending transaction. A later
completion or maintenance capability owns that work and must use durable state.

The start cookie is promoted with the same value, not a fresh credential. The
original browser binding therefore remains the store's binder hash.

The OIDC client is held by the frozen factory context. It is not rebuilt for a
request, and request headers cannot select issuer, redirect URI, or credentials.

## Secret and integration limits

Only intentional public OAuth state, nonce, and challenge appear in the escaped
continuation `href`. Fixed outcome labels contain no private values. Never log
raw cookies, cookie hashes, CSRF material, PKCE, client secrets, private errors,
or the response object.

This factory remains unmounted. Current default Worker `404` behavior is unchanged. Browser validation, Google deployment, fleet enforcement, 4,096-row capacity recovery, cleanup, and the `.8` continuation gate remain open.

The immutable current factory does not solve rollout: `.9` must rebuild from committed configuration when revision, secret, or redirect URI changes. It also does not claim callback-only session issuance, enrollment, access, or changes to existing devices and sharing.
