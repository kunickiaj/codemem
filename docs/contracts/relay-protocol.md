# Relay protocol over Noise channels

**Status:** Reviewed v1 transport contract. Local disabled-by-default
implementation is approved. Hosted execution, real-device dogfooding, activation,
and deployment remain separately gated.

**Task:** `codemem-zjvr.1.3`. Related suffixes such as `.1.4` refer to
`codemem-zjvr.1.4`.

## Purpose

One fresh Noise channel carries one existing peer-sync HTTP/1.1 request and its
final response. One outer WSS connection multiplexes named routes.

## Connection selection

The [peer direct traversal contract](peer-direct-traversal.md) defines the
accepted direct-before-relay ordering and the feasibility, admission, and
authorization work required before traversal integration.

When choosing a sync pass's path, the client tries the existing ordinary direct connection
first. If that path is unavailable, coordinator-assisted NAT hole punching is
the next preferred attempt. The encrypted relay is the final fallback when
traversal is unsupported or its connectivity checks fail or time out. This is
the target selection policy. Traversal still requires feasibility and
transport-selection review before integration. Current WSS Noise work implements
relay foundations and does not implement UDP hole punching.

The coordinator authenticates control signaling and exchanges short-lived
candidates between authorized counterparts. It does not forward data after a
direct connection succeeds. Observed addresses are candidates, not authority:
each endpoint must authenticate its pinned peer and preserve the existing
encryption, request authentication, scope, and revocation checks before sending
memory data. After status negotiation succeeds, the pass keeps that path kind.
Each peer HTTP exchange still requires a fresh channel.

Before connection-selection integration or activation, the design must specify
and test the selected transport, candidate lifetime and validation, probing only
toward the authorized counterpart, deadlines, retries, and resource limits. The
design must not permit arbitrary-address probing or turn a participant into an
open proxy. UPnP, NAT-PMP, and manual port forwarding are outside this design.

UDP may be blocked, and NAT behavior may prevent hole punching. Those outcomes
select the relay fallback without relaxing its admission gates. A failed path
must begin a fresh exchange under the existing per-invocation rules. It must not
silently switch transport or automatically replay an operation that might have
been partially applied.

The opener is the HTTP client and Noise initiator. The target is the HTTP server
and Noise responder. A reverse request opens a new route with reversed roles.

The transport retains existing identities, scopes, and request signing. It adds
no cryptographic handshake, inner request identifier, role multiplexing scheme,
or Noise record parser.

## Terms

| Term | Meaning |
| --- | --- |
| Route | An admitted exchange between a source and target. |
| Session ID | A random 16-byte route ID. |
| Exchange | One request, final response, and fresh Noise channel. |

## Route rules

- The route ID associates the request and response. Inner request counters and
  correlation headers are forbidden.
- A relay channel uses transport label `0x01` and the route ID in the prologue
  specified by [Encrypted peer stream over a live relay](relay-encrypted-peer-stream.md).
- The relay forwards opaque Noise wire bytes. It does not parse or authenticate
  Noise records.
- A sender can split a Noise record at any byte boundary. A receiver concatenates
  ordered payload bytes before passing them to the Noise library.
- Source, target, session ID, and bound WSS sockets determine direction. Data
  frames contain no HTTP correlation, source, target, scope, key, or auth field.
- Close, rejection, expiry, and disconnect discard partial state. A reconnect
  needs a new route, handshake, and signed-request nonce.

## Admission and capacity

Gate `.1.4` owns the initial connection service proof and route admission.
Before both complete, an endpoint sends no route data or Noise identity payload.
The relay does not disclose target presence or roster details.
The [admission contract](relay-admission.md) defines authenticated socket
registration before target routing and the three independent coordinator checks
for a route. A claimed device ID never creates a socket mapping.

The router has an active-session map for each routing namespace and endpoint
connection. It rejects an active session-ID collision and never replaces a route.
It binds source, target, session ID, and WSS sockets. A frame replayed from a
different socket, source, target, or session fails.

