# Coordinator browser credentials

**Status:** Reviewed helper capability, including `start` and same-value promotion.
Not exported from a package entrypoint.
Browser routes, stores, configuration, provider setup, network access, and live
keys remain outside this slice.

## Purpose and boundary

`packages/core/src/coordinator-browser-credential.ts` issues and parses opaque
browser cookie credentials. It does not authenticate a request: a present
credential only supplies a lookup hash for a later live store read.

```ts
const issued = await issueBrowserCookie("transaction");
// caller persists issued.cookieHash first
response.headers.append("Set-Cookie", issued.setCookie);
```

Append a transaction or session `setCookie` only after its durable write commits.
`append`, rather than `set`, preserves other cookies. Every issue call generates
a fresh credential; clients cannot choose one.

## Source API

| API | Result or rule |
| --- | --- |
| `issueBrowserCookie(kind)` | Async `{ secret, cookieHash, setCookie }`. The hash is 64 lowercase hex characters. Every call, including `start`, uses fresh entropy. |
| `readBrowserCookie(cookieHeader, kind)` | Async `absent`, `invalid`, or `present` with an opaque secret and hash. Accept a native `request.headers.get("Cookie")` string, not a `Headers` object. |
| `clearBrowserCookie(kind)` | A `Set-Cookie` string with an empty value and `Max-Age=0`. |
| `browserCookieValue(secret, expectedKind)` | Internal-only encoded-value accessor for later server-key MAC input. |
| `reissueStartCookieAsTransaction(secret)` | Synchronously returns a transaction `Set-Cookie` header using the same start value. It accepts only an opaque start handle, issued or parsed by this module. |

Invalid kinds and unusable, forged, spread, deserialized, or wrong-kind secret
handles throw the fixed `auth_browser_credential_invalid_input` error. Entropy
and digest failures throw fixed errors without a cause or private exception.

## Start issue and promotion

```ts
const start = await issueBrowserCookie("start");
// A start GET may append start.setCookie before any durable transaction exists.

// Only after POST Origin + explicit CSRF-MAC gates and durable unique-binder admission:
response.headers.append("Set-Cookie", reissueStartCookieAsTransaction(start.secret));
// The caller clears the start cookie separately after its authorized commit.
```

The helper returns only the transaction header; the caller appends it after the
durable start commit. It uses the same canonical 43-character value, consumes no
entropy, leaves the original handle start-kind, performs no internal burn, and
is not a one-shot, freshness, or authorization proof. Repeated header generation
is permitted.
Later admission must use its durable unique cookie/binder binding only after the
current handler's `POST` Origin and explicit CSRF-MAC checks, and reject a new
active ceremony. The pre-database start GET must not replace an existing durable
transaction.

The store's unique binder excludes duplicate admission while its transaction row
is retained. This is not a permanent issuance receipt: approved retention can
later remove that row. The helper proves neither the cookie's birth time nor
that the original response reached the browser.

Promotion deliberately does not rotate the credential: anyone who knows the
start value also knows the promoted transaction value. The future browser flow
requires fresh server issuance and browser enforcement of the `__Host-` cookie
rules; those browser assumptions still need dogfood verification.

## Credential and cookie format

The credential is 32 random bytes, encoded as canonical 43-character base64url.
The hash commits SHA-256 over those raw 32 bytes, not an encoded ASCII snapshot.
`BrowserCookieSecret` is an opaque WeakMap handle backed by a frozen empty object;
its JSON form is `{}` and it cannot recreate access to the underlying value.

| Kind | Name | Lifetime |
| --- | --- | --- |
| `start` | `__Host-codemem-auth-start` | `AUTH_BROWSER_TXN_TTL_MS` / 600 seconds |
| `transaction` | `__Host-codemem-auth-transaction` | `AUTH_BROWSER_TXN_TTL_MS` / 600 seconds |
| `session` | `__Host-codemem-session` | `AUTH_SESSION_TTL_MS` / 28,800 seconds |

Issue, promotion, and clear strings use `Path=/; Secure; HttpOnly; SameSite=Lax`
with no `Domain`. The `__Host-` prefix and flags are header declarations for
Node/Worker responses, not proof of browser enforcement. Client-relative
`Max-Age` starts at browser receipt and does not prove server age, liveness,
freshness, or expiry; each protected use still needs a live server lookup.

## Reading a Cookie header

```ts
const parsed = await readBrowserCookie(request.headers.get("Cookie"), "session");
if (parsed.kind === "present") {
  // Look up parsed.cookieHash in the live session store before authorization.
}
```

`null`, `undefined`, or whitespace-only headers are `absent`. A valid unknown
cookie is ignored. No unknown cookie value is decoded, parsed as JSON, or treated
as a credential.

The raw header is limited to 8,192 ASCII bytes. Space and tab are the only
optional whitespace; other controls, non-ASCII bytes, commas, malformed pairs,
and malformed known values return `cookie_malformed`. A case variant is malformed
alone, or `cookie_duplicate` when it repeats an already-seen known name.
Duplicate known names are rejected even while reading either other kind.

A malformed or oversized unrelated cookie also makes the whole header invalid;
callers must treat it as unauthenticated. Parent-domain cookies or other services
on the same host can therefore block browser auth. Cookies are not isolated by
port, and this coordinator may be unable to clear a foreign cookie. This fails
closed rather than ignoring ambiguous input.

Invalid input is returned without echoing the input as one of:

```ts
{ kind: "invalid", error: "cookie_duplicate" }
{ kind: "invalid", error: "cookie_malformed" }
```

These labels are internal helper results. Future public handlers must normalize
them and must not disclose parsing detail.

## Secret handling and later integration

`setCookie` deliberately carries raw bearer header material, while `cookieHash`
is sensitive internal data. Never log or JSON-serialize an issue/read result, a
request cookie header, a cookie hash, `browserCookieValue` output, or any
`Set-Cookie` value. The opaque secret is not a promise of whole-DTO redaction.

`browserCookieValue` is reserved for a later server-key MAC message; the cookie
must never become the MAC key. Reflection across JavaScript contexts cannot turn
opaque data into a valid handle: only the module's WeakMap grants accessor use.

This helper does not implement CSRF, server keys, referrer or Origin checks,
logout, account linking, revocation, cleanup, metadata persistence, secret
erasure, or expiration enforcement. Real Chrome tests, including stored IPv4 and
IPv6 loopback completion behavior, remain future integration gates.
