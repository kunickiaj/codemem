# Encrypted peer stream over a live relay

**Status:** Noise selected. Local disabled-by-default implementation approved.
Hosted activation, real-device use, and rollout remain unapproved.

**Task:** `codemem-zjvr.1.2`. Related suffixes such as `.1.5` refer to `codemem-zjvr.1.5`. That decision records human approval for local code and disposable-key/database tests only. Deployment, real-device dogfooding, relay activation, and runtime configuration changes require separate approval and the outstanding safety evidence.

## Purpose and boundary

When a direct path fails, the relay forwards an ordered encrypted byte stream between two named peers. Direct and LAN sync keep their current paths and remain preferred. The stream carries the current HTTP/1.1 request and response bytes without changing canonical request bytes.

The outer WSS connection protects each peer's route to the relay. The inner Noise channel protects sync bytes between peers. The relay and coordinator do not receive inner plaintext or inner session keys.

The crypto seam accepts an ordered duplex stream, local key material, an expected peer ID, a caller-supplied transport label and session ID, cancellation, and resource budgets. It returns an authenticated encrypted duplex stream and the observed identity. It does not expose Coordinator, relay admission, HTTP, or Store APIs. Callers continue to check membership, sending and applying permissions, and the shared HTTP authorization chain. The Noise dependency stays behind this module. This proposal does not create a package boundary.

### Non-goals

- Store-and-forward delivery, offline queuing, payload retention, remote erase, anonymity, padding, or compression.
- A custom cryptographic handshake, key derivation, certificate exchange, or admission certificate.
- A new device-ID, actor, scope, or authorization system.
- TLS replacement for the outer WSS route. Standard HTTPS certificate and hostname validation still applies there.

## Selected construction