Each peer pair allows one locally initiated and one remotely initiated exchange.
These are independent reservations. An opener checks capacity before it creates
or signs an HTTP request. When full, it waits at most three seconds or the
caller's earlier deadline, then rejects. No component keeps an unbounded queue.
At most one local opener may wait per peer. Further local requests fail capacity
checks, and excess incoming opens are rejected rather than queued remotely.

A retry uses a new route, nonce, and current authorization. It does not rewrite
the request body or scope.

## Control messages

Controls are UTF-8 JSON with a maximum encoded size of 4,096 bytes.

```json
{"v":1,"type":"OPEN","session":"0123456789abcdef0123456789abcdef","body":{}}
```

| Field | Rule |
| --- | --- |
| `v` | Integer `1`. Unknown versions fail. |
| `type` | Route controls: `OPEN`, `ACCEPTED`, `REJECTED`, `CLOSE`. Connection controls: `SERVICE_CHALLENGE`, `SERVICE_PROOF`, `SOCKET_CHALLENGE`, `REGISTER`, `REGISTERED`. |
| `session` | Exactly 32 lowercase hexadecimal characters. A route control uses its route ID. A connection control uses its current service or socket challenge ID in a separate namespace. |
| `body` | A bounded object whose canonical schema belongs to `.1.4`. |

This contract defines no authentication fields inside `body`. Controls contain
no raw scope IDs, request bodies, signing keys, or memory data. Invalid UTF-8,
malformed JSON, duplicate members, invalid IDs, oversize data, and invalid state
transitions reject the route or connection. Gate `.1.7` owns control rate limits.
Clients send `SERVICE_CHALLENGE` and `REGISTER`; the relay sends `SERVICE_PROOF`,
`SOCKET_CHALLENGE`, and `REGISTERED`. Connection challenge IDs cannot carry DATA,
replace an active route, or grant route permission. The admission contract fixes
the allowed state transitions and message bodies. Renewal is initiated by a fresh
client service challenge when work needs registration, not by a keepalive timer.

## Binary frames

Each data frame has a fixed 22-byte header and a nonempty Noise fragment.

| Bytes | Field | Rule |
| --- | --- | --- |
| 0 | Version | `1` |
| 1 | Kind | `1` for route data |
| 2–17 | Session ID | Raw 16-byte route ID |
| 18–21 | Payload length | Unsigned 32-bit big-endian length |
| 22… | Payload | 1 through 65,536 opaque Noise wire bytes |

The maximum binary frame is 65,558 bytes. The advertised length must match the
remaining frame exactly. Extra bytes, zero payload, an unknown version or kind,
an unadmitted session, or a wrong socket closes the route.

Payloads include length-prefixed Noise handshake or record bytes. Handshake
messages can carry public identity material. The protocol does not claim that
every handshake byte is encrypted. An operational frame counter can account for
traffic, but it is not an authentication field.

## Noise lifecycle

The opener may construct a fresh Noise factory and hold its first 34-byte message
A locally before OPEN, so its admission packets can bind that exact message.
It emits no Noise wire bytes before `ACCEPTED`. The target verifies `.1.4`
admission and selects the source from an existing pin, then checks the actual
opening bytes against their signed hash before giving A to the library. This
version-specific opening-prefix check is the sole framing exception to using the
library's Noise parser. Both endpoints use the route ID in the shared prologue.

Application bytes are available only after Noise authenticates the expected peer.
Handshake traffic is included in the caps below and finishes within ten seconds
of route acceptance. Handshake failure, identity mismatch, or unexpected EOF closes the
exchange. A relay route never creates or replaces a peer pin.

## HTTP boundary

After Noise, the channel carries one HTTP/1.1 request, one final HTTP/1.1
response, and route close. Both messages require `Content-Length`, including
`Content-Length: 0` for an empty body.

| Item | Limit or rule |
| --- | --- |
| Start line and headers | At most 16 KiB per message. |
| Request body | At most 1 MiB and any lower server configuration. |
| Raw ops | At most 2,000 or a lower configured maximum. |
| Response body | At most 16 MiB. |

