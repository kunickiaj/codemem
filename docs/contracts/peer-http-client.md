# Owned peer HTTP client

`createPeerHttpExecutor` creates an internal `RequestJsonExecutor` over injected
Noise connections. Each call obtains one fresh connection and carries one
HTTP/1.1 exchange. The ordinary `requestJson` helper and direct sync defaults
are unchanged. This module has no package index export or startup wiring.

## Connection ownership

The caller supplies `PeerHttpConnectionFactory.open({signal, deadlineMs})`.
It must return an `OwnedPeerHttpConnection` containing:

- A fresh, unbuffered, non-flowing `RelayNoiseDuplex`.
- A `completion` promise that resolves only after clean underlying raw I/O and
  resource disposal. A resource-only `disposed` promise is insufficient.
- An idempotent `dispose(error)` that owns the entire channel and settles within
  the cleanup grace.

The factory remains responsible for pinning, admission, raw transport queues and
wire quotas. The HTTP client verifies neither coordinator authority nor an RTC
engine's resource limits. Native sockets are rejected because their parser can
bypass JavaScript byte observers.
The client keeps the stream paused until both the audit and native parser are
installed, then explicitly resumes it. An explicitly paused factory stream is
supported.

## Request bytes and limits

Only uppercase `GET` and `POST` are supported. Body-bearing calls require
`bodyBytes` prepared before signing. The executor copies those bytes before
opening the connection and never reserializes `body`. Empty requests have an
explicit zero content length.

The client preserves path and query encoding and order. It rejects URL
credentials, fragments, unsafe characters, and a target that changes under URL
parsing. Supplied headers cannot duplicate names by case, request unsupported
framing, disagree with the logical host, or contradict the body length.

The limits are 16 KiB for the complete start line and headers, 1 MiB for requests,
and 16 MiB for responses. `maxResponseBytes` may reduce the response cap to zero.
The default deadline is 60 seconds from invocation. `timeoutS` may only reduce
that limit. An absolute caller deadline, expressed using `performance.now()`,
may shorten the selected timeout and never extends it. Timeout and response-size
options above their hard ceilings are rejected.

## Response acceptance and failures

Node parses HTTP syntax. The client also validates a single content length,
rejects unsupported response events and framing, and retains an independent
plaintext byte audit through EOF. HTTP message completion starts source shutdown.
It does not finish the audit or make the response usable.
Native header-count truncation is disabled so validation sees every field within
the 16 KiB wire limit.

The executor returns a tuple only after the native response completes, the audit
accepts EOF, and clean plaintext and owned raw completion succeed. Response bytes
use one bounded buffer. Empty bodies return `null`. Non-object or malformed JSON
returns a fixed error record without a payload snippet.

Deadline and cancellation errors use fixed messages. A failed exchange disposes
the owned channel once and waits at most 1.5 seconds for cleanup. A factory that
resolves after cancellation or expiry still has its connection disposed. The
factory must settle by its deadline. Defensive late cleanup does not prove that
a factory violating that contract released resources on time.

The client never follows redirects, opens a fallback socket, reuses a connection,
or retries a request. A caller must reconcile an uncertain mutation before any
later retry or path change. Server dispatch, scoped authorization, path selection,
and runtime activation remain separate work.
