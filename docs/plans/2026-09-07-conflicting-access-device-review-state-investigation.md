# Conflicting access and device-review state investigation

The reported contradictions are presentation defects over valid, intentionally separate backend states; neither case indicates corrupt access data or an unsafe pairing path.

## Decision

This investigation changes no policy or copy because the follow-up information-architecture work must decide how to present these state distinctions.

- Treat active Team intent separately from per-Project enforcement convergence.
- Treat an expired coordinator presence as offline and ineligible for review.
- Preserve the existing fail-closed checks for stale device pairing.
- Use the focused UI fixtures below as characterization tests until replacement copy and state ownership are approved.

## Evidence matrix

The matrix maps each visible message to the state that produces it and the operation it actually describes.

| Visible message | Endpoint and source field | Backend derivation | Freshness rule | Affected operation | Finding |
|---|---|---|---|---|---|
| Advanced: “Team access needs review before it can continue.” | `GET /api/sync/status`; `recipient_policy_reconciliation.items[].state` | `listRecipientPolicyReconciliationStatus()` maps a non-waiting safe error or rolled-back authority to `needs_attention` for one canonical Project. | No age threshold; this is persisted Project authority state. | Per-Project recipient-policy reconciliation and authority cutover. | Presentation defect: valid Project enforcement failure is summarized as broad Team access state. |
| Advanced: “Open Sharing, review Project access, then sync again.” | Same reconciliation item and derived primary status. | `deriveTeamSyncPrimaryStatus()` routes reconciliation-only failures to Sharing without exposing the affected Project or safe reason. | No freshness rule. | Review the failed Project access update. | Presentation defect: Sharing does not render reconciliation state, so the destination cannot explain the warning. |
| Sharing: active members, registered devices, and shared Project identities | `GET /api/sync/recipient-policy/v1/intent`; active `teams`, `teamMemberships`, `identityDevices`, and `projectRecipients` rows | `listRecipientPolicyIntent()` projects the intent graph; the Team renderer filters and counts active rows independently of enforcement authority. | No presence threshold; a failed refresh can retain the last successful intent with stale-data disclosure. | Manage declared Team membership and Project-recipient intent. | Intentional state distinction presented without enough context. Active intent can coexist with failed Project enforcement. |
| Attention: “{device} is available to review.” | `GET /api/sync/status`; unpaired `coordinator.discovered_devices[]` with `stale: true` | `deriveSyncViewModel()` creates a generic `review-team-device` attention item for a stale unpaired discovery. | A discovery is stale when expiry is missing, invalid, or not later than the current time. | The action only focuses the device row. | Presentation defect: the generic title claims review is available when the row rejects review. |
| Device row: “Offline”, “No fresh addresses”, and fresh-presence recovery guidance | Same discovered device; `stale`, `addresses`, `address_count`, and `expires_at` | Coordinator projections retain enrolled offline devices, strip stale addresses, and the UI sets the row to stale mode without a pairing button. | Presence defaults to a 180-second lifetime. Status caching does not extend a fresh record beyond its expiry. | `POST /api/sync/peers/accept-discovered`. | Correct stale-state handling. Enrollment remains visible, but pairing is unavailable. |
| Pairing error: `discovered_peer_stale` | `POST /api/sync/peers/accept-discovered`; current coordinator peer record | The handler reloads coordinator state and rejects stale or expired presence before inserting a peer or reciprocal approval. | Revalidated against the operation-time clock. | Trust and pair the discovered device. | Correct fail-closed behavior. |

## Trace: active Team intent with failed Project enforcement

The contradiction combines two valid projections but labels the narrower failure too broadly.

1. `packages/viewer-server/src/routes/sync.ts` exposes recipient-policy reconciliation through `GET /api/sync/status` and canonical intent through `GET /api/sync/recipient-policy/v1/intent`.
2. `packages/core/src/recipient-policy-intent.ts` projects the full Team, membership, device-registration, and Project-recipient intent graph.
3. `packages/ui/src/tabs/recipient-policy-sharing.tsx` filters that graph to active rows and counts them for the Sharing Team card.
4. `packages/ui/src/tabs/sync/view-model/primary-status.ts` converts a reconciliation `needs_attention` item into broad Team-level warning copy after higher-priority setup and operation blockers are ruled out.
5. `packages/ui/src/tabs/sync/team-sync/render/render-team-sync.ts` renders that status in Advanced.

The architecture allows this combination: `docs/adr/0001-project-recipient-policy-boundaries.md` separates user intent, derived effective recipients, and current scope enforcement, and requires authority cutover per Project.

## Trace: stale unpaired device shown as reviewable

The contradiction is entirely inside the viewer because backend and row-level guards consistently reject stale review.

1. `packages/core/src/better-sqlite-coordinator-store.ts` and `packages/core/src/d1-coordinator-store.ts` retain enrolled devices after presence expiry but return no stale addresses.
2. `packages/core/src/coordinator-runtime.ts` merges sightings, excludes stale addresses, and exposes `stale` and `expires_at` in status.
3. `packages/ui/src/tabs/sync/view-model/sync-view-model.ts` creates the “available to review” attention item for an unpaired stale discovery.
4. `packages/ui/src/tabs/sync/view-model/coordinator-approval.ts` returns false from `shouldShowCoordinatorReviewAction()` for the same stale device.
5. `packages/ui/src/tabs/sync/team-sync/render/render-team-sync.ts` renders the device as offline with no review button.
6. `packages/viewer-server/src/routes/sync.ts` rechecks freshness and returns `discovered_peer_stale` if a caller attempts pairing anyway.

## Characterization fixtures

The focused fixtures preserve evidence of the current contradictions without approving the current wording as the target design.

- `packages/ui/src/tabs/recipient-policy-sharing.test.tsx` renders active Team intent and derives the Advanced reconciliation warning for the same Project fixture.
- `packages/ui/src/tabs/sync/team-sync/render/render-team-sync.test.ts` renders one stale, addressless, unpaired discovery and verifies that its attention item claims review availability while its device row is offline and has no pairing button.

Existing core and server tests cover rollback without granting, stale-address removal, and operation-time stale pairing rejection. The UI fixtures cover only the contradictory presentation that those lower-level tests cannot observe.

## Follow-up boundary

The next design task should assign canonical ownership and replacement copy rather than alter authorization, reconciliation, expiry, or pairing semantics.

Decisions still required:

- whether Advanced names the affected Project and safe failure reason;
- whether Sharing owns reconciliation status or Advanced links to a focused repair surface;
- whether stale devices remain in Attention with an explicitly non-actionable title or appear only in the device inventory;
- how compatibility deep links preserve access to the chosen owner.
