# Coordinator browser CSRF tokens

**Status:** Reviewed, user-approved helper capability. It is unmounted and not
exported from a package entrypoint.

## Purpose and boundary
`packages/core/src/coordinator-browser-csrf.ts` issues opaque CSRF tokens bound to a browser cookie, purpose, and immutable coordinator scope, and verifies them.
It does not authenticate a request or authorize an account.

```ts
const key = await importBrowserCsrfKey(testKeyBytes);
const token = await issueBrowserCsrfToken(key, cookie.secret, "session", scope);
const valid = await verifyBrowserCsrfToken(key, cookie.secret, "session", scope, token);
```

`valid` only means the token MAC matches these inputs. A protected handler also
needs a live session/transaction lookup and matching binder, plus an explicit `POST` Origin check before authorizing an action.

## Source API
| API | Result or rule |
| --- | --- |
| `importBrowserCsrfKey(raw)` | Accepts a native 32-byte `Uint8Array`, copies it before the first `await`, and imports non-extractable Web Crypto HMAC-SHA-256 material for `sign` and `verify`. |
| `issueBrowserCsrfToken(key, cookie, purpose, scope)` | Returns a fresh canonical 86-character base64url token. |
| `verifyBrowserCsrfToken(key, cookie, purpose, scope, token)` | Returns `true` only for a valid MAC; malformed input, invalid handles, and crypto failures return `false`. |
| `isBrowserCsrfToken(value)` | Checks only canonical token shape. It does not verify a MAC, cookie, session, or browser. |

Imported keys and cookie secrets are frozen empty objects in module-local `WeakMap` entries. Their JSON form is `{}`; it does not promise redaction for a
whole caller-owned object, console output, or a collector. Invalid key, handle,
scope, or purpose input throws `auth_browser_csrf_invalid_input`; import and
issue crypto failures use fixed `auth_browser_csrf_*` errors without secrets.

## Key isolation and lifecycle
The caller supplies an independent 32-byte server CSRF key. It must not reuse a
cookie value as a key, a Google client secret, sync/admin/device key, or any
provider credential. `browserCookieValue` is MAC message binding data, never a
MAC key.

This helper has no default/generated key, global/per-isolate fallback, environment loading, key provisioning, deployment, route, or rotation API.
Current source uses test/mock key material only; a later operator integration
must provide the same server key to every instance. Replacing that key makes old
tokens fail verification; previous-key grace is out of scope.

No root-key derivation, custom HKDF, key profiling, metadata field, or secret
source is part of this contract. The `scope` input contains its own primitive
snapshots of `coordinatorId` and `revision`; OIDC client secrets are ignored.

## Bound scope and authenticated message
`scope.publicOrigin` must be the exact statically configured HTTPS public origin, not a URL path, request Host, Origin, forwarding header, or a value selected by a browser.
The source accepts only an exact origin string, with no credentials or controls.

`scope.store.coordinatorId` is a validated opaque ID and `revision` is exactly
64 lowercase hexadecimal characters. Values are read as own data before crypto;
accessors, inherited values, and invalid handles fail closed. Proxy reflection
traps may run during inspection; their failures become the fixed invalid-input
error rather than exposing their cause. The UTF-8 message is
JSON for this fixed array, in this order:

```ts
[
  "codemem-browser-csrf-v1", purpose, coordinatorId, publicOrigin,
  revision, encodedCookie, encodedNonce,
]
```

`purpose` is exactly `"transaction"` or `"session"`. `encodedCookie` and
`encodedNonce` are canonical 43-character base64url encodings of 32 bytes.
The format is local policy; it is not presented as an OWASP-prescribed JSON form.

The message, cookie value, cookie hash, internal session ID, and key are never
returned or logged. The token contains only MAC bytes and a deliberately public
random nonce; that nonce is not a browser credential.

## Token format and verification
Each issue call obtains a new 32-byte CSPRNG nonce. Collisions are negligible,
not mathematically impossible. The token is the 32-byte HMAC followed by that
32-byte nonce, encoded as one canonical 64-byte base64url value:

```text
<MAC-32-bytes><nonce-32-bytes>  →  86 characters, no padding or dot
```

The canonical final character is one of `A`, `Q`, `g`, or `w`. Parsing bounds the
value to 86 characters and 64 decoded bytes before Web Crypto verifies the first
32 bytes against the message containing the last 32 bytes. Verification uses
`crypto.subtle.verify`, not a JavaScript comparison; Web Crypto makes no formal
constant-time guarantee, and this contract makes no such claim.

Tokens are per-render fresh, but are not single-use. An older MAC remains
verifiable for the same cookie, scope, and key, so browser Back does not inherently
fail. A handler may accept it only while the corresponding session or transaction
is live. There is no timestamp, CSRF database field, or per-request state;
clock changes do not alter this helper's MAC verification result.

## Integration gates
A valid MAC can be made for an attacker-owned cookie with this helper. It is not
an account proof, user proof, or authorization decision. Future handlers must
look up and bind the original live cookie/session or transaction after MAC
verification, then enforce their explicit Origin policy.

This helper does not read HTTP requests, validate Origin or Referer, provide an
Origin fallback, or make a read-only standalone check safe. A future handler
must compare the `POST` Origin to the configured public origin and reject
`null`; accepting `null` and using a Referer fallback are out of scope.

The form renderer now accepts canonical 86-character tokens. This does not mount
guards or sign-in routes: real-browser/CSP validation, signed runtime completion,
and Origin/liveness enforcement remain future gates.

## References
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html): server-side secrets, session binding, and unpredictable tokens.
- [Web Crypto API: `SubtleCrypto`](https://www.w3.org/TR/WebCryptoAPI/#subtlecrypto-interface): HMAC key import, signing, and verification semantics.
