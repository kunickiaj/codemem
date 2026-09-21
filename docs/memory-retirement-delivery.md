# Durable retirement control delivery

This internal prerequisite delivers source-authenticated retirement controls independently of memory operations and their cursors.
It recognizes `memory_scope_retirement_v1` separately from `reassign_scope`, but does not advertise it, mount HTTP routes, or run it from the sync loop.
Snapshot/reset enforcement and cross-process export admission must land before production activation.

## Source and recipient contract

`queueMemoryRetirement` records a qualified-source retirement and its former recipients inside the caller's move transaction.
Recipients come only from the retired scope's stored membership rows, including revoked rows; destination memberships are never consulted.
The caller must enqueue before deleting historical membership evidence, and must provide the actual local device identity.

`pendingRetirementBatch` returns at most 100 unacknowledged controls for one recipient and the local source.
Each control contains only a deterministic control ID, source-qualified memory identity, source device ID, and retired scope ID.
No content, destination, grants, or other recipients travel with the control.

The reserved signed POST paths are `/v1/memory-scope-retirements` and `/v1/memory-scope-retirements/ack`.
They define signature domains for the internal transport adapter; neither is a mounted server endpoint.
The feature must be explicitly negotiated, and unsupported peers leave all deliveries pending even if their content cursor advances.

## Authentication and atomic acknowledgement

`receiveRetirementBatch` requires a recipient-bound v3 signature verified with the peer's independently pinned public key.
The caller obtains `RetirementPeer` from `getRetirementPeer(db, { localDeviceId, peerDeviceId })` in `memory-retirement-trust.ts`, never from body fields; signatures authenticate the complete body and recipient.
The authenticated peer must own every control's qualified namespace, so forwarded claims and unverified historical UUIDs fail.

The receiver commits the ledger fence, cleanup of every row matching the exact identity/retired scope (including duplicate copies), file/concept references, vectors when present, receipt, and nonce in one transaction.
Failure to delete any copy rolls back the entire batch, including earlier controls and the nonce, so the same signed request can retry without acknowledging partial cleanup.
A moved destination row and unrelated rows survive; an absent row still gains an authenticated fence.
An acknowledgement is returned only after commit, and caller-owned outer transactions are rejected to prevent acknowledging uncommitted state.

`replayMemoryRetirements` calls the injected transport outside a SQLite writer transaction and verifies the recipient's signed acknowledgement.
The acknowledgement contains a digest of the exact batch, including its recipient; a wrong peer or changed batch cannot advance delivery state.
All per-control acknowledgements and the acknowledgement nonce commit atomically, without changing content cursors.

## Retirement-only pairing retention

Final coordinator-scope revocation preserves the independently pinned peer key before deleting content trust.
`revokeUnauthorizedCoordinatorPeerTrust` copies the matching public key and fingerprint into `memory_retirement_peer_trust` in the same immediate transaction as deleting `sync_peers`.
Each database retains its own local-device/peer binding: the receiver needs the source key for controls, and the sender needs the recipient key for acknowledgements and reset requests.

Retention does not depend on a queued control or active membership, so a source can enqueue after revocation using the stored former membership rows.
The lookup prefers the retained binding, otherwise uses the current independently pinned `sync_peers` binding, and returns `null` for unknown, incomplete, or inconsistent keys.
The first retained binding wins; subsequent discovery or re-pairing does not silently replace historical authority. Key replacement requires a separate explicit recovery design.

This lookup authorizes only the payload-free retirement protocol; normal sync authentication continues to require `sync_peers`, and scope authorization continues to require active memberships.
No retained pin restores content access, accepts a key carried by a packet, or changes namespace ownership checks.
Already-deleted keys cannot be reconstructed from a device ID or membership row; those cases fail closed rather than trusting discovery after revocation.

## Retry and retention

Delivery rows, receipts, and fences survive memory deletion and content-log compaction.
Retirement pins also survive acknowledgement and compaction; do not prune them when a queue becomes empty, because offline reset replay and later retirement may still need them.
Pending polling uses the peer/source/acknowledgement/control index to skip retained acknowledged history while returning controls in stable order.
If a response is lost, the source sends the same controls with a fresh signed nonce; the receiver repeats narrow cleanup and returns the same batch digest.
Identical controls are idempotent, while reuse of a request nonce fails.

An acknowledgement means the receiver committed a fence and removed the matching current materialized row and indexes.
It does not claim physical erasure of backups or historical signed log material, remote admission/drain completion, or cleanup by offline peers.
Peers that later upgrade replay their retained pending controls; historical UUIDs continue through the explicit ownership-recovery workflow rather than being blessed by a claimed source.

## Remaining activation work

The [snapshot/reset prerequisite](memory-retirement-reset.md) preserves fences and control state, filters both import modes, and supplies an authenticated replay handshake for already acknowledged controls.
It preserves `memory_retirement_peer_trust` and requires the caller-pinned `options.peer` from `getRetirementPeer` on both sides of reset/replay, using the actual local device identity.
A content cursor reset alone still cannot recover control state; negotiated callers must use the protected reset entry point.

The admission unit must coordinate already-selected content across processes before any repair caller or advertised capability activates this protocol.