The parser rejects transfer encoding, conflicting or duplicate content lengths,
upgrades, `100-continue`, informational responses, trailers, close-delimited
bodies, pipelining, and a second message. It parses one expected message. Bytes
beyond the declared body are errors. EOF does not complete a message. The sender
cannot prove that no future trailing bytes would have arrived after route close.
Request targets use origin form only, with no fragment or absolute URL.

The request adapter preserves method, path plus query order, percent encoding,
headers used by verification, and body bytes. It rejects a normalization failure
instead of re-signing changed bytes. The response adapter stages a bounded Hono
body and adds content length without changing body bytes.

The implementation uses a maintained runtime HTTP parser behind thin adapters.
It does not hand-roll a general parser. A response is usable only when complete
headers and the exact declared body arrive before the deadline. A terminal route
cannot carry a second exchange. A stream owner may need explicit EOF cleanup.

## Dispatch and authorization

The transport passes immutable trusted context to shared dispatch.

| Context field | Source |
| --- | --- |
| Device ID | Admitted and Noise-authenticated endpoint identity. |
| Pinned raw key | Existing local pin validated by Noise. |
| Session ID | Admitted route ID. |
| Transport kind | `relay` for this fallback. |

It does not derive that context from HTTP headers. The HTTP device ID must match
the channel's authenticated device ID, and v2 and v3 signatures must verify under
that channel's pinned signing key. A mismatch is rejected before nonce insertion
or scope authorization. Direct and relay calls share nonce and rate-limit stores.
A route does not allocate a rate-limit bucket.

Authenticated limits remain 120 reads and 30 mutations per 60 seconds.
Unauthenticated limits remain 20 reads and 10 mutations per 60 seconds. The
existing method and authenticated-device key remain shared across paths.
Relay requests, including HTTP authentication and body-validation failures, use
the Noise-authenticated device's bucket. They never consume the direct listener's
anonymous/bootstrap bucket or a bucket chosen by a failed HTTP identity header.
Charge once per request through shared dispatch, without charging again after
successful HTTP authentication. Pre-Noise control failures use `.1.7` quotas.

Relay dispatch accepts only `GET /v1/status`, `GET /v1/ops`,
`GET /v1/snapshot`, and `POST /v1/ops`. It structurally forbids bootstrap-grant
fallback. Every request requires v2 and recipient-bound v3 authentication.

Relay also requires a scoped capability. Ops and snapshot requests require an
explicit `scope_id`. Status can omit it because it returns authorized metadata
without memory data. The planner schedules explicit scoped exchanges even when
the default-scope phase is unavailable. It does not insert scope IDs or
reserialize signed bodies. Current direct default-scope behavior stays unchanged.

Local-only, inactive, missing, and non-member scopes follow the current scope
policy. Framing makes no Store calls. Existing authorization freshness, body,
membership, operation, scope, and apply checks remain in the shared handlers.

## Sync compatibility

| Exchange | Relay behavior |
| --- | --- |
| Pull ops | Generation, snapshot ID, and baseline cursor match. Reset and stale-cursor recovery follow current behavior. `since` equal to the retained floor is valid. `next_cursor` can advance when filtering returns no visible ops. |
| Snapshot | A token fixes the page boundary. The client collects all pages before applying. The current default total is 100,000 items, not bytes. |
| Push ops | Existing body and op limits apply. Oversize batches split before fresh signing. One unsplittable oversize op fails without an acknowledgement. |
| Status | It has no pagination. An oversize result is a bounded typed transport error. |

Clients normally request 500 ops, while servers cap pages at 1,000. The snapshot
fetch helper defaults to 200, but current sync-pass bootstrap callers request
2,000 with a 60-second timeout. The server permits at most 5,000. An authenticated
response-size error retries the same cursor, token, and reset boundary with
`floor(limit / 2)`, down to one.
Use the effective clamped page size for this calculation. Five thousand reaches
one after 12 halvings, so at most 13 attempts include the initial request. A
response that is still too large at one item fails without cursor progress.
The common 2,000-item bootstrap case takes at most 11 attempts. Current clients
do not implement this retry.

