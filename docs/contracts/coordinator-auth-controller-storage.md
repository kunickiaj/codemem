# Coordinator auth controller-attestation storage contract

**Status:** Reviewed persistence slice with a source-ready, explicitly configured
admin-review route. Publishing, live provider setup, and account-link activation
remain separate approvals.

## Purpose and boundary

This contract defines durable controller-attestation records used by the reviewed
[coordinator auth protocol](coordinator-auth-protocol.md). A configured
coordinator can expose the narrow ownership-review route below. The record does
**not** enable account-link attempts or sessions, Google, relay, enrollment, or
runtime access changes.

The caller must already authenticate a configured coordinator admin and review
existing ownership. This store records the review's labels and receipt; it does
not create a second admin authority or verify device-signature proof.

## Configured admin-review route

The source implementation registers `POST /v1/admin/auth-controller-reviews`
only when optional auth configuration is enabled. Disabled setups leave the
route absent (`404`); an explicitly unavailable setup returns fixed `503`.
The route requires the existing configured admin credential in
`X-Codemem-Coordinator-Admin`, verified with a constant-time digest/HMAC check.
It accepts no caller-nominated admin actor proof.

Request bodies are capped at 4 KiB, reject unknown fields, and use exactly this
preview schema:

```json
{
  "group_id": "team-alpha",
  "device_id": "device-example",
  "identity_id": "actor-example",
  "fingerprint": "<64-lowercase-hex>"
}
```

Adding `confirm_evidence_digest` with the preview's 64-character digest requests
the write. Without it, the route only returns `ready` or `needs_review` and no
record is created. Confirmation recomputes evidence from the live group,
enrollment key and fingerprint, selected Identity, and sorted consumed verified
Team/add-device invitations. A changed digest returns `409 review_stale`.

Unavailable groups or enrollments, disabled or archived state, key mismatch, or
Identity mismatches return a `needs_review` preview. A consumed, unrevoked
Team/add-device invitation bound to this exact key with missing or malformed
review evidence also stops the review; it is not silently ignored.
Existing conflicting or
revoked attestations return `409 already_reviewed_or_needs_review`; exact replay
of the same live review returns the existing record. Responses are `no-store`.

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

## Storage implementation and deployment

The implementation belongs in these direct source paths:

- `packages/core/src/coordinator-auth-controller.ts`
- `packages/core/src/better-sqlite-coordinator-store.ts`
- `packages/core/src/d1-coordinator-store.ts`
- `packages/cloudflare-coordinator-worker/migrations/0016_add_auth_controller_attestations.sql`

D1 uses one guarded `INSERT`; SQLite uses an immediate transaction. Neither
backend may treat a check-then-write sequence as authority. Migration 0016 is
source and test input only; it is not applied to a live deployment by this slice.
The fresh-install `schema.sql` includes the same table as migration 0016. Source
and tests are ready for the configured route, but this contract does not claim
that a live schema or operator configuration has been applied.
In D1, a post-insert read failure or changed enrollment can leave the durable
review receipt in place. A missing active read-back throws
`auth_controller_persistence_incomplete`; it is not a clean rejection. An exact
retry recovers a still-active row, and restoring the original key can reactivate
it. If that review is unwanted, explicitly revoke it rather than assuming the
failed response undid the write. Later binding transactions must recheck live authority.

## Deferred work

Account-link-attempt persistence is a separate, unreviewed candidate documented
in [the link-attempt storage contract](coordinator-auth-link-storage.md).
Browser sessions, live account-link route activation, and provider setup remain
deferred despite the controller-review route's source and test coverage.
