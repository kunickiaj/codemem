# Manual ownership resolution API

The recovery API creates new local copies when historical source ownership cannot be proved, including when the original device is unavailable.
It preserves the originals and never grants authority to retire their identities.
This prerequisite supplies tested core functions and an HTTP route factory; the route factory is deliberately not mounted in the production viewer until the dependent repair stack is enabled.

## UI contract

The **Resolve ownership** action takes selected memory IDs through evidence inspection, preview, and confirmed recovery.
Mount `memoryOwnershipRoutes(storeFactory)` behind the existing viewer local-request and mutation protections when enabling the finished workflow; do not expose it through the peer sync server.
All endpoints use POST and JSON under `/api/memories/ownership/`.

| Endpoint | Request | Outcome |
| --- | --- | --- |
| `verify` | `{version: 1, memoryIds: [1, 2]}` | Returns stored evidence status for each readable record and the recovery action. This checks existing immutable bindings; it does not authenticate a submitted ownership claim. |
| `preview` | Same selection | Returns normalized `request`, `reviewedDigest`, `records`, `copyCount`, `retainedOriginalCount`, and explicit `effects`. |
| `commit` | Normalized request plus `reviewedDigest`, `operationId`, `acknowledgeOriginalsRetained: true` | Atomically creates copies and returns their IDs, new identities, and durable retry receipt. |

Selections contain at most 100 positive safe-integer IDs; duplicates are normalized.
Generate an operation ID once per confirmation, using 16–128 ASCII letters, digits, underscores, or hyphens, and retain it across timeout/restart retries.
Changing the selection requires a new preview and operation ID.

Each preview record includes its title, original identity, `verification`, `verifiedSourceDeviceId`, exact `missingEvidence`, source scope, original and recovered visibility, destination scope, recipient device IDs, and `originalRetained`.
Unverified UUIDs report `immutable_source_binding` as missing evidence and offer the working `recover_local_copy` action regardless of source availability.
Existing verified bindings report `verified`; caller-supplied device IDs, signatures, and mutable origin fields cannot create that status.

## Consequences and authorization

Recovery copies initially use `local-default`, which the current peer export and snapshot paths exclude; their recipient list is empty.
The preview must say **Create local copies**, **Originals remain**, and **Duplicates will be visible**, rather than promising remote erasure or completed Project convergence.
The later repository repair must separately preview and apply the main Project policy before sharing eligible copies.

Copies preserve private restrictions, and personal/private indicators in historical metadata or scope conservatively produce private copies.
The preview exposes any resulting visibility change explicitly; this never broadens access.
Private/personal records require the current actor and existing local ownership checks; other records require current scope-read access, including peer-owned shared records that the user can already read.

Copied metadata marks `recovered_copy` and nests historical metadata under `recovery.original_metadata`, so historical claims do not become the new copy's authority.
Original rows and their signed material stay untouched.
New source bindings prove only who created the recovered copy, not who created its historical original.

## Retry and failure handling

Commit acquires an immediate SQLite transaction, rechecks access and identity, and rejects changed content or evidence with `ownership_preview_stale`.
Copies, source bindings, new sessions, and the receipt commit together; a failed write rolls them all back.
No network call occurs inside this transaction.

A matching retry returns the original receipt with `idempotent: true`, after checking current access to the original selection.
It does not recreate copies that were subsequently removed, and operation-ID reuse with another request returns `ownership_recovery_operation_conflict`.
HTTP errors return `{error, nextAction}` with a 400, 403, 404, or 409 status.

| Error | UI action |
| --- | --- |
| `ownership_preview_stale` | Refresh the preview and ask the user to confirm the new effects. |
| `ownership_identity_changed` | Reload the current local identity before previewing again; recovery requires an initialized durable device identity. |
| `ownership_sync_reset_pending` | Complete the existing sync-reset workflow before recovery. |
| `ownership_private_record_not_owned` / `ownership_records_unavailable` | Refresh the selection and remove records the current user cannot recover. |
| `ownership_privacy_evidence_invalid` | Inspect the selected record's malformed metadata before retrying. |
| `ownership_recovery_operation_conflict` | Start a fresh preview with a new operation ID. |

These APIs resolve unavailable-source recovery without pretending to verify historical ownership.
Production UI activation, authenticated source-proof exchange, retirement replay, transport admission, and applying main Project policy remain dependent stack work.
