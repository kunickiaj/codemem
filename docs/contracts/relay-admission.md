# Relay admission

**Status:** Reviewed design for `codemem-zjvr.1.4`. Related suffixes such as `.1.5` refer to `codemem-zjvr.1.5`. That decision approves local disabled-by-default implementation with disposable keys/databases. Hosted execution, real-device use, dogfooding, activation, deployment, and runtime configuration changes remain separately gated.

## Purpose and boundary

Relay admission requires three online coordinator decisions for one named route:
one each for the source, relay, and responder. Each obtains its own HTTPS reply.
Neither endpoint accepts a coordinator response forwarded by the relay.

This is coordinator-backed relay v1. Coordinatorless relay admission is unsupported. Coordinator outage prevents new relay routes. Existing direct, LAN, peer, and cross-group behavior remains unchanged.

The design uses online checks instead of signed eligibility tickets. The current coordinator has no portable authority-response issuer key, certificate, or ticket format. Relay service-key pins and existing peer pins remain required. A response is local to one HTTPS request and is never portable authority.

Admission checks enrollment eligibility. It does not prove physical presence, grant Project access, create peer trust, or replace current scope and request authorization. Existing automatic peer trust remains stricter: matching authority and discovery group plus fresh managed evidence are required. A reply never creates trust on first use.

| Term | Meaning |
| --- | --- |
| Source | Endpoint opening the route and Noise XX initiator. |
| Responder | Named target endpoint and Noise XX responder. |
| Authority ID | SHA-256 identifier for the configured coordinator URL. It is not a key pin. |
| Relay audience ID | SHA-256 identifier for one configured relay service and its pinned key. |
| Route session ID | Fresh 16-byte route ID, encoded as 32 lowercase hexadecimal characters. |
| Role packet | Exact UTF-8 JSON request body signed by the source for one admission role. |
| Socket challenge ID | Fresh 128-bit challenge that the relay binds to one actual WSS socket. |

Fresh IDs and nonces use a cryptographically secure random generator. Counters,
timestamps, and restored pending challenges are not substitutes.

## Trust and configuration

The client canonicalizes its configured coordinator base URL at startup with a WHATWG HTTPS URL. It rejects userinfo, query, and fragment. The canonical value is origin plus path with trailing slashes removed.

```text
authorityId = SHA-256(UTF8(canonicalCoordinatorBaseUrl))
```

The coordinator maps an authority ID to its own explicitly configured trusted public base URL. It never uses an incoming `Host` header, packet URL, or redirect to select a destination. Each request uses that configured HTTPS URL directly. Normal CA and hostname validation apply, including the operator's trusted TLS terminator assumptions. Coordinator responses have no portable end-to-end protection beyond that HTTPS connection.

```text
relayAudienceId = SHA-256(
  UTF8("codemem-relay-audience-v1") || 0x00 ||
  UTF8(canonicalConfiguredRelayOrigin) || 0x00 || UTF8(relayServiceKeyId)
)
```

The coordinator has an allowlist of relay audience IDs. These are service audiences, not a second device-enrollment store. Missing relay-audience configuration disables only the new admission operation. Other coordinator operations remain available.

The client verifies the relay service-key pin before it sends device or target details and on each endpoint's own WSS connection. Rotation is an explicit out-of-band configuration change. Admission replies and service proofs cannot install a new key.
Service-key IDs use the same canonical Ed25519 key-identity rule as device keys.

## Service proof before OPEN

The client creates a fresh 128-bit service challenge ID, holds it as its current pending ID, and sends `SERVICE_CHALLENGE` with that ID in `session`. Its body contains only `audienceId`, with no route, source, target, or identity data. The relay returns `SERVICE_PROOF` for this exact UTF-8 array:

```json
["codemem-relay-service-v1", "audienceId", "challengeId", "issuedAt", "expiresAt"]
```

