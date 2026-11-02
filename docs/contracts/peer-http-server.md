# Owned peer HTTP server

`servePeerHttpConnection` serves one HTTP/1.1 exchange over a fresh caller-owned
Noise connection. It creates a native HTTP parser without listening on a network
socket. It does not export a package entry point or mount an application route.

## Ownership and callback

Every call transfers the supplied `OwnedPeerHttpConnection`, including a call
with invalid options. The connection contract matches the owned client: a fresh,
unbuffered, non-flowing `RelayNoiseDuplex`, a promise proving clean raw I/O and
disposal, and an idempotent disposer for the whole connection.

The caller supplies a logical HTTP origin and a trusted `dispatch` callback. The
callback receives the method, exact origin-form target, full logical URL, copied
header values, raw body bytes, and cancellation signal. It returns a status,
optional header record, and raw response bytes. No JSON reserialization occurs.

This callback must enforce channel-bound identity, current pins, recipient-bound
v3 authentication alongside v2, explicit scope authorization, and no bootstrap
fallback before exposing application data. Passing the ordinary full sync app
without those restrictions does not satisfy this contract.

## Framing and completion

Only GET and POST are accepted. The limits are 16 KiB for the complete start line
and headers, 1 MiB for the request, and 16 MiB for the response. Each message has
exactly one decimal Content-Length. Unsupported framing, informational responses,
Expect, upgrades, CONNECT, trailers, duplicate headers, and extra requests deny
the exchange. Native header-count truncation is disabled.

The server preserves path/query encoding and order and rejects normalization.
Host must match the configured logical origin. Responses use an explicit content
length and Connection: close, with automatic Date generation disabled so header
accounting includes every wire byte. Statuses 204 and 304 require an empty body.

The independent request audit starts before the native parser and remains through
plaintext EOF. Dispatch starts only after native request completion and an exact
body-length check. Waiting for raw EOF before dispatch would deadlock a client
that waits for its response before closing.

If the peer sends request EOF before dispatch finishes, the writable side remains
open until the response completes. Request EOF does not cancel a pending reply.

Application writes can therefore commit before late pipelining or surplus bytes
fail the exchange. A failure must remain uncertain to the caller. It cannot
advance an acknowledgement cursor or trigger an automatic mutation retry.

Success requires the response write, audit EOF, plaintext completion, and clean
owned raw completion. The deadline is at most 60 seconds from invocation, reduced
by an earlier caller deadline. Cancellation and failures stop plaintext I/O and
dispose the owned connection once, with at most 1.5 seconds for cleanup. Errors
use the existing fixed peer HTTP codes without payload snippets.