Only two observations permit page halving: a `Content-Length` above the response
cap inside the Noise-authenticated peer response, or a complete authenticated
HTTP 413 response with `{"error":"relay_response_too_large"}`. The server adapter
emits that small response, with an exact content length and at most 4 KiB of body,
when bounded staging would exceed 16 MiB. It must do so before writing any part
of the original response. The client cancels an oversized response and treats it
as a local typed transport-size error. It never parses a partial JSON body.

EOF, `CLOSE`, relay receipts, timeouts, framing errors, and reset responses do not
trigger page halving. Unexpected accumulated bytes beyond a declared length are
a framing failure. A status or push response-size error fails the exchange rather
than starting a page retry. A push may already have applied, so its later retry
retains the existing idempotence rules.

Relay response limits apply only to this transport. Existing HTTP callers usually
omit `maxResponseBytes`, so this contract does not claim compatibility for every
current HTTP record. Raising a server environment limit does not raise relay caps.

Push success requires HTTP 200 and a non-null body without a non-null own `error`
field. An own `errors` field must be an empty array. Legacy peers may omit it.
Apply errors leave the outbound window unacknowledged, including when a later
part of a split batch fails. Policy filter skips do not count as errors.
This shared predicate applies to direct requests and injected transport executors.
Route acknowledgement and `CLOSE` never advance a cursor or apply acknowledgement.

## Resource limits

| Limit | Rule |
| --- | --- |
| Exchange lifetime | Explicit relay default of 60 seconds from invocation, reduced by an earlier caller deadline. Every route also ends within 60 seconds of admission. |
| Wire traffic | 20 MiB total in both directions, including framing and handshake bytes. |
| Data frames | 2,048 total in both directions, including handshake fragments. |
| Queued ciphertext | 256 KiB per direction. |
| Transport-owned byte buffers | 40 MiB per exchange, including bodies, staging, copies, queues, frame buffers, and decoder buffers. |

Each component accounts bytes before allocation or enqueue. Queue pressure
pauses input for backpressure. Crossing a cumulative wire-byte, frame-count, or
message-size cap ends the exchange because waiting cannot release that budget.
A sender or relay that cannot respect a buffer cap closes the exchange. The
20 MiB cap leaves room for a 17 MiB combined body budget, headers, handshake, and
ordinary overhead.
These limits cover application-managed and observable transport buffers. They
do not claim to bound unobservable native or provider queues. The
[operations contract](relay-operations.md) makes selected-host buffering,
slow-reader, and oversized-input proofs activation gates.

Tiny valid records can exceed the frame count. Senders flush available bytes
without waiting for a maximum frame. The buffer limit covers transport buffers,
not Store, JSON, or other process allocations. Two allowed routes can consume
80 MiB plus non-transport allocations. Gate `.1.7` sets fleet-wide quotas.

## Deadlines and cancellation

Relay execution resolves its own default before the generic HTTP helper applies
a direct timeout. This is an explicit relay-only compatibility change:

| Path | Existing HTTP default | Relay default |
| --- | --- | --- |
| Status, ops pull, and push | 3 seconds | 60 seconds |
| Standalone snapshot helper | 10 seconds | 60 seconds |
| Current sync-pass bootstrap/snapshot calls | Explicit 60 seconds | 60 seconds |

An explicitly shorter caller deadline or cancellation still takes precedence.
An unset direct-helper default is not an explicit caller deadline and must not
silently reduce relay requests to three seconds. A longer caller timeout cannot
extend the relay's 60-second cap. The deadline starts at invocation and includes
queueing, admission, handshake, server work, and transfer. Local capacity waiting
uses at most three seconds or the remaining caller budget, whichever is shorter.
Endpoints enforce their own route deadlines without trusting an unlimited TTL
from the remote peer.

While receiving a partial header or body, ten seconds without bytes closes the
exchange. This idle timer does not apply after a complete authorized request while
the server computes before its first response byte. The absolute deadline still
applies. Initial idle defaults need measurement before implementation.
The 60-second default also needs latency and throughput measurements before
rollout. It does not promise that every response within the byte cap can cross
every slow link within the deadline. Timeout handling does not amplify one
failed exchange into repeated page-halving requests.