The relay signs the UTF-8 `JSON.stringify` array with its configured Ed25519 service key. The proof body is exactly `{keyId, issuedAt, expiresAt, signature}`. `signature` is canonical ordinary Base64 for 64 Ed25519 bytes, without the HTTP `v2:` prefix. `keyId` must match the already configured service pin. `issuedAt` and `expiresAt` are safe integer Unix seconds with `0 < expiresAt - issuedAt <= 30`. Field-name strings in the example denote placeholders, not accepted timestamp values. The client compares its own audience and pending challenge, verifies the signature, and consumes the challenge once before five seconds elapse from nonce generation on its local monotonic clock, or before an earlier caller deadline.

Challenge freshness uses the client-generated nonce and monotonic timeout rather than the relay wall clock. The proposed v1 accepts that an owned, configured HTTPS frontend can forward a valid proof and observe outer metadata. The proof does not hide metadata or provide channel binding. Noise protects inner payload bytes and does not provide anonymity. This trust limit is subject to `.1.5` human approval.
The challenge body is exactly `{audienceId}`. The client starts registration or
on-demand renewal with a new service challenge, verifies the proof, and only then
accepts the relay's socket challenge. These connection controls cannot select a
route or target.

Service proof authenticates the relay to the client. It does not authenticate a target socket to the relay. The relay must complete socket registration before it can route an OPEN to that target.

## Socket registration

After the client verifies service proof, the relay sends `SOCKET_CHALLENGE` with a fresh 128-bit `socketChallengeId` in `session` and an empty body. The challenge is tied only to that actual WSS socket, expires after 30 monotonic seconds, and can be consumed once. It is not a route ID or a target claim. The client builds its own registration packet from the service-verified challenge. It must not sign a caller-supplied challenge for another socket through an arbitrary API.

The registration packet is a normal v2 request for the future `POST /v1/relay/admission-check` endpoint, with a distinct nonce and this exact UTF-8 `JSON.stringify` array of nine fields:

```json
["codemem-relay-register-v1", "authorityId", "groupId", "deviceId", "keyId", "relayAudienceId", "socketChallengeId", 0, 0]
```

| Index | Field | Rule |
| --- | --- | --- |
| 0 | Purpose | Exact string `codemem-relay-register-v1`. |
| 1 | Authority ID | 64 lowercase hexadecimal characters. |
| 2 | Group ID | Valid Unicode scalars, 1–128 UTF-8 bytes, with no C0, DEL, or leading/trailing whitespace. |
| 3 | Device ID | HTTP-header-byte-string safe visible ASCII (`0x21`–`0x7E`), 1–64 bytes. |
| 4 | Key ID | Canonical Ed25519 key ID, 64 lowercase hexadecimal characters. |
| 5 | Relay audience ID | 64 lowercase hexadecimal characters. |
| 6 | Socket challenge ID | Exact fresh 128-bit relay challenge for this socket, encoded as 32 lowercase hexadecimal characters. |
| 7 | Created at | Safe integer Unix seconds. |
| 8 | Admit before | Exact `createdAt + 30` seconds. |

The relay structurally validates the v2 syntax, checks that the source device header equals `deviceId`, and checks that the packet's challenge belongs to the actual socket. It cannot cryptographically verify an unknown client key from a key ID alone. It forwards the exact packet over its own configured HTTPS coordinator connection and trusts only that response for signature and current-key verification. The coordinator verifies the signature under a captured enrollment key. Its final atomic nonce insertion pins that exact current tuple and checks enabled enrollment, unarchived group, global device and key revocations, configured authority and audience, and the admission window. Registration uses the same strict created-at, clock-lead, encoding, and header rules as route packets, with one enrollment tuple and no target or route deadline. This remains a distinct future endpoint purpose and version.

