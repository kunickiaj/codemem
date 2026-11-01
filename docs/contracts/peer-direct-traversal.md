# Peer direct traversal contract

**Status:** Product ordering is accepted. This is a design contract for local,
disabled-by-default feasibility work. It does not select a traversal runtime,
package, STUN deployment, or production activation.

## Purpose and path order

Traversal can save bandwidth and latency by keeping peer payload bytes off the
coordinator when a direct path works. It does not guarantee a successful direct
connection.

When choosing the path for a sync pass, the selector uses this order:

1. Existing ordinary direct connection.
2. Coordinator-assisted, hole-punched direct connection when traversal is
   supported and policy permits it.
3. Encrypted relay.
4. Offline wait under the existing sync policy.

Existing manual, direct, and Tailscale sync remain independent of the
coordinator. Ordinary direct remains preferred whenever it is available.

The coordinator may authorize a pair and relay bounded setup messages. It does
not forward application bytes after a direct connection succeeds. Candidate
reports and signatures from both peers do not prove that an address belongs to a
peer or that it is reachable.

## Scope and decision boundaries

This contract covers the future traversal path between two already known peers.
It preserves the current peer pins, request authentication, scope checks,
revocations, nonce handling, and apply semantics.

It does not add a coordinator-held peer key, scope grant, UPnP, NAT-PMP, or
manual port-forwarding requirement. It does not change the existing direct HTTP
bootstrap path or infer that its grant authorizes this new path.

The following implementation order is required:

1. Prove a traversal runtime and its adapter boundaries locally.
2. Review the control, admission, and authorization contract.
3. Integrate the connection selector.

Independent relay admission, endpoint, budget, health, and shared HTTP work can
resume after this architecture is reviewed and published. It does not require a
completed traversal selector. If no traversal candidate passes feasibility,
record the evidence and review whether to defer traversal before activating a
relay-only selector. A failed experiment cannot silently remove traversal from
the target policy.

The current `codemem-xvrt5` outbound acknowledgement gap blocks rollout. This
contract leaves acknowledgement behavior unchanged.

## Candidate transport approaches

The recommended local proof candidate is a reliable, ordered WebRTC
`RTCDataChannel`, with library-provided ICE and STUN, HTTP coordinator offer/answer and
candidate signaling, and no TURN configuration. A selected ICE pair that uses no
relay candidate can carry a bounded Node duplex adapter. The existing reviewed
Noise suite then authenticates the pinned device identity inside that channel.

The data channel's DTLS fingerprint and ICE address are transport facts. They do
not authenticate a device or grant scope access. A fresh Noise channel must
authenticate the expected pinned peer before application bytes are available.

The coordinator's HTTP API is not STUN. A separate STUN deployment must be
selected and proven before any public traversal trial. Local fixtures must make
no public STUN connection.

Two implementation candidates need a separate dependency and runtime review:

| Candidate | Potential benefit | Open evidence |
| --- | --- | --- |
| `werift` | Pure TypeScript WebRTC implementation. | Node 24 support, buffering behavior, supported platforms, and dependency health. |
| `node-datachannel` | Native binding to libdatachannel. | Node 24 support, supported platforms, native buffering, packaging, and dependency health. |

Neither package is selected as a product dependency. The linked project
documentation is source material, not test evidence for this repository.

libp2p DCUtR is a viable alternative when the project adopts compatible circuit
relay and transport integration. A bootstrap circuit relay can coordinate the
attempt without carrying application data. The existing custom WSS relay is not a
circuit-relay-v2 service, so DCUtR requires separate integration work.

Implementing a new UDP, QUIC, or STUN stack is rejected as the default because it
adds protocol, cryptography, portability, and maintenance work. UDP can be
blocked, and incompatible mappings or filters can prevent traversal.

## Pair admission and safe signaling

Before either peer sends a candidate, the coordinator must authorize a bounded
attempt for an expected peer pair. A traversal setup and admission message must
bind the attempt to the device pair, expected receiving endpoint, discovery
group, expiry, request session, transport, and initiator or responder role. The
design must specify deterministic handling for crossed simultaneous calls.

Unsolicited offers are denied. The responder must validate the expected peer and
the attempt before it emits Noise Message B, which can disclose its public
identity in XX. The setup message is untrusted until the Noise handshake confirms
the expected pin and common prologue.

The setup review must assign traversal a transport label and a fresh 16-byte
session ID. The current `0x02` reservation in
[the encrypted peer stream contract](relay-encrypted-peer-stream.md) describes
coordinator-free encrypted direct setup. Traversal must either receive a distinct
reviewed label or explicitly amend that reservation before using it. Transports
with different admission requirements must never share a prologue label. Current
relay wrappers are not approved for traversal unchanged.

The coordinator authorizes signaling, freshness, replay handling, and the named
pair. It must not treat candidate reports as reachability proof. The direct path
does not use relay admission's source, relay, and responder triple or call itself
a relay transport.

The rendezvous must bind the exact held Noise Message A digest as well as both
peers' candidate descriptions to the same attempt. Each endpoint obtains its own
online coordinator decision. A forwarded decision cannot replace that check.
The responder verifies the opening digest before passing any bytes to Noise or
sending Message B. Traversal needs its own purpose and policy. The existing relay
nonce compiler includes relay audience and metadata predicates and cannot be
used unchanged for traversal admission.