Expiry or disconnect drops incomplete queues. It dispatches no partial request
and advances no cursor from a partial response. A push handler can finish after
the client expires. The client ignores its late response and retries through
existing idempotence and nonce rules. No keepalive or ping keeps the relay awake.
Clients retain the 120-second persisted reconciliation interval.

## Implementation seams

This design uses logical seams in existing core and viewer-server modules. It
does not add a package. Core injects a request executor into the existing HTTP
client, bootstrap, and sync-pass paths. The Noise dependency stays behind the
restricted seam in the encrypted peer-stream contract.

Viewer-server needs a Hono request adapter, bounded serializer, bounded parser
adapter, and shared dispatcher integration. HTTP-shaped traffic from a spike does
not prove these adapters, cleanup, response bounds, or backpressure. Gate `.1.5`
reviews the integration before implementation.

Relay dispatch calls `app.fetch(req, env)` on the same live application created
by `createSyncApp`, with its existing stores and limiter. It must not create a
second app or limiter for relay requests. The in-process dispatcher supplies the
trusted transport context through an internal binding that external HTTP headers
cannot populate. `authorizeSyncRequest` needs an explicit relay mode accepting
that context, requiring exact v2 plus v3, comparing the header device and pinned
key before `recordSyncAuthNonce`, and selecting the channel-device rate bucket.
Status and snapshot handlers must skip bootstrap-grant fallback in relay mode.
These are future implementation changes, not APIs already present today.

## Required validation

No runtime tests implement this protocol yet. Later tests cover:

- opposite opens, active-session collisions, record cuts, bad lengths, tiny
  frames, replay, and wrong-source delivery;
- smuggling forms, conflicting lengths, pipelining, truncation, and EOF before a
  complete response;
- channel/signer mismatch before nonce insertion, shared nonce replay, and shared
  rate limits across routes;
- missing, local-only, and non-member scope plus bootstrap fallback on status and
  snapshot routes;
- page caps, limit-one retries, oversize status, reset recovery, and empty
  filtered pages whose scanned cursor advances;
- an authenticated oversize declaration or staged-body error triggers halving,
  while timeout, EOF, `CLOSE`, and forged relay controls do not;
- relay defaults allow setup and transfer beyond three seconds, explicit shorter
  deadlines still cancel, and direct timeout defaults remain unchanged;
- bad relay signatures consume the channel device's quota without reducing the
  anonymous quota available to direct bootstrap callers;
- HTTP 200 with `errors[]`, route receipts without a complete response, and no
  cursor movement from route close;
- cancellation after apply, ignored late responses, and retry safety; and
- control privacy: no raw scope, key, or body in controls.

## Open gates

| Gate | Decision still required |
| --- | --- |
| `.1.4` admission | Service proof, canonical schema and signatures, route binding, freshness, nonce handling, permissions, and initial connection proof. |
| `.1.5` architecture | Human approval of transport, adapters, lifecycle, hibernation, and implementation boundary. |
| `.1.7` operations | Rollout, disclosure, propagation, drain, operator disablement, incidents, control limits, and fleet quotas. |
| Connection selection | Feasibility evidence and a reviewed traversal transport choice, signaling/candidate rules, and probe limits before integrating direct, hole-punch, and relay selection. |

## References

- [Encrypted peer stream over a live relay](relay-encrypted-peer-stream.md)
- [ADR 0004](../adr/0004-authenticated-identity-and-live-relay-boundaries.md)
- [ADR 0005](../adr/0005-authenticated-identity-device-and-membership-lifecycle.md)
- [`sync-auth.ts`](../../packages/core/src/sync-auth.ts)
- [`sync-scope-protocol.ts`](../../packages/core/src/sync-scope-protocol.ts)
- [`sync-http-client.ts`](../../packages/core/src/sync-http-client.ts)
- [`sync-pass.ts`](../../packages/core/src/sync-pass.ts)
- [`sync.ts`](../../packages/viewer-server/src/routes/sync.ts)
