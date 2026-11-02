# Peer traversal signal codec

**Status:** Implemented format contract. This module encodes and decodes bounded
signal bodies and portable packet envelopes. It does not send requests, verify
signatures, authorize peers, check freshness, or bind a packet chain.

## Canonical body bytes

A `TraversalSignalBody` encodes as a bare UTF-8 JSON array using `JSON.stringify`.
Decoding accepts bytes only when parsing the array and stringifying it again produces the
same bytes. This gives later hashing and authentication code one unambiguous raw
byte sequence. The codec neither hashes those bytes nor defines an HTTP endpoint.

All arrays begin with these common indices:

| Index | Field | Format rule |
| ---: | --- | --- |
| 0 | purpose | Exact phase purpose below. |
| 1 | authority ID | 64 lowercase hexadecimal characters. |
| 2 | group ID | 1–128 UTF-8 bytes, equal to its trimmed form, with no ASCII control character, DEL, or unpaired surrogate. |
| 3 | source device ID | 1–64 visible ASCII characters. |
| 4 | source key ID | 64 lowercase hexadecimal characters. |
| 5 | target device ID | 1–64 visible ASCII characters and different from the source device ID. |
| 6 | target key ID | 64 lowercase hexadecimal characters. |
| 7 | session ID | 32 lowercase hexadecimal characters. |
| 8 | Message A digest | 64 lowercase hexadecimal characters. |
| 9 | created at | Non-negative safe integer seconds, safely convertible to milliseconds. |
| 10 | admit before | Safe integer equal to `createdAt + 30`, safely convertible to milliseconds. |
| 11 | attempt not after | Positive safe integer seconds, safely convertible to milliseconds. `PREPARE` requires `createdAt + 55`. |

Later phases carry their supplied `attemptNotAfter` value. The codec does not
replace it or compare it with an earlier packet because it cannot bind a chain.

| Phase | Purpose at index 0 | Suffix fields | Fields | Body cap |
| --- | --- | --- | ---: | ---: |
| `prepare` | `codemem-traversal-webrtc-prepare-v1` | — | 12 | 1,024 B |
| `offer` | `codemem-traversal-webrtc-offer-v1` | `prepareDigest`, description | 14 | 24,576 B |
| `offer-check` | `codemem-traversal-webrtc-offer-check-v1` | `prepareDigest`, `offerDigest` | 14 | 1,024 B |
| `answer` | `codemem-traversal-webrtc-answer-v1` | `prepareDigest`, `offerDigest`, description | 15 | 24,576 B |
| `answer-check` | `codemem-traversal-webrtc-answer-check-v1` | `prepareDigest`, `offerDigest`, `answerDigest` | 15 | 1,024 B |

Suffix digests are 64 lowercase hexadecimal characters. A description is
canonical unpadded base64url that decodes to 1–16,384 UTF-8 bytes with no NUL.
The codec validates UTF-8 but does not parse SDP or normalize it. It preserves the
raw bytes, including a permitted BOM.

## Packet envelope

`TraversalSignalPacket` is a portable object with exactly these four keys:

```json
{"body":"base64url(raw-array-bytes)","timestamp":"createdAt","nonce":"…","signature":"v2:…"}
```

`body` is canonical unpadded base64url for the original array bytes. `timestamp`
must equal `String(createdAt)`. `nonce` is exactly 32 lowercase hexadecimal
characters. `signature` has syntax `v2:` followed by standard padded base64 that
decodes to exactly 64 bytes. These are format checks only, not signature checks.

When a caller uses the body as a POST entity, it must use the raw decoded array
bytes, not JSON reconstructed from the decoded value. The module exposes the path
suffix `/v1/traversal/signal`, but implements no HTTP client or server.

## Codec API and verifier boundary

The source exports four operations:

- `encodeTraversalSignalBody` and `decodeTraversalSignalBody` for canonical body bytes.
- `encodeTraversalSignalPacket` and `decodeTraversalSignalPacket` for the portable envelope.

Packet decoding returns typed fields and independent raw body/signature byte copies.
A future verifier is responsible for signatures, authority, timestamps and other
freshness checks, nonce replay, packet-digest and session-chain binding. Its
expected signer mapping is source for `prepare`, `offer`, and `answer-check`, and
target for `offer-check` and `answer`.

The codec has no candidate-address classification or safety rules. It also does
not implement RTC, an SDK integration, database or schema changes, migrations,
activation, or a public index export.
