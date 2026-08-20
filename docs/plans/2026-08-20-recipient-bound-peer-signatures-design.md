# Recipient-bound peer signatures

**Date:** 2026-08-20
**Status:** Approved

## Decision

Direct-peer sync adds recipient-bound signature v3. It is additive: legacy v2 bytes stay unchanged, while upgraded direct peers send v3 and remember that a peer has done so. A later v2-only request from that peer is rejected.

This fixes a verified replay threat: a valid v2 request proves who signed it, but not which peer it was intended for. An attacker able to redirect or replay that signed material to another trusted peer can reuse it within the timestamp/nonce window. Recipient binding makes that request invalid at every other peer.

## Alternatives

| Option | Result |
| --- | --- |
| Flag day | Require v3 everywhere immediately. Simple end state, but breaks mixed-version direct-peer sync. |
| **Dual additive rollout (selected)** | Keep v2 intact; add v3 for direct peers; lock each peer to v3 after first valid v3 request. Preserves rollout compatibility without allowing silent downgrade after upgrade. |

Mutual TLS was not selected for this change. It could provide channel confidentiality and mutual identity, but it would also add certificate issuance, trust distribution, address continuity, rotation, and recovery. Recipient binding fixes the verified request-level replay flaw without requiring that larger transport migration.

## Wire contract

### Existing v2 (unchanged)

Direct peers and coordinators retain the existing headers:

```http
X-Opencode-Device: sender-device-id
X-Opencode-Timestamp: unix-seconds
X-Opencode-Nonce: random-hex
X-Opencode-Signature: v2:base64-ed25519-signature
```

The signed UTF-8 bytes remain exactly these five newline-separated fields:

```text
METHOD
path-and-query
timestamp
nonce
sha256(body-bytes)
```

### Direct-peer v3

An upgraded direct-peer request preserves the legacy v2 signature and adds the intended stable device identity plus a separate v3 signature:

```http
X-Codemem-Recipient: target-device-id
X-Codemem-Signature: v3:base64-ed25519-signature
```

Its canonical UTF-8 bytes are the v2 five fields followed by the recipient ID:

```text
METHOD
path-and-query
timestamp
nonce
sha256(body-bytes)
target-device-id
```

The recipient header is part of the signed value, not a routing hint. Verification uses the sender device's pinned Ed25519 public key; a v3 signature is valid only for the exact recipient ID in its canonical bytes. Legacy servers ignore the additive Codemem headers and continue verifying `X-Opencode-Signature: v2:...`.

## Direct-peer flow

1. The client obtains the target's stable device ID from the selected/pinned peer and signs every direct request as v3.
2. This covers status, ops pull and push, scoped ops, snapshot/bootstrap, probes, and sync-pass propagation.
3. An upgraded server that receives v3 material verifies it and compares its signed recipient with its own stable `sync_device` ID. It never falls back to the accompanying v2 signature when v3 material is present but invalid.
4. Only after a match does it record the nonce, advance the peer's observed signature version, and execute route behavior.

Bootstrap-grant authorization follows the same recipient and version rules for the endpoints that permit bootstrap grants. It does not create a bypass for recipient binding.

## Sticky anti-downgrade state

Each direct peer has a persistent, monotonic `highest_observed_direct_signature_version` value.

| Current state | Valid v2 | Valid v3 | Invalid or recipient mismatch |
| --- | --- | --- | --- |
| No v3 observed | Accept during migration | Accept; persist v3 | Reject; do not mutate state |
| v3 observed | Reject as downgrade | Accept; remain v3 | Reject; do not mutate state |

The field is additive and nullable. Fresh databases include it; existing databases receive an idempotent compatibility repair, including databases whose schema-compatibility marker was already set. There is no schema-version bump or destructive migration. A write may increase the value but never lower it.

## Failure and privacy behavior

| Condition | Wire response | State effect |
| --- | --- | --- |
| Valid v3 for another recipient | `401 unauthorized`; server diagnostic `recipient_mismatch` | No nonce or version update |
| Valid v2 after v3 was observed | `401 unauthorized`; server diagnostic `signature_downgrade` | No version downgrade |
| Invalid v3, missing required v3 material, unknown sender, stale timestamp, or replayed nonce | Generic unauthorized response | No version update |

Detailed signature and grant diagnostics remain server-side. The wire response for invalid authentication is intentionally generic so it does not disclose key, grant, peer, or verification details. Existing rate, size, nonce, capability, and authorization checks remain in force.

## Coordinator and Cloudflare invariance

Recipient v3 is direct-peer-only. Coordinator clients keep their existing v1/v2 auth behavior and never send `X-Codemem-Recipient` or `X-Codemem-Signature`. Node and Cloudflare coordinator verifiers retain their existing canonical bytes and continue rejecting a v3 value supplied in the coordinator's `X-Opencode-Signature` header. The coordinator remains discovery and authorization metadata infrastructure, not a memory payload path.

## Migration and deprecation

Mixed direct-peer fleets work during the transition: a peer without recorded v3 support may use valid v2. Upgraded clients emit v3 whenever they know the target device ID; upgraded servers permanently reject v2 from a peer once that peer has demonstrated v3.

V2 is deprecated for direct-peer traffic, not removed in this change. Removal requires a separately approved protocol transition after supported peers have migrated; unsupported older peers must then fail closed rather than silently receive a weaker path. Coordinator v2 is unaffected by that deprecation.

## Delivery split

1. **PR 1 — primitives and invariance:** this decision document; isolated v3 canonical/sign/verify helpers; immutable v2 fixtures; Node and Cloudflare coordinator invariance tests. No direct-peer call-site, enforcement, schema, or coordinator production behavior changes.
2. **PR 2 — propagation and enforcement:** recipient identity propagation; additive persistence; server-side recipient and downgrade enforcement; replay regressions; end-to-end coverage.

## Tests

- Fixture-test v2 canonical bytes and headers byte-for-byte.
- Prove v3 accepts only the signed recipient.
- Assert v3 headers on every direct route family: status, ops, scoped ops, snapshot/bootstrap, probes, and CLI bootstrap.
- Replay an unchanged request for recipient A against recipient B on status, ops, and snapshot; each must fail before nonce/version mutation.
- Prove valid v2 remains transitional before v3 observation and fails after it.
- Prove coordinator Node and Cloudflare paths retain v2 behavior and reject v3.
- Run focused core, server, and Worker tests, followed by type checking, linting, and the workspace suite.

## Out of scope

- Relay transport or relay approval.
- Transport/channel confidentiality.
- TLS or mutual TLS deployment, certificate lifecycle, or peer address trust.
