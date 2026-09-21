# Retirement-aware snapshot reset

This internal prerequisite replays authenticated retirement history before a direct-source snapshot and prevents known retired identities from reappearing through either bootstrap mode.
It does not advertise `memory_scope_retirement_v1`, mount its reserved signed paths, or activate repository repair.
Cross-process admission remains required before production activation.

## Reset handshake

The receiver starts with `beginRetirementReset`, which persists a random reset ID, the pinned source device and public key, the local recipient, and a digest of the exact snapshot boundary.
The boundary includes scope, generation, snapshot ID, and baseline content cursor; that cursor never determines which retirement controls replay.
The caller must obtain `options.peer` from `getRetirementPeer(db, { localDeviceId, peerDeviceId })` and use the actual local device identity.

Begin, serve, receive and protected-apply entry points independently check that supplied peer/key against `getRetirementPeer`; an unknown, inconsistent or replaced pin fails with `retirement_peer_untrusted` before state changes.
This lookup retains retirement-only authority after final coordinator-scope revocation on either side; it does not restore scope membership or content authentication through `sync_peers`.
Snapshot content still requires its own currently authorized authenticated transport to the same source; retirement-only pins cannot authorize fetching content after revocation.

The recipient signs each request for `POST /v1/memory-scope-retirements/reset` using recipient-bound v3 authentication.
`serveRetirementReset` verifies it and snapshots the recipient's complete retained delivery manifest, including already acknowledged controls, into durable reset storage.
The manifest is scoped to the authenticated recipient and actual local source, never to a recipient or source claimed in the body.

The source signs each returned page for `POST /v1/memory-scope-retirements/reset/page` addressed to the receiver.
`receiveRetirementResetPage` verifies the pinned source/key, recipient, random challenge, boundary and page offset, then atomically commits the controls, cleanup, receipts, nonce and reset checkpoint.
These paths are signature domains for internal adapters, not mounted server endpoints.

Cleanup removes every row matching the exact retired identity and scope, including duplicate snapshot imports and each copy's file/concept references and vectors; destination-scope copies and unrelated rows remain intact.

Pages contain at most 100 payload-free controls and a signed completion flag.
The source manifest is immutable for that reset attempt, bounded to 100,000 controls, and retained through restart and log compaction.
New controls queued after manifest capture remain in normal durable delivery state; the admission dependency must coordinate that boundary before content can ship.

## Apply and retry contract

The caller uses `retirementResetProgress` to resume the same reset after restart, signing fresh requests from its saved offset until completion.
A duplicate final received page is idempotent; lost responses can be requested again from the durable source manifest.
Reset replay never clears or rewinds normal delivery acknowledgements, so a delayed live acknowledgement cannot skip reset controls.

Only after completion may the caller invoke `applyRetirementProtectedSnapshot` with the matching reset ID, pinned source and exact snapshot boundary.
The wrapper supports `replace` and `merge`, checks readiness inside its transaction, and records immutable source bindings for qualified identities independently of mutable origin metadata.
It requires direct-source items: a relayed identity needs a separate reset and snapshot from its independently pinned original source, while an unqualified historical UUID returns `memory_source_verification_required` for the explicit ownership-recovery workflow.

Caller-owned outer transactions are rejected by reset entry points so returned progress cannot describe an uncommitted outer transaction.
An import failure leaves received controls and completion durable for retry, but rolls back new snapshot rows, bindings and content cursor changes together.
Every page fetched by `fetchAllSnapshotPages` must match the requested generation, snapshot ID and baseline; mixed or stale boundaries fail before returning content.

## Snapshot enforcement

Both existing bootstrap modes consult retirement history inside their write transaction, before inserting or comparing a candidate row's clock.
For an identity with retirement history, missing/blank payload scope, a retired scope, or contradictory metadata scope is filtered; a payload contradicting the requested scope rejects the snapshot.
Valid unretired destinations and unrelated identities retain their existing behavior.

Snapshot export applies the same history-aware filter and continues scanning past filtered rows.
Destructive and additive bootstrap preserve source bindings, retirement fences, retirement-only peer pins, delivery acknowledgements, receipts, source manifests and receiver checkpoints; none of these tables is content-cursor or memory-row state.
The low-level bootstrap functions enforce already-known fences but do not perform control exchange: any future negotiated retirement caller must use the protected handshake and wrapper.

## Remaining admission gate

The completed handshake covers the manifest captured by its source transaction, not controls created after that transaction or bytes already selected by another process.
The admission unit must bind control-manifest capture and snapshot/content selection to its cross-process admission barrier, deliver later controls or restart the boundary as needed, and drain admitted old bytes before claiming convergence.
Offline peers, missing original sources, multi-source orchestration and the explicit manual recovery UI must retain actionable pending states; no local reset receipt proves remote physical erasure.