Initially, each peer HTTP exchange gets a separate rendezvous, session ID,
request nonces, coordinator checks, and bound Message A digest before its fresh
Noise channel opens. Both endpoints close the transport after that exchange.
Later exchanges in the pass retain the selected path kind but repeat setup.
Measure this setup cost in the local proof. Reusing an ICE connection or one
admission across several channels requires a separate protocol review that binds
every channel's unique session and opening digest.

Before runtime integration, the control contract must define and validate:

- envelope versions, fields, canonical encoding, signatures, and replay rules;
- candidate and pair binding, candidate lifetime, attempt expiry, and role rules;
- allowlisted candidate classes, including treatment of LAN, private,
  link-local, loopback, multicast, broadcast, metadata-service, and IPv4-mapped
  aliases;
- anti-amplification consent, UDP packet and byte budgets, concurrent attempts,
  and the portion of the caller deadline available to traversal; and
- cancellation, late-event disposal, and any library APIs that enforce each
  proposed limit.

The implementation must probe only authorized, allowlisted peer candidates. It
must not provide arbitrary-address probing or an open proxy. Exact limits require
review against the selected library's observable controls. The design must not
invent numbers that its adapter cannot enforce.

## Connection, HTTP, and cancellation rules

Traversal starts only when ordinary direct is unavailable and the caller has time
remaining in its overall deadline. It has bounded work and does not run repeated
probes on every poll. Cancellation closes every socket, channel, timer, adapter,
and attempt reservation owned by that invocation.

An authentication or policy mismatch is an authorization failure. The selector
must not reclassify it as reachability failure and downgrade to relay.

Before a peer HTTP request sends any bytes, the selector chooses one path.
Reachability failures during setup or read-only status negotiation may try the
next path with fresh request nonces, subject to the authorization rule above.
After status succeeds, the pass keeps the selected path kind for its remaining
exchanges. Once a mutating request might have applied, a partial or ambiguous
result prevents automatic resend, mid-exchange transport switching, cursor
movement, or acknowledgement. The caller follows the existing idempotence and
reconciliation rules.

Signaling can use multiple HTTP rounds. Each traversal peer HTTP exchange uses
one fresh Noise channel and retains the existing complete-request and
complete-response rules. The shared dispatcher must require v2 and
recipient-bound v3 authentication, channel-pin/request-signer binding, scope,
revocation, replay, and limits before serving or applying memory. Bootstrap-grant
fallback is forbidden on traversal. The exact setup envelope needs review before
runtime work.

### Integration gaps

`sync-pass.ts` currently retries addresses without typed failure phases. The
selector needs explicit setup, status, and later-exchange outcomes so it can
enforce the switching rules. Its direct success bookkeeping also persists
addresses. Traversal candidates, signaling tokens, and synthetic base URLs must
never enter presence, `addresses_json`, `manual_addresses_json`, or
`last_success_address`.

`RequestJsonExecutor` is a per-request injection seam, not a complete pass
lifecycle. HTTP-over-duplex parsing and shared dispatch with trusted channel
context remain implementation work. The new path must provide that context as
`traversal`, independently of request headers. The current WSS framing, relay
service proof, registration, and audience policy stay specific to relay.

## Local feasibility evidence

Local-only disposable development is approved. It uses no real devices, keys,
hosted services, default-schema changes, deployment, or public STUN server.

| Scenario | What it can show | What it cannot show |
| --- | --- | --- |
| Ordinary direct available | The selector keeps the existing preferred path. | Traversal behavior. |
| Localhost adapter | Adapter, ordering, Noise, cancellation, and cleanup behavior. | NAT traversal. |
| Controlled disposable NAT fixture | A compatible-NAT success case and incompatible or blocked-UDP failure. | Internet-wide NAT compatibility. |

A successful direct proof records that ICE selected a non-relay candidate pair,
TURN was disabled, candidate exposure was not logged, and application bytes were
absent from the coordinator. A hidden TURN path or circuit payload relay cannot
be counted as direct.

The local matrix must include wrong pins and prologues, replayed candidates and
attempts, crossed pairs, timeout, malformed candidate lists, late events,
cancellation, backpressure, stalled native buffers, interrupted HTTP responses,
policy disablement, and revocation. Each failure must close owned resources and
preserve the current fail-closed authorization behavior.

Public endpoint, STUN, and device-NAT trials require later approval. A bare
localhost result is adapter evidence and does not prove NAT traversal.

## Observability and release gates

Selection telemetry may contain numeric path counts and finite reason classes.
It must exclude raw candidates, private IP addresses, SDP, device keys, tokens,
payloads, and project labels.

Traversal shares the relay program's privacy, clock, service-level objective,
and acknowledgement gates. Local feasibility results do not provide production
assurance. Operators need an explicit policy control before traversal can run
outside disposable local development.

## References

- [Relay protocol](relay-protocol.md) and [relay operations](relay-operations.md)
- [Encrypted peer stream over a live relay](relay-encrypted-peer-stream.md)
- [RTCPeerConnection](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection)
- [libp2p DCUtR](https://github.com/libp2p/js-libp2p/blob/main/packages/protocol-dcutr/README.md)
  and [libp2p WebRTC transport](https://github.com/libp2p/js-libp2p/blob/main/packages/transport-webrtc/README.md)
- [werift](https://github.com/shinyoshiaki/werift-webrtc) and
  [node-datachannel](https://github.com/murat-dogan/node-datachannel)
