# Coordinator D1 free-tier optimization

## Context

The Cloudflare coordinator's recent D1 usage can exceed the Free plan's daily row-read allowance. The dominant avoidable traffic comes from coordinator status refreshes: the browser refreshes local UI data every five seconds, and the server currently treats each refresh as permission to repeat remote peer and reciprocal-approval queries.

Authenticated coordinator calls also maintain replay-protection nonces. Reducing those calls lowers both nonce writes and the reads caused by nonce cleanup without changing the security model.

## Decision

Keep the five-second local UI refresh, but reuse each remote coordinator peer and approval snapshot for up to 30 seconds. A snapshot expires sooner at its earliest discovered peer presence expiry so cached availability and addresses cannot outlive coordinator presence. Local presence continues to refresh independently on its existing schedule, including while the peer and approval snapshot remains cached.

Successful reciprocal-approval mutations invalidate the affected status snapshot. Invalidation increments a per-cache-key generation so a status request that started before the mutation cannot repopulate the cache after it finishes. The next refresh must observe the post-action coordinator state instead of reusing a pre-action snapshot, including after a page reload or in another browser.

Final reciprocal approval carries the group and incoming request ID that the user reviewed. The coordinator completes that exact pending reverse request atomically. If it has disappeared, changed direction, changed group, or already completed, the mutation returns HTTP 409 with `reciprocal_approval_request_changed`; it never silently approves a replacement request. That conflict also invalidates the local status cache so the requested refresh can expose the replacement immediately. Omitting the precondition preserves first-side request creation.

This first optimization deliberately does not change nonce retention or add indexes. The smaller change should reduce the principal source of traffic by roughly five-sixths while minimizing operational and security risk.

## Approval feedback

A longer remote refresh window must not make a successful approval appear lost or invite duplicate submission.

When the cached snapshot said this device still needed to approve and the coordinator accepts that final local approval, the UI will:

1. Immediately announce: **Approval sent for this device. This screen may take up to 30 seconds to confirm two-way trust.**
2. Keep the device row visible with an **Approval sent** badge.
3. Explain: **Waiting for refreshed coordinator status. You do not need to approve again.**
4. Remove the approval button while confirmation is pending.
5. Clear the pending state when the next complete coordinator snapshot no longer contains the exact incoming reciprocal request that was reviewed. This confirms that request is no longer pending; a replacement request is shown as new work rather than inheriting the old success state.

When this device initiates the first side of reciprocal approval, cache invalidation makes the next refresh expose the coordinator's outgoing pending request. That flow does not use the final-approval marker because its pre-action snapshot did not require local approval.

Submission failures remain warnings with a retry action. Existing inline feedback already uses an accessible polite status announcement for successful actions and an assertive alert for failures.

## Data flow

The pending approval is global optimistic UI state keyed by device ID. Component-local state is insufficient because the sync panel is remounted during refresh. Each marker also records the coordinator URL and incoming reciprocal request ID so that a replacement request or coordinator context cannot inherit a prior device's successful state. The request ID is preserved when coordinator diagnostics are redacted, unlike the device fingerprint, so the normal privacy-preserving UI can still approve and track the exact request safely.

The marker is created only after the approval request succeeds and before optional rename or screen-refresh work. Normal sync-data refreshes reconcile that state against coordinator device data before payload-hash short-circuiting:

- matching device and incoming reciprocal request: retain the pending state because the snapshot may still be cached.
- the reviewed incoming request no longer appears in a complete snapshot: remove the pending state because that exact request is no longer pending.
- the device is absent from the snapshot: retain the pending state rather than claiming success from incomplete data.
- peer lookup or reciprocal-approval data is incomplete: retain the pending state and do not cache the partial coordinator snapshot.
- the device ID appears with a different incoming reciprocal request: clear the success marker and require fresh review rather than applying approval feedback to a replacement request.
- the configured coordinator URL no longer matches the reviewed context: clear the marker so it cannot suppress a legitimate approval in another coordinator context.

The pending marker affects presentation only. Coordinator responses remain authoritative for trust and sync authorization.

The submission announcement uses the existing polite live status region once. The persistent badge and explanation are ordinary row content so routine refreshes do not repeatedly announce them. Pending rows remain visible but do not count as actionable work.

## Alternatives considered

### Change nonce cleanup now

Running nonce cleanup less frequently could further reduce reads, but it changes security-adjacent retention behavior. It is unnecessary until the lower-risk polling change is measured.

### Add a combined coordinator status endpoint

Combining peer and approval responses would reduce calls further, but requires a protocol change and coordinated rollout. Current usage does not justify that complexity.

### Hide the row after submission

This would feel fast but could falsely imply that both devices have observed the approval. Keeping a clear pending state is more accurate.

## Validation and rollout

Tests will cover the 30-second cache boundary, optimistic pending presentation, duplicate-action suppression, and reconciliation after a fresh coordinator snapshot. Normal TypeScript, lint, and workspace test gates must pass.

After deployment, compare seven complete UTC days of D1 row reads and writes with the pre-change baseline. Consider nonce-cleanup optimization only if reads remain materially close to the Free limit.
