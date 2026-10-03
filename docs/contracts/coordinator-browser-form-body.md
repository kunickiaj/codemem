# Coordinator browser form-body parsing

**Status:** Reviewed helper capability. Browser routes, guards, and package exports remain unchanged.

## Purpose and boundary

`packages/core/src/coordinator-browser-form-body.ts` reads a bounded browser form body and parses fixed fields for an already-selected action. It parses untrusted input; it grants no authority.

```ts
const body = await readBrowserFormBody({
  body: request.body,
  contentLength: request.headers.get("Content-Length"),
});
if (!body.ok) return body.error;
const form = parseBrowserFormBody(body.bytes, "transaction_attempt");
if (!form.ok) return form.error;
```

The helpers do not use `Request.text()` or `Request.formData()`. They do not set
their own timeout: transport policy must protect handlers from slow senders.

## Source API

| API | Result or rule |
| --- | --- |
| `readBrowserFormBody({ body, contentLength })` | Async read result: owned bytes, `form_invalid`, or `body_too_large`. |
| `parseBrowserFormBody(bytes, action)` | Synchronous parsed result or `form_invalid`. `action` is `transaction_attempt` or `session_logout`. |
| `BROWSER_FORM_BODY_MAX_BYTES` | `4096` actual body bytes. |

The read input must be an own-data record. `body` is a native unlocked, undisturbed `ReadableStream<Uint8Array>` or `null`; missing, locked, used, or invalid streams produce `form_invalid`.

For an absent HTTP header, supply an own `contentLength` property containing
`null` or `undefined`. Otherwise it must be an ASCII string of one through ten
digits. A declared value above 4,096 rejects early as `body_too_large`; a lower
value is not accepted as proof of the actual size.

## Reading rules

The reader accumulates at most 4,096 actual bytes. Every native `Uint8Array` chunk is copied into one owned allocation before the next read, so a producer cannot change retained data by reusing its mutable buffer.

Malformed chunks, read faults, and actual-size overflow return a fixed result. Overflow and read faults request reader cancellation, but do not await it: untrusted cancellation may never settle. Lock release is attempted in `finally`; cleanup failures never replace the fixed result. No raw exception or cause is returned. JavaScript cancellation completion varies by stream implementation; the source makes no stronger guarantee.

## Form grammar

The body must be nonempty, valid fatal UTF-8, and no more than 4,096 bytes. The raw decoded form is ASCII only and permits this character set:

```text
A-Z a-z 0-9 * . _ % + = & -
```

Each nonempty `&`-separated pair has exactly one raw `=` and a nonempty key.
Keys and values decode with `decodeURIComponent` after `+` becomes a space.
An encoded `=` is valid in a value, for example:

```text
csrf=token%3Dvalue&attempt_id=attempt-1
```

Malformed percent escapes, invalid UTF-8, overlong sequences, surrogate data, a raw BOM, raw non-ASCII characters, empty segments, duplicate names, unknown names, and prototype-like fields fail as `form_invalid`.

## Required fields

| Action | Exact fields |
| --- | --- |
| `transaction_attempt` | `csrf`, `attempt_id` |
| `session_logout` | `csrf` |

`attempt_id` uses the existing controller-ID predicate: a trimmed nonempty string of at most 256 characters with no Unicode control, format, or surrogate characters. `csrf` must be present but may be empty at this parsing boundary.

The returned outer result objects are frozen. Their values are sensitive internal/transient data: do not serialize them to HTTP or logs. In particular, CSRF text and returned raw body bytes need later handling as secrets.

## Later guard requirements

A caller must separately enforce method, content type, configured Origin,
request/client limits, and any cookie and live-store lookup. It must validate
the CSRF token shape and MAC, then apply the chosen transaction or logout
operation.

This helper does not perform cryptography, authentication, authorization, Origin or cookie checks, client limits, database access, key operations, or network access. It neither injects a root CSRF server key nor changes loopback literal policy, routes, Worker behavior, configuration, environment, stores, or schemas.

Node or Worker fixtures can exercise parsing but do not prove browser stream
behavior. Browser integration and platform-level slow-sender protection remain
required before a public handler can rely on this helper.
