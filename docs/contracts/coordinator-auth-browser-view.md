# Coordinator auth browser display

**Status:** Reviewed renderer with canonical CSRF token shape; browser routes remain disabled.

## Purpose and surface

This module makes a pure HTML page and headers from already trusted inputs. It does not authenticate a user, create a session, persist a profile or grant access.

| Function | Input and output |
| --- | --- |
| `projectAccountProfileView(profile, issuer)` | Returns bounded display fields and fallback initials. |
| `renderAuthLinkConfirmPage(input)` | Profile, issuer, Identity/device IDs with optional labels, optional group, attempt ID, and CSRF token; returns HTML and headers. |
| `renderCurrentAccountPage(input)` | Profile, issuer, Identity, and CSRF token; returns HTML and headers. |
| `renderAuthSigninPage(input)` | Canonical `csrfToken` only; returns a fixed sign-in POST form and headers. |
| `renderAuthSigninContinuePage(input)` | Trusted SDK-produced `authorizationUrl`; returns an explicit Google continuation link and headers. |
| `renderAuthBrowserNotice(kind)` | Fixed `expired`, `unavailable`, `signed_out`, `signin_in_progress`, `signin_unavailable`, or `auth_unavailable` notice; returns HTML and headers. `auth_unavailable` has the static title “Sign-in or linking unavailable” and no form. |

Page renderers return promises. An omitted profile uses the fallback display.

The view shows full target Identity, device, and optional group IDs, with short optional labels. It has no Identity registry, name lookup, group matching, or profile-based choice.

Verified issuer and subject from the OIDC SDK remain the account authority. Names, email, and pictures are display data only; this renderer does not verify JWS, cookies, Origin, CSRF, HTTP proofs, or grants.

## Input and output rules

Inputs are plain own-data records only: inherited values, getters, coercion, controls, bidi characters, and oversized display strings are ignored or rejected without invocation. Required IDs, issuer, attempt ID, and the canonical 86-character base64url CSRF token reject with a redacted error; rendering failure after crypto returns a generic failure.

The token decodes to 64 bytes, has no padding or period, and ends in `A`, `Q`, `g`, or `w`. `isBrowserCsrfToken` checks this shared shape only; this renderer does not verify a MAC or authenticate a token.

All text and attributes escape `&`, `<`, `>`, and quotes. Profile and form markup
never exposes unknown claims, JSON, token keys, account subject, nonce, PKCE
verifier, cookies, credentials, signing keys, or completion secrets. Link forms
contain only `csrf` and `attempt_id`; sign-in and logout forms contain only `csrf`.
The continuation anchor necessarily carries public OAuth request fields such as
state, nonce, and code challenge in its escaped URL, never as debug/body text.

The fixed form actions are `POST /auth/link/confirm`, `POST /auth/link/cancel`,
`POST /auth/logout`, and `POST /auth/sign-in`. Retry and signed-out notices link
with `GET` to `/auth/sign-in`. Callers cannot choose a form action or notice link;
only the continuation renderer accepts a separately constrained provider URL.

## Sign-in continuation boundary

The sign-in page checks only the shared 86-character CSRF shape. Its caller must
issue a start-purpose token and later verify it with the exact POST Origin and
cookie binding. Rendering does not create a transaction or grant account access.

The continuation URL must be an own-data string of at most 8,192 characters and
an exact canonical HTTPS URL on `https://accounts.google.com`, without userinfo,
ports, fragments, backslashes, controls, or surrounding whitespace. Decoded query
names are checked case-insensitively against `code`, `code_verifier`,
`client_secret`, `access_token`, `refresh_token`, and `id_token` and rejected if
present. This cannot detect secret values hidden in arbitrary other parameters.