The bounded registration reply is at most 1,024 bytes. It contains `v: 1`, `registered: true`, `role: "registration"`, `packetDigest: SHA-256(exact raw registration body)`, the request nonce, device ID, key ID, `decidedAtMs`, the readiness stamp defined below, and positive `remainingMs` no greater than 900,000. The decision time is UTC milliseconds from the final conditional decision. The relay maps `remainingMs` to its local HTTPS request-start monotonic time and matches every field to its actual HTTPS request and socket challenge. Only after that match may it create an immutable routing mapping of `(device, realm, keyId, connectionId)`. The opaque realm derives from the configured authority and group. Device ID to socket mapping never comes from an unsigned claim, a header, or a relay control field. The holder of the current source key therefore proves a registration that is bound to one challenged connection, while the relay still owns its network routing decision. Registration is not a route permit.

`REGISTER` controls contain the raw unpadded canonical base64url registration body, timestamp, nonce, and ordinary-Base64 v2 signature. The raw body is at most 1,024 bytes, and the complete control is at most 4 KiB. It contains no key material, payload, or scope. `REGISTERED` confirms only that the socket is routable for its immutable mapping. Registration creates no route, local peer pin, permanent enrollment, or authorization to exchange data.
The v1 coordinator registration grant is exactly 900,000 ms. Receivers require
that value in the successful coordinator reply. Other grant durations fail v1
validation. Mapping to request-start time,
transport delay, and conservative recovery can reduce locally usable time.

The REGISTER body has exactly the packet fields `body`, `timestamp`, `nonce`, and
`signature`, with the same encodings as an OPEN check packet. REGISTERED echoes
the socket challenge ID. Its body has exactly `deviceId`, `keyId`, `authorityId`,
`realmId`, and `remainingMs`, with values from the verified mapping and a positive
remaining duration of at most 900,000 ms. Renewal retains the
physical connection ID but uses a new one-time challenge and coordinator check.

Registration expires after at most 15 minutes. Renewal needs a fresh socket challenge, a new v2 packet, and a current online check. On expiry, the relay stops new OPEN and target lookup. It may retain the WSS connection in an unregistered state and permits only bounded renewal/service controls and terminal route CLOSE. Established routes may still carry bytes within their original remaining lease unless they learn a revocation, key or Identity change, or operator disablement. Renewal cannot revive or extend a route. The operations contract bounds pending and closing sockets and replacement replays.
Failed service proof or registration, including failed renewal, invalidates the
connection's application state and closes the socket generically. It exposes no
participant-specific cause. Existing routes can therefore end earlier than their
maximum lease. Pending physical closure remains charged to socket quotas.

A current-key registration may atomically replace old sockets for the same device and realm when capacity permits. The relay closes old routes and never transfers Noise state, route IDs, or sessions. The fresh socket challenge prevents reuse of a stolen registration packet on another socket. A dishonest relay can lie about socket mapping and deny service, but Noise pinning still prevents it from authenticating as the target.

Reconnects require a fresh service challenge, service proof, socket challenge, registration nonce, and coordinator response. The relay never restores a prior positive registration response. Hibernation metadata may restore only an unexpired validated registration bound to the same healthy WSS socket. Missing metadata fails closed.

The parent `.1.3` protocol update must add `SERVICE_CHALLENGE`, `SERVICE_PROOF`, `SOCKET_CHALLENGE`, `REGISTER`, and `REGISTERED` as connection controls separate from existing route controls. Their initial connection correlation uses the fresh 32-lowercase-hex challenge ID in `session`, never a routable route ID. A connection-control session is in the challenge namespace and cannot carry route DATA. Route DATA requires separately authenticated OPEN admission.

## Admission operation

The future coordinator operation is `POST /v1/relay/admission-check`. It is not present today. It uses normal device v2 HTTP request authentication. It requires no account cookie, administrator secret, OIDC credential, or new service-auth registry.
The path is relative to the configured coordinator base. Append it to that base
and sign the actual external path, including any configured base-path prefix,
with no query. Both forwarders derive the same destination from their own trusted
configuration and preserve the source's signed method and path. A deployment
must not silently strip or rewrite the signed path.

