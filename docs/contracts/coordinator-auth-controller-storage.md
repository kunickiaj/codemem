# Coordinator auth controller-attestation storage contract

**Status:** Reviewed persistence slice; no runtime authorization integration

## Purpose and boundary

This contract defines durable controller-attestation records used by the reviewed
[coordinator auth protocol](coordinator-auth-protocol.md). It does **not** enable
active authentication, an admin route, account-link attempts or sessions, or any
runtime authorization.

The future caller must already authenticate a configured coordinator admin and
review legacy ownership. This store records the review's labels and receipt; it
does not verify a credential, signature, or other cryptographic proof itself.

## Creation input and record

`createAuthControllerAttestation` uses these fields from trusted internal input:

```ts
createAuthControllerAttestation({
  attestationId, coordinatorId, identityId, groupId, deviceId,
  publicKey, fingerprint, reviewReceiptId, evidenceDigest,
});
```

The immutable revision-1 record stores those values using snake-case field names,
`created_at`, and a nullable `revoked_at`. Its read-only `enrollment_identity_id` stores the
enrollment's `identity_id` snapshot; a null snapshot is valid.

`identityId` is the reviewed actor, not a caller assertion. A non-null
legacy enrollment `identity_id` must match it. A null value records that the
reviewed admin supplied the actor without rewriting the enrollment. That legacy
column alone is never trusted authority.

## Creation and retry rules

- The table is additive and begins empty. Do not backfill enrollment rows as
  trusted evidence.
- It does not create or reassign actors, device keys, groups, permissions, or
  enrollment ownership. It stores no Google tokens.
- Uniqueness includes revoked records: per coordinator, `attestationId`,
  `(groupId, deviceId, fingerprint)`, and `reviewReceiptId` are each unique.
  Coordinator namespaces are independent.
- An exact retry returns the existing row only when every live guard still
  matches. A different target for any unique value is denied.
- Revision 1 is immutable. A revoked row or review receipt cannot be revived or
  replaced through retry.

## Active lookup

`getActiveAuthControllerAttestation` returns a record only when it matches the
exact coordinator, live group, enrollment key, and fingerprint; the enrollment
is enabled; its identity is null or matches the attested actor; and the group is
not archived. Otherwise it returns `null`.

Removing or rekeying the enrollment, disabling it, or archiving the group makes
the lookup return `null`. Restoring the same key can make it active again unless
the attestation was explicitly revoked. This slice has no monotonic enrollment
revision.
Clearing a formerly matching enrollment Identity to null does not revoke the
reviewed authority; the stored Identity snapshot records history, not an additional
authorization condition. A different non-null Identity still denies active lookup.

Revocation never resurrects a row or receipt through retry. It does not
implicitly revoke the device or sync access.
`revokeAuthControllerAttestation` is idempotent: it returns true if the scoped
row exists, including an already-revoked row, and preserves the original timestamp.
When a live enrollment no longer matches, creation/retry reports
`enrollment_mismatch` before inspecting conflicting or revoked receipts.

## Storage implementation

The implementation belongs in these direct source paths:

- `packages/core/src/coordinator-auth-controller.ts`
- `packages/core/src/better-sqlite-coordinator-store.ts`
- `packages/core/src/d1-coordinator-store.ts`
- `packages/cloudflare-coordinator-worker/migrations/0016_add_auth_controller_attestations.sql`

D1 uses one guarded `INSERT`; SQLite uses an immediate transaction. Neither
backend may treat a check-then-write sequence as authority. Migration 0016 is
source and test input only; it is not applied to a live deployment by this slice.
The fresh-install `schema.sql` includes the same table as migration 0016.
In D1, a post-insert read failure or changed enrollment can leave the durable
review receipt in place. A missing active read-back throws
`auth_controller_persistence_incomplete`; it is not a clean rejection. An exact
retry recovers a still-active row, and restoring the original key can reactivate
it. If that review is unwanted, explicitly revoke it rather than assuming the
failed response undid the write. Later binding transactions must recheck live authority.

## Deferred work

Account-link-attempt persistence is a separate, unreviewed candidate documented
in [the link-attempt storage contract](coordinator-auth-link-storage.md).
Browser sessions, routes, and active authentication remain deferred until their
integration tests pass.