The caller must supply only the trusted OIDC SDK's authorization request URL,
never a request-nominated destination. The renderer does not verify the endpoint
path or OAuth protocol, fetch discovery, or cache provider metadata. Google
[recommends discovery](https://developers.google.com/identity/protocols/oauth2/openid-connect)
rather than hardcoding its authorization endpoint path.

The continuation page has one explicit link with `referrerpolicy="no-referrer"`
and `rel="noreferrer"`; it has no form, script, automatic redirect, or meta
refresh. It renders no Identity, device, profile, or provider-error metadata.

## Profile projection

`projectAccountProfileView` accepts only bounded display name, email, `emailVerified === true`, and picture data. If an email is present and its flag is false or absent, it says “Email not verified by provider”; otherwise it shows no positive verification badge.

Initials use at most two `Intl.Segmenter` graphemes that begin with a letter or number, with bounded code points. Invalid or absent text leaves a plain fallback circle.

For the exact issuer `https://accounts.google.com`, a picture may use only an HTTPS, credential-free, fragment-free URL with no non-default port and the exact canonical host `lh3.googleusercontent.com`. Lookalike, subdomain, trailing-dot, and IP hosts are rejected; accepted normalized spellings are emitted only as canonical `URL.href`. Other issuers and hosts fall back to initials; there are no wildcards, browser-controlled hosts, server fetches, SVG/data URLs, events, or photo proxy.

The renderer drops surrounding whitespace in display fields instead of repairing
it, even though the adapter can retain such strings as verified metadata.

Google's [OIDC documentation](https://developers.google.com/identity/openid-connect/openid-connect) describes `picture` as an optional profile claim and promises no host. The LH3 rule is client policy, not a provider contract or proof that every Google avatar will render; new allowlist entries need evidence.

The image is decorative (`alt=""`) and uses `referrerpolicy="no-referrer"`; fallback initials remain in the markup behind it. Actual image-failure appearance still needs browser validation. Picture URLs are checked only before becoming `img src`, never used as navigation.

## Page policy

Each page contains a local hashed stylesheet and no JavaScript, remote fonts, or other static asset binding. Web Crypto SHA-256 creates the exact `style-src` hash; headers are UTF-8 HTML, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY`.

The confirmation, account, and sign-in form pages use `Referrer-Policy:
same-origin`; continuation pages and notices without forms keep `no-referrer`.
This permits a full-URL `Referer` only to a same-origin coordinator endpoint, so
operators should treat same-origin request URLs as potentially containing
transient callback parameters and avoid retaining provider codes or CSRF values
in logs. Google avatars, loopback destinations, and other remote hosts do not
receive it; the avatar remains explicitly `referrerpolicy="no-referrer"`.

The Fetch [append a request `Origin` header](https://fetch.spec.whatwg.org/#append-a-request-origin-header) algorithm sends `Origin: null` for a non-CORS `POST` under `no-referrer`; a same-origin form under `same-origin` keeps its real origin. This renderer changes no Origin-header policy: it is only a prerequisite for a later strict `POST` check, which must reject `null` and must not use a Referer fallback.

Its CSP is `default-src 'none'`, the specific style hash, `form-action 'self'`, `base-uri 'none'`, `frame-ancestors 'none'`, and either the exact permitted picture origin or `img-src 'none'`. It does not allow loopback, `http:`, remote styles, or scripts.

This is server-rendered auth UI, not a viewer/settings surface. CSP form-action may block a confirmation `POST` that later redirects to loopback in Chrome; the later handler design must preserve immutable IPv4 and IPv6 loopback literals and test a separate completion reply or trusted anchor.

The same cross-origin form-redirect concern applies to a sign-in POST followed
by a Google redirect. The explicit continuation page avoids broadening
`form-action`; actual browser behavior still needs validation.

## Integration limits and validation

Before an authenticated caller uses a page, it must read a live session or
consume a reviewed link attempt using the actual SDK and durable browser
transaction. A pre-start sign-in form has no live row yet: its later POST must
verify Origin and the start MAC, refuse an existing ceremony, and commit unique
binder admission before promotion and provider continuation. No UI HTML method
grants access or proves a browser stored a cookie.

The pre-link profile is held only for the rendered confirmation response; this module writes no personal data. The separate [account-profile storage contract](coordinator-auth-account-profile-storage.md) can retain a display snapshot only after a fresh normal sign-in, never from first-link confirmation. It does not change this renderer's image-host policy or make browser routes live.

JSDOM or Worker tests can check projection, escaping, and headers. They do not prove Chrome/Safari navigation, CSP behavior, image failure, or layout.