The source prepares three packets with the same route context and distinct
nonces. It first submits its `source` packet directly to the configured
coordinator and verifies its own response. Only then does it send OPEN with the
two forwarded packets, `relay` and `responder`. Its local positive reply and
deadline are not taken from ACCEPTED or any relay report. Otherwise a dishonest
relay and revoked target could both pretend that admission succeeded.
Capture one immutable context for all three packets and the Noise factory.
Changes to the peer, realm, audience, keys, session, or deadlines abort that
attempt. Do not refresh selected fields between the source check and OPEN.

Each packet is a normal v2 request for this exact operation. Holding a forwarded
packet delegates one exact operation and can burn its nonce. That is an
availability risk, and the relay can already drop a route. A role describes
intended use. It does not authenticate the forwarding relay as an identity.

| Packet | Signed source | HTTPS caller | Required result |
| --- | --- | --- | --- |
| `source` | Source device | Source device | The source's own coordinator request succeeds before OPEN. This packet stays local. |
| `relay` | Source device | Relay | The relay's own coordinator request succeeds. |
| `responder` | Source device | Responder | The responder's own coordinator request succeeds. |

There is no coordinator request per ciphertext frame and no reusable route-renewal permission.

The operations budget is one online check per WSS registration or renewal and
three online checks per HTTP exchange. The source's check is not sent through
the relay. The forwarded role is not the caller's network identity at the
coordinator. The relay's challenge check on the actual socket and its own
coordinator response bind a delegated source packet to that connection.

Before a new route, source and target must have current registrations in the same explicit authority, discovery group, and derived realm. The OPEN source ID, key ID, authority, group, and audience must match the immutable registration of the actual opening socket. The target ID and key must match the selected target registration. ACCEPTED and later frames must arrive on those exact bound sockets. A registered third device cannot submit another device's captured OPEN credentials as its own source. Route admission remains mandatory after registration.
Source and target device IDs and their physical WSS sockets must be distinct.
Self-routing is unsupported in v1 because the bound sockets determine direction.

Define `realmId` as SHA-256 of UTF-8 `JSON.stringify(["codemem-relay-realm-v1", authorityId, groupId])`. It is routing metadata, not permission. The server assigns a configured namespace/shard before accepting the WSS connection. Registration must match that namespace and cannot move the socket to another realm. An expired registration may retain only the immutable identity needed by already admitted routes until their deadlines.

### Exact role body

Each role packet body is the exact UTF-8 output of `JSON.stringify` over this fixed-order array. It has exactly 14 elements, indexed 0 through 13.

```json
["codemem-relay-admission-check-v1", "relay", "authorityId", "groupId", "sourceDeviceId", "sourceKeyId", "targetDeviceId", "targetKeyId", "relayAudienceId", "routeSessionId", "messageADigest", 0, 0, 0]
```

| Index | Field | Rule |
| --- | --- | --- |
| 0 | Purpose | Exact string `codemem-relay-admission-check-v1`. |
| 1 | Role | Exact `source`, `relay`, or `responder`. OPEN permits only the latter two. |
| 2 | Authority ID | 64 lowercase hexadecimal characters. |
| 3 | Group ID | Valid Unicode scalars, 1–128 UTF-8 bytes, with no C0, DEL, or leading/trailing whitespace. |
| 4 | Source device ID | HTTP-header-byte-string safe visible ASCII (`0x21`–`0x7E`), 1–64 bytes. |
| 5 | Source key ID | Canonical Ed25519 key ID, 64 lowercase hexadecimal characters. |
| 6 | Target device ID | HTTP-header-byte-string safe visible ASCII (`0x21`–`0x7E`), 1–64 bytes. |
| 7 | Target key ID | Canonical Ed25519 key ID, 64 lowercase hexadecimal characters. |
| 8 | Relay audience ID | 64 lowercase hexadecimal characters. |
| 9 | Route session ID | 32 lowercase hexadecimal characters. |
| 10 | Message A digest | 64 lowercase hexadecimal characters. |
| 11 | Created at | Safe integer Unix seconds. |
| 12 | Admit before | `createdAt + 30`. |
| 13 | Route not after | `createdAt + 55`. |