Use `@libp2p/noise@17.0.7`, pinned to source commit [`d41cc9fdd9b92596246deba0d4b8ad0078adfc69`](https://github.com/libp2p/js-libp2p/tree/d41cc9fdd9b92596246deba0d4b8ad0078adfc69/packages/connection-encrypter-noise/src), with the exact `Noise_XX_25519_ChaChaPoly_SHA256` suite.

The peer that opens an admitted named stream is the XX initiator. Its target is the XX responder. Concurrently opened streams use separate, collision-checked route session IDs.

Libp2p verifies an Ed25519 signature over the exact prefix `noise-libp2p-static-key:` followed by the Noise X25519 static public key. The expected remote `PeerId` is passed to both `secureInbound` and `secureOutbound`; the library validates it during the handshake before it returns the encrypted connection. This authenticates a static X25519 key to the existing Ed25519 identity. It does not grant scope authority.

Create exactly one fresh factory per session and handshake attempt. It creates a new in-process X25519 static key, and the library creates fresh ephemeral handshake keys. The design persists, enrolls, or converts none of those X25519 keys. The existing Ed25519 signing key is reused only for the domain-separated identity signature. Final security review must approve that reuse. This proposal does not claim runtime approval.

Current request signatures begin with an uppercase HTTP method followed by a newline. Coordinator proof encodings, including owner enrollment, device rebind, and profile proofs, begin with a JSON array. The Noise signer signs the fixed lowercase prefix followed by a locally generated X25519 public key. These encodings are distinct. Reserve `noise-libp2p-static-key:` for this library's identity binding. No other signer may emit that prefix or sign an arbitrary caller-supplied Noise key. If `.1.5` rejects key reuse, relay implementation stops and this construction returns for revision. The design does not silently enroll another identity or enable an alternate protocol.

The integration does not start a libp2p node. It uses public `MessageStream` adapters and a typed restricted factory. Unsupported upgrader network operations throw, negotiation maps are empty, and `skipStreamMuxerNegotiation` is `true`. All exposed types remain public types without casts. Both the component logger and the underlying stream's `log`, including every `newScope` result, must be silent with `enabled: false`. Neither may emit key material even when `DUMP_SESSION_KEYS` is configured in the process.

### Identity and local key handling

The expected libp2p `PeerId` derives only from a strict decode of the existing pinned Ed25519 public key. The SSH decoder must require the inner type `ssh-ed25519`, an exact 32-byte key field, and no trailing wire bytes. It extracts that raw 32-byte public value for identity comparison. Existing permissive helpers cannot satisfy this boundary. Both endpoints compare the observed peer and key with the expected values. Relay input never creates or replaces a peer trust pin.

The existing PKCS#8, file, and keychain loader keeps its device and database context. A keychain provider returns key bytes only in process. This feature creates no additional persisted private-key copy. Missing, malformed, or identity-mismatched material fails closed. Generated keys currently use PKCS#8, although the loader does not normalize every accepted input format.

Key rotation requires explicit trusted re-enrollment and pin review, then closes affected streams. Restoring the database and signing key preserves identity but starts a fresh Noise handshake. Login or relay access cannot recover a lost key.

### Handshake binding and data gate

Both roles pass the same `prologueBytes` value:

```text
ASCII("codemem-peer-stream/1") || 0x00 || transportLabel[1] || sessionId[16]
```

The caller supplies a raw 16-byte random `sessionId`. For relay transport, `transportLabel` is `0x01` and the ID is the admitted route's session ID. A future encrypted direct transport uses label `0x02`: its initiator generates the ID and sends it in that transport's bounded setup message, and the responder uses the same value. The setup also identifies the claimed initiator so the responder can select an existing local pin. Setup fields are untrusted until Noise validates the expected peer and identical prologue. That future direct transport needs no relay or coordinator API. Its wire setup, protection against XX identity disclosure, and activation remain separate work, and current direct sync is unchanged.

Unknown labels are rejected. The suite and prologue have no negotiation or downgrade path. Changing a setup label or ID makes the handshake fail. The design adds no signing or key derivation beyond the library.

For relay sessions, the responder selects its expected peer from the initiator device ID in admission, mapped only through its existing local pin. A false initiator assertion cannot create a new trusted key. The responder must independently verify the initiator's admission proof before it sends its Noise identity payload. Gate `.1.4` owns that proof's target/session binding, freshness, replay controls, and permission checks.

An endpoint exposes the application stream only after its expected-peer handshake succeeds. It can then receive HTTP bytes for request authentication and scope validation. Before serializing outgoing memory, the sender checks current permission to emit it. Before serving or applying memory, the recipient completes the normal authenticated, scoped request checks. A Noise handshake can send public identity proof, but its payload cannot contain memory data. `validatedIdentity` does not grant scope access. Gate `.1.3` may define encrypted application versioning and framing, but it cannot add an authentication preface or cryptographic protocol.

## Authorization and HTTP compatibility

The [relay protocol](relay-protocol.md) specifies one HTTP exchange per fresh
Noise route, outer framing, per-exchange limits, and the shared dispatch seam.

The encrypted stream carries current HTTP/1.1 bytes in order. Relay requests require both the current v2 signature and a recipient-bound v3 signature. A relay path rejects v1, v2-only requests, a missing or mismatched recipient binding, and the direct listener's bootstrap-grant fallback. Scoped capability is mandatory before memory emission or apply.

Peer key, Identity, scope permission, membership, rate, body, operation, and cached-evidence checks remain in the shared authorization chain. The existing signed-request nonce store protects replay across direct and relay transport. Processing enforces signed-request freshness within plus or minus 300 seconds.

Relay dispatch takes the channel's authenticated Codemem device ID and exact pinned signing key as trusted inputs, not request headers. `X-Opencode-Device` must identify that same device, and both request signatures must verify under that same key. Reject any channel/signer mismatch before recording a nonce or using the request signer's grants. A fresh request captured from another device must not authorize work or a response over this channel, even if its signatures and recipient are otherwise valid.

Responses bind to the authenticated channel and their request association. A relay acknowledgement is never a cursor or apply acknowledgement. Existing direct behavior stays unchanged. Gate `.1.3` owns complete-response expiry, correlation, framing, and incomplete-EOF handling. Noise EOF does not prove that an HTTP response is complete.

## Relay admission and routing

Before sending device or target details, the client validates the configured WSS
origin and pinned relay service-key proof. The source obtains its own coordinator
decision before OPEN. Relay and responder each obtain their own decision.
ACCEPTED is only a routing signal. Neither endpoint treats a relay reply as
coordinator approval. The [admission contract](relay-admission.md) defines the
canonical formats, nonce consumption, expiry, and routing transport.

The [admission contract](relay-admission.md) binds verified device identity to each
socket and requires independent online coordinator checks for each route. Its
initiator proof also binds the exact first Noise wire message. A public-stream
gate can hold that opening message locally before OPEN and verify it at the
responder before handing any bytes to the Noise implementation. This adds no
second cryptographic handshake or key derivation.

The crypto library and service proof do not grant project access. A TLS-terminating proxy can forward a genuine service proof and observe outer metadata. The proposed v1 admission design accepts that trusted-frontend limit, subject to `.1.5` approval, and makes no channel-binding claim. The service pin does not protect against every frontend. Clients do not follow credential-bearing redirects or rotate the service pin silently.

Outer frames contain route identifiers, direction, ciphertext length, and ciphertext. They contain no plaintext HTTP bytes, raw scope IDs, request-signature headers, or private keys. Gate `.1.3` owns multiplexing, reassembly, and outer frame limits.

## Lifecycle and resource limits

| Event | Required behavior |
| --- | --- |
| Network handshake | Finish within 10 seconds of route acceptance. Locally held Message A preparation remains bounded by caller and admission deadlines. Handshake traffic is limited to 256 KiB in aggregate. |
| Record | The library uses a 2-byte big-endian record length. Ciphertext is at most 65,535 bytes and plaintext at most 65,519 bytes per record. |
| Live session | End at the first of 15 minutes, 1 GiB plaintext sent, or 1 GiB plaintext received at either endpoint. These are operational budgets, not advertised cipher limits. |
| Limit reached | Check the cap before further application bytes, close the stream, and discard a partial message. Existing cursor and idempotence behavior handles retry. |
| Disconnect or reconnect | Discard transport state and complete a fresh full handshake. |
| Trust or operator change | Close affected streams when revocation, key or Identity reassignment, or operator disablement is learned. |

The implementation accepts no 0-RTT, tickets, PSKs, team keys, resumption, stored handshake or cipher state, renegotiation, or in-place Noise rekey. Library nonces are never caller-set. Authentication error, nonce exhaustion, or corruption closes the channel without recovery from partially corrupted bytes.

Record authentication, ordering, and replay protection apply within a channel. A new handshake uses independent keys and rejects old ciphertext. Persistent HTTP nonces provide the cross-channel replay control.

No extra padding or compression is proposed. The relay can observe timing, ciphertext lengths, and peer relationships. An honest relay retains no payload or peer keys. A malicious relay can store ciphertext or delay and drop traffic. A compromised endpoint can expose live keys and authorized data. JavaScript disposal is best effort and does not promise physical memory zeroization.

## Processing order

1. Validate outer WSS origin and certificate. Verify the pinned service proof before sending device or target details.
2. Register the socket using its challenge-bound coordinator check.
3. Strictly decode the intended peer pin and derive its `PeerId`. The source creates one fresh factory and holds its opening message locally for admission binding.
4. The source obtains its own coordinator approval before OPEN. Relay and responder obtain independent approvals. Each uses its own HTTPS response and verifies the exact route, local identity, peer pin, and session association. No participant accepts a forwarded coordinator reply.
5. After ACCEPTED, the source releases the held opening message from that same factory. The responder verifies its bound hash before creating its one fresh factory. Complete the bounded XX handshake with the transport/session prologue and expected peer on each inbound or outbound call.
6. Compare the observed peer and key with the expected values. Reject any mismatch before application bytes.
7. For each request, recheck the channel's peer key, Identity, revocation, and negotiated scoped capability.
8. Enter the shared HTTP authorization chain. Require the signed device and verification key to match the trusted channel context before recording a nonce. Preserve the existing body, signature, timestamp, nonce, membership, scope, and operation checks around that additional condition.
9. Associate a complete response with its request. Apply data and acknowledge it only after existing cursor and apply checks succeed.

Any failure rejects or closes the attempt. Reclassifying that attempt as direct or legacy cannot bypass authorization checks. A later normal direct-sync attempt remains available under its own existing policy.

## Threat boundaries

| Threat | Protection | Remaining limit |
| --- | --- | --- |
| Malicious relay | Noise encrypts and authenticates inner bytes. | It can record ciphertext and metadata, delay, drop, and deny service. |
| Network attacker | WSS validates the outer route. Noise validates the expected peer and protects the inner stream. | Availability depends on the network and relay. |
| Key substitution | Strict pinned-key decoding and expected-peer validation run on both sides. | Policy compromise can affect authorization until a peer learns the change. |
| Unauthorized peer | Handshake identity, recipient v3, and scoped request checks all apply. | An authorized peer can read data allowed by its scope. |
| Identity or presence probing | The responder independently validates admission before sending its Noise identity payload. | XX sends responder identity in message B before authenticating the initiator. Gate `.1.4` must prevent unauthorized callers or a dishonest relay from turning that ordering into a presence oracle. |
| Compromised endpoint | Learned revocation and operator action stop later work. | It can reveal live keys and data already received. |
| Replay or corruption | Noise protects records. Persistent HTTP nonces protect signed requests across paths. | Complete-message and response rules remain `.1.3` work. |

## Evidence, alternatives, and open gates

### Isolated compatibility evidence

These tests used disposable keys and in-memory traffic. Counts are test evidence, not performance benchmarks, certification, or proof of full HTTP, backpressure, or production lifecycle behavior.

| Candidate | Evidence | Limit |
| --- | --- | --- |
| Noise | Nine tests covered Ed25519 import and signatures, inbound and outbound expected-peer mismatch rejection, segmented 150 KB and 170 KB HTTP-shaped payloads, tamper, truncation, cancellation, adapters, and strict factory types. | No production HTTP or backpressure integration. Truncation reached EOF without a distinct truncation error. |
| Server-authenticated TLS | Nine tests covered PKCS#8 import, certificate generation, TLS 1.3/ALPN, fresh sessions, payload transfer, validation rejection, cleanup, and handshake deadline behavior. | It remains a fallback, not the selected construction. |
| SSH | Five tests covered a restricted subsystem and rejection of mismatch and disallowed channel requests. | Separately generated OpenSSH keys passed. Existing PKCS#8 Ed25519 PEM and DER keys were unsupported. |

The Noise adapter experiment used 63 lines of public `MessageStream` adapters and a 28-line typed restricted factory. It confirms the narrow integration path. It does not approve a runtime integration.

TLS and SSH remain concise alternatives. TLS retains certificate provisioning and validation. SSH adds host-key handling and a key-format conversion boundary. HPKE alone does not meet the forward-secrecy requirement for this stream. Custom cryptography is excluded.

Dependency review remains open. Registry advisory checking covered the pinned installed production graph, including optional dependencies, on 2026-10-30. Source review and independent audit applicability remain incomplete. Snyk requires authentication. Advisory lookup does not certify the implementation or its dependencies.

### Gates before implementation

| Gate | Evidence required |
| --- | --- |
| `.1.3` framing | Reviewed route framing, correlation, complete-message and EOF rules, reassembly, and malformed-input tests. |
| `.1.4` admission | Reviewed service proof, admission encoding, route binding, nonce, expiry, and proxy/channel-binding decision. |
| `.1.5` architecture | Human approval for architecture, lifecycle, hibernation, operator control, and dogfood boundary. |
| `.1.7` operations | Reviewed rollout, disclosure, propagation, drain, kill-switch, and incident procedures. |
| Dependency review | Full dependency-tree and audit-applicability review for the pinned Noise package. |
| Key custody and reuse | Existing loader/keychain evidence and final security approval for Ed25519 identity-signature reuse. |
| Authorization and compatibility | Tests that direct behavior, shared authorization, nonce persistence, cursor behavior, and apply acknowledgements retain their current behavior. |

Task `.1.2` can close its design work after review. It does not create a runtime approval marker.

## Review invariants

- A relay route selects a peer connection and grants no peer, Identity, or scope authority.
- Outer WSS protects the relay route. Inner Noise protects peer sync bytes.
- The expected peer must validate during the Noise handshake, and current policy must validate before application work.
- No relay control message changes a trusted peer key, expected peer ID, or service pin.
- Every relay request has v2 authentication and recipient-bound v3 authentication.
- The HTTP signer and verification key match the channel's authenticated device and pin before nonce recording or scope authorization.
- Noise protects one channel. Persistent nonces protect signed requests across channels and transports.
- A response is usable only with its authenticated channel and request association.
- Changed trust, scope, or operator state stops later application work.

## Required negative cases

The compatibility experiment does not cover every case below. These are objective requirements for later integration tests:

- A transport-label, session-ID, or version mismatch fails the Noise handshake.
- Old-channel ciphertext fails on a new channel, and replaying a record within a channel exposes no duplicate application record.
- Replaying an accepted signed request across direct and relay channels fails the shared nonce check.
- A captured, fresh request from another trusted device fails the channel/signer check before nonce insertion or response dispatch.
- A false admission initiator, wrong pin, or invalid identity signature fails before application-stream exposure. A relay responder sends no identity payload without the required admission proof. Future direct transport must separately resolve identity disclosure before activation.
- Handshake time or byte-budget exhaustion closes the attempt. Session time or plaintext-budget exhaustion admits no bytes past the cap.
- Truncated messages, late responses, and transport acknowledgements alone neither complete an HTTP exchange nor advance a cursor.
- Enabling process debug or session-key-dump settings still emits no static, ephemeral, or cipher-state keys through either logger.

## References

- [ADR 0004](../adr/0004-authenticated-identity-and-live-relay-boundaries.md) and [ADR 0005](../adr/0005-authenticated-identity-device-and-membership-lifecycle.md)
- [The Noise Protocol Framework](https://noiseprotocol.org/noise.html)
- [Pinned libp2p Noise source](https://github.com/libp2p/js-libp2p/tree/d41cc9fdd9b92596246deba0d4b8ad0078adfc69/packages/connection-encrypter-noise/src), including [`decodeHandshakePayload`](https://github.com/libp2p/js-libp2p/blob/d41cc9fdd9b92596246deba0d4b8ad0078adfc69/packages/connection-encrypter-noise/src/utils.ts)
- [`sync-auth.ts`](../../packages/core/src/sync-auth.ts), [`sync-identity.ts`](../../packages/core/src/sync-identity.ts), [`sync-fingerprint.ts`](../../packages/core/src/sync-fingerprint.ts), and [`sync-scope-protocol.ts`](../../packages/core/src/sync-scope-protocol.ts)
- [`sync-http-client.ts`](../../packages/core/src/sync-http-client.ts), [`sync-pass.ts`](../../packages/core/src/sync-pass.ts), [`routes/sync.ts`](../../packages/viewer-server/src/routes/sync.ts), and [`scope-membership-cache.ts`](../../packages/core/src/scope-membership-cache.ts)