`sourceKeyId` and `targetKeyId` use the existing canonical Ed25519 key identity: SHA-256 of the strict SSH wire blob containing `ssh-ed25519` and its exact 32-byte public key. They do not hash SPKI or SSH text. See [Canonical coordinator device-key identity](coordinator-ed25519-key-identity.md).

All fields are exact and receive no semantic Unicode normalization. Group IDs allow the defined Unicode scalars within their byte cap. Device IDs use the visible-ASCII rule because they also appear in HTTP headers. The v1 restriction supports generated UUID and hexadecimal IDs. Legacy longer or nonconforming device IDs cannot use relay admission, while direct behavior remains unchanged. A body must be valid UTF-8, at most 1,024 bytes, and the source's fixed-array `JSON.stringify` output. It rejects non-integer values, unsafe integers, extra elements, control characters, and lone UTF-16 surrogates. Format validation requires UTF-8 `JSON.stringify(parsedArray)` to equal the received bytes exactly, rejecting alternate numeric or escape representations. Hashing, signature verification, and forwarding always use the original received bytes. Reserialization must never replace them. Quotes and backslashes in the allowed device-ID range can at most double their JSON encoding, and the existing 3,069-byte size test remains conservative.

The HTTP `X-Opencode-Device` value must equal `sourceDeviceId`. Its timestamp is the canonical decimal rendering of `createdAt`. All three packets have distinct random 32-hex-character nonces and the same timestamp. The signature uses the existing v2 form from `sync-auth.ts`: `v2:` followed by the ordinary Base64 encoding of the 64-byte Ed25519 signature. The suffix must pass canonical decode-and-reencode validation and be exactly 88 characters, making the complete header value 91 characters. Registration uses this same strict v2 encoding and canonical timestamp. V1 is forbidden for this operation. The stricter encoding applies only to this new operation; existing coordinator APIs retain their current version behavior.

### OPEN envelope

```json
{"v":1,"type":"OPEN","session":"0123456789abcdef0123456789abcdef","body":{"checks":[{"body":"<base64url exact UTF-8 relay body>","timestamp":"<createdAt decimal>","nonce":"<32 lowercase hex>","signature":"v2:<signature>"},{"body":"<base64url exact UTF-8 responder body>","timestamp":"<createdAt decimal>","nonce":"<32 lowercase hex>","signature":"v2:<signature>"}]}}
```

The source sends the two exact forwarded packets only after service proof and its own coordinator check succeed. `checks` has exactly two items, ordered `relay` then `responder`. `body` uses unpadded canonical base64url for the exact raw UTF-8 body and must pass decode-and-reencode validation. The envelope includes no URL, key material, scope, private payload, or extra fields. Its 4 KiB control cap and each raw 1,024-byte body cap apply independently. A dedicated schema sanity test measured 3,069 encoded bytes for escaped 128-byte group and 64-byte device IDs, 64-hex digests, 13-digit timestamps, and both signatures. The final ten-digit Unix-second schema is smaller. This measures the schema, not the runtime protocol.

## Coordinator verification and atomic decision

The coordinator verifies each packet's normal v2 signature over the exact raw body, method, path, timestamp, nonce, and body digest. Current `authorizeRequest` consumes a nonce after checking only the requester. It cannot admit this paired operation as written. The future operation must split shared signature verification from nonce commitment.

Before asynchronous key-ID hashing, SQLite and D1 capture source and target enrollment tuples. The final atomic pair decision conditionally inserts the request nonce and verifies every predicate below.

| Predicate | Required state |
| --- | --- |
| Authority and audience | Body values equal trusted configuration and the audience is allowlisted. |
| Source and target | Exact current device IDs, public keys, and canonical key IDs match the body. |
| Enrollment | Both devices are enabled in the same explicit authority and discovery group. |
| Group | The discovery group is unarchived. |
| Revocation | Neither device ID nor either canonical key ID is globally revoked. |
| Time | Exact intervals hold and the route deadline is still allowed. |
| Nonce | This `(sourceDeviceId, nonce)` has no durable prior record. |

The current `request_nonces` uniqueness model remains the durable replay ledger. The role nonces must differ. A successful decision exists only when this invocation inserted its nonce. A zero-row insert, backend fault, or incomplete result is a denial. SQLite and D1 need parity tests for capture, hashing, pair predicates, nonce races, and uncertain outcomes.
Expiry predicates and `decidedAtMs` use the time of the final conditional store
decision, not a timestamp captured before asynchronous verification or hashing.
The same decision checks the current authoritative admission-policy revision,
enabled audience, and fresh ready health record. A stale startup allowlist or
relay-cached flag cannot override a committed disablement. These policy and
readiness predicates are new coordinator-owned metadata, not Project grants.
The coordinator's dedicated admission-budget authorizer covers registration and
all three roles, including the direct source check. It reserves service/realm
capacity before enrollment lookups and verified-device capacity after signature
verification. It never spends the presence or membership endpoint's generic
authenticated POST bucket. Unknown budget state denies the operation. The
operations contract defines units, durable allocation, renewal limits, and
health publication; none of those hooks exists in the current coordinator API.

Initial eligibility is narrower than broad coordinator discovery: explicit coordinator authority and discovery group must match. A discovery group is not a Project grant. Admission does not rewrite manual direct relationships or cross-group policy.

Failures return one generic denial. They do not reveal the participant, group, revocation, configuration, deadline, or online condition that caused it. The operation sends no success unless this invocation's nonce insertion succeeded.

## Time and lease policy

`createdAt`, `admitBefore`, and `routeNotAfter` use integer Unix seconds.
`createdAt` is from 0 through 9,999,999,999. The final conditional decision uses
UTC milliseconds, `decisionNowMs`, rounded toward the future if its clock has
sub-millisecond precision. It never floors the clock to seconds for these rules.
The reported `decidedAtMs` equals that decision timestamp. Clock-error bounds
include resolution and rounding error in the published millisecond reading.

| Condition | Required value |
| --- | --- |
| Source clock lead | `createdAt * 1000 <= decisionNowMs + 5000`. |
| Admission window | `decisionNowMs < admitBefore * 1000`. |
| Fixed interval | `admitBefore = createdAt + 30`; `routeNotAfter = createdAt + 55`. |
| Route deadline | `0 < routeNotAfter * 1000 - decisionNowMs <= 60000`. |
| Response lease | `remainingMs = routeNotAfter * 1000 - decisionNowMs`, a positive safe integer at most 60,000. |

The existing 300-second HTTP signature-freshness window does not widen these intervals. Invalid time predicates deny the request rather than clamping an invalid context into a grant. Callers verify the exact remaining-time formula using `decidedAtMs`, then map it to their own monotonic request-start time, not response-receipt time. They use the earlier of that deadline-derived budget, the caller deadline, and route caps. A delayed reply cannot extend a lease. No relay wall-clock value is trusted. Registration uses the same millisecond decision timestamp and strict admission-window comparison, with its separate maximum registration duration.

Operations evidence must show every coordinator backend clock remains within five seconds of UTC. The difference between two backend decisions can therefore reach ten seconds. The conservative upper bound on residual route acceptance or sending is 70 seconds from a successful authority decision, or a later disablement that follows it. Each verifier maps its own HTTPS reply's `remainingMs` to request-start monotonic time and never relies on a forwarded relay timestamp. The nominal route window is 55 seconds before setup overhead and may be shorter under caller or route caps. Clock uncertainty fails closed under `.1.7` policy.

Queued packets and handler work that already committed cannot be recalled. Endpoints drop late HTTP after the route deadline. An admitted route may finish its unextended remaining lease during an outage unless it learns a revocation, key or Identity change, or operator disablement. A learned change closes affected routes. The design makes no 24-hour permission claim.

## Response contract

Each actual independent HTTPS request returns at most 1,024 bytes. A positive route response has this exact association shape:

```json
{"v":1,"eligible":true,"role":"relay","packetDigest":"<sha256 raw body>","requestNonce":"<nonce>","decidedAtMs":0,"routeNotAfter":0,"remainingMs":0,"health":{"revision":1,"state":"ready","observedAtMs":0,"validUntilMs":0}}
```

The caller requires the exact version, `eligible: true`, role, SHA-256 of its raw role body, request nonce, safe integer decision time, echoed deadline, and bounded remaining lease. Source and responder each accept only their own HTTPS response, even if the relay or opposite endpoint claims approval. Neither installs a pin from a response. Every negative response is generic `eligible: false`; it need not echo a malformed parsed body or IDs. Timeout, malformed body, stale fields, and mismatched association deny the route without revealing a specific cause.
Zeros above are schema placeholders. Positive replies require an unexpired,
consistent budget and the fresh coordinator-owned readiness stamp. Its revision
is a nonnegative safe integer and its state is `ready`. Both times are safe
integer UTC milliseconds. Require `validUntilMs = observedAtMs + 50000`,
`observedAtMs <= decidedAtMs + 10000`, and `validUntilMs > decidedAtMs`. The
operations contract defines the observer, publication, clock guard, and freshness.
A readiness stamp forwarded by the relay is not
evidence for either endpoint.

## Noise Message A guard

The selected Noise XX wire has a local expected first message: exactly 34 bytes, `u16BE(32) || ephemeralKey[32]`, with zero payload. After the route ID is known, the initiator creates a fresh factory and prologue and captures Message A through a public `MessageStream` wrapper before OPEN. It binds `messageADigest = SHA-256(exact 34 bytes)` into all three packets.

The source verifies its own coordinator decision before OPEN and sends no Noise
wire bytes before ACCEPTED. The relay obtains its independent decision before
target presence lookup or forwarding OPEN. All route and responder denials use
the same REJECTED body. Timing differences within an authorized named attempt
remain observable; the protocol offers no timing anonymity or roster query.
The responder strictly verifies its
canonical v2 role packet and common fields in both forwarded packets under the
pinned source key, gets its own coordinator success, and consumes its route
reservation. It sends ACCEPTED, then holds the first 34 incoming Noise bytes.
It compares the digest before passing A to Noise. A mismatch sends no Message B
or public identity material.

The responder independently requires the packet target device and key ID to
equal its own runtime identity and key. The source device and key must equal its
existing local peer pin. Authority, group, realm, audience, and session must match
its own configuration, service-verified connection, and this OPEN. Both role
packets must agree on every common field, and the outer session must equal the
signed session. A valid check for target B forwarded to target C is rejected
before any Noise response, even if both targets share a coordinator group.
The source likewise constructs packets only from its own identity and the
intended target's existing pin. Neither endpoint substitutes relay assertions
for these comparisons.

The opening-prefix gate requires the fixed 34 bytes and `u16BE(32)`. Unexpected length, extra bytes already buffered before prefix approval, truncation, cancellation, or version mismatch fails closed. Later bytes undergo normal Noise checks. The gate cannot predict malformed bytes that arrive after Message B has already been sent. It adds no Noise decryptor, general record parser, custom Diffie-Hellman code, or library fork.

### Isolated feasibility evidence

An isolated opening-message prototype passed 12 new tests on Node 24.22.2. The new module typechecked and passed syntax checks. It captured the exact 34-byte source Message A, emitted no wire bytes before approval, and used real Ed25519 canonical HTTP proofs that bound the Message A hash, session, source, and target. The target checked the actual incoming prefix before invoking Noise.

The prototype rejected a Message A from another legitimate factory, corruption, truncation, bad lengths, and extra early data. Each rejection produced zero target handshakes, Message B wire bytes, and application dispatches. One approved path completed a handshake and carried an HTTP-shaped payload.

This is isolated feasibility evidence. It does not validate the final role-packet wire format, clock bounds, durable nonce ledger, online coordinator decisions, the production TypeScript profile, or relay integration. The experiment needed ES2024 declarations for `Promise.withResolvers`. The repository also currently targets ES2024, but its stricter project settings still require separate production validation. The existing nine Noise tests and shared modules were unchanged and were not rerun. Integration evidence remains required.

Local Message A preparation may happen before `ACCEPTED`, while network transmission may not. The ten-second network-handshake timer starts at route acceptance. Local preparation remains bounded by the caller and admission deadlines. The first-message gate is specific to the pinned library and suite. It checks a fixed opening prefix and does not implement a general Noise record parser.

## Replay, restart, and retained state

All three role packets are single-use through the durable nonce ledger. A nonce replay is never retry success. If an HTTP outcome is unknown after nonce insertion, the caller discards the route, factory, Message A, and packets, then starts again with fresh values. A restart retains the ledger. It does not cache a positive decision or restore an old reply as route permission.

If backup restoration leaves stale policy or nonce storage, relay admission stays disabled until an operator completes authoritative reconciliation and a full acceptance window passes. A simple TTL cannot repair lost revocations. Hibernated route metadata may retain only the remaining, unextended deadline under the operations contract. It cannot reuse packets as new permission.

## Required tests and gates

| Area | Required evidence |
| --- | --- |
| Wire validation | Fixed array count/order, exact bytes, UTF-8, size, Unicode, hex, key-ID, interval, and OPEN-cap rejection cases. |
| Signature and replay | V2-only exact-body verification, header match, distinct nonces, durable replay rejection, and unknown-outcome restart. |
| Atomic eligibility | SQLite and D1 parity for pairs, group/archive state, revocations, authority, audience, expiry, and concurrent change. |
| Response handling | Exact packet binding, responder-owned HTTPS request, generic denials, delayed budget, and no pin installation. |
| Independent source check | Source rejects a disabled target or coordinator outage despite a dishonest relay and target both claiming ACCEPTED. |
| Service proof | Pin, audience, fresh challenge, integer bounds, one-time use, monotonic deadline, and forwarding-metadata limit. |
| Socket registration | Unsigned-claim rejection, actual-socket challenge binding, exact registration schema, nonce replay, expiry, renewal, bounded pending and closing sockets, replacement replay limits, route closure, and hibernation loss. |
| Noise guard | Integration coverage for captured Message A, no pre-ACCEPTED wire, substitution rejection before Message B, and early-byte failures. |
| Endpoint binding | Wrong local target, source pin, realm, audience, group, session, or disagreement between role packets fails before a Noise response. |
| Compatibility | Direct, LAN, peer, cross-group, manual trust, discovery, scope, request authorization, and coordinator APIs retain current behavior. |

`.1.4` design closure requires review of this design. The matrix defines evidence required by later implementation and integration work; it does not claim that all production tests have run. `.1.5` human approval must approve implementation architecture and lifecycle boundaries. `.1.7` must approve clock health, disablement, propagation, hibernation, incidents, rollout, dogfood, and deployment evidence. This design changes no authentication or secret configuration.

## References

- [Relay protocol](relay-protocol.md) and [Encrypted peer stream over a live relay](relay-encrypted-peer-stream.md).
- [Canonical coordinator device-key identity](coordinator-ed25519-key-identity.md) and [Coordinator device-revocation admission](coordinator-device-revocations.md).
- [ADR 0004](../adr/0004-authenticated-identity-and-live-relay-boundaries.md), which keeps coordinator enrollment separate from Project access.
- `packages/core/src/coordinator-api.ts`, `authorizeRequest` lines 331–416 and peer discovery lines 591–603.
- `packages/cloudflare-coordinator-worker/src/request-verifier.ts`, canonical request and v1/v2 verification lines 66–124.
- `packages/core/src/better-sqlite-coordinator-store.ts` and `packages/core/src/d1-coordinator-store.ts`, current peer-tuple capture and final reads.

## Review boundaries

The isolated prototype shows that the Message A boundary is feasible. Relay integration must still prove the same boundary under the selected library, lifecycle, and production TypeScript profile. The final role-packet wire format, replay ledger, clock bounds, online coordinator checks, and operations limits remain implementation and integration gates rather than undecided design choices.
