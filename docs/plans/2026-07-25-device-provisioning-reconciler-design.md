# Device-Provisioning Reconciler Design

Status: proposed
Bead: codemem-hksk
Date: 2026-07-25

## Problem

The 2026-07-25 three-peer dogfood (release stack #1353–#1367, v0.40.0-alpha.1)
proved the add-device and Team journeys enroll correctly but deliver nothing:

- The second device accepted an add-device invitation, enrolled at the
  coordinator, and was bound to the teammate Identity
  (`enrolled_devices.identity_id`, PR #1357). It then held **zero memories**
  while the same Identity's first device held the shared Project.
- The owner's local policy graph never learned about either change:
  `policy_team_memberships` stayed empty after the teammate accepted the Team
  invitation (owner `member_count: 0`), and `identity_devices` never gained the
  second device.

Because the owner's graph is the recipient-policy authority, everything derived
from it — effective devices, scope-membership grants, future Team inheritance —
silently excludes coordinator-side facts. The add-device UX now states this
honestly (PR #1367), but the promise "access follows the Identity" and "future
Team members inherit access" is not yet true.

## Goals

1. New devices of an already-granted Identity receive the Identity's shared
   Projects without re-running the share flow.
2. Team memberships accepted at the coordinator materialize in the owner's
   policy graph, so Team-recipient Projects with an existing managed boundary
   reach the member's devices.
3. All grants remain owner-driven, derived from the owner's reviewed recipient
   policy — the coordinator contributes *facts* (who enrolled, which Identity),
   never *policy*.
4. Idempotent and resumable: re-running the reconciler is always safe.

## Non-goals (v1)

- Revocation inferred from an enrollment disappearing from the active-device
  snapshot. The existing recipient-policy reconciler remains bidirectional for
  intentional owner-policy changes; disabled-enrollment ingestion and stale
  device cleanup are tracked separately in `codemem-8x4i`.
- Cross-group reconciliation. One coordinator group per pass.
- Creating a managed boundary for a Project that has only recipient-policy
  edges and no prior share operation. Boundary creation, exact mapping, memory
  reassignment, and non-invite peer bootstrap are tracked in `codemem-hksk.6`;
  such Projects fail closed with `needs_attention` in this version.
- Supersession lifecycle semantics (codemem-e2gq).

## Current-state model

Three stores disagree about who exists:

| Store | Contents | Authority for |
| --- | --- | --- |
| Coordinator (`enrolled_devices`, `coordinator_invites`, `coordinator_scope_memberships`) | device↔Identity bindings, consumed invites with `assigned_identity_id` / `target_identity_id`, scope grants | enrollment facts |
| Owner local policy graph (`actors`, `policy_teams`, `policy_team_memberships`, `identity_devices`, `project_recipients`) | Identities and reviewed recipient intent | recipient policy |
| Recipient local graph (written by `recipient-policy-onboarding.ts` at acceptance) | the recipient's own view | nothing owner-visible |

There is one structural gap: **no owner-side ingestion path**. Identity IDs are
already end-to-end authoritative and need no translation:

- Project-share acceptance enrolls with `recipient_actor_id`, which is also the
  owner policy actor ID.
- Team-member acceptance adopts the coordinator-minted `assigned_identity_id`
  as both the recipient's local actor ID and coordinator enrollment identity.
- Add-device acceptance uses `target_identity_id`, the same existing Identity.

Nothing owner-side reads those coordinator facts into the policy graph.
`identity_devices` edges are created only by `reconcileShareOperationAcceptance`
(direct shares) and recipient-side onboarding.

## Design

### 1. Authoritative coordinator reads

Reuse the existing admin reads through typed coordinator actions:

- `GET /v1/admin/devices?group_id=<g>` for active device↔Identity bindings.
- `GET /v1/admin/invites?group_id=<g>` for token-redacted consumed Team
  invitations. The reconciler filters strictly to `invite_kind = 'team_member'`,
  non-null `consumed_at`, `policy_team_id`, `assigned_identity_id`, and matching
  `recipient_actor_id`.

The last equality is a fail-closed consistency check: the coordinator-assigned
Identity must be exactly the Identity bound at acceptance. No mapping table or
heuristic identity correlation is introduced.

### 2. Enrollment snapshot ingestion

A new owner-side maintenance step, `reconcileCoordinatorEnrollment(db, opts)`
in `packages/core/` (invoked from the existing viewer maintenance loop next to
`advancePendingProjectShares`):

1. Fetch enrolled devices (admin path; the owner holds the
   admin secret — this is the same trust level that created the Team). Devices
   without `identity_id` (legacy/owner enrollments) are ignored.
2. Fetch consumed Team invites through the existing token-redacted admin list.
3. Process each valid consumed Team invite first:
   - Upsert an active non-local `actors` row for `assigned_identity_id` when it
     does not exist (using the neutral display name `Team member`; never expose
     the opaque ID as UI copy).
   - Insert a complete active `policy_team_memberships` row only when the edge
     is absent: `team_id = policy_team_id`, `identity_id =
     assigned_identity_id`, `role = 'member'`, `status = 'active'`,
     `provenance = 'coordinator_invite'`, `migration_state = 'user_managed'`,
     deterministic `revision`, `source_fingerprint`, and unique
     `idempotency_key` derived from the stable group, invite, Team, and Identity
     binding, plus reconciliation-time `created_at` and `updated_at`. Existing
     active edges are no-ops. Existing revoked or otherwise non-active edges
     remain unchanged and surface a reconciliation issue; a historical consumed
     invite must never reactivate membership that the owner revoked.
4. For each enrolled device whose `identity_id` names an active owner policy
   actor:
   - Insert `identity_devices (identity_id, device_id, display_name, status
     'active')` only when the device edge is absent — trim a non-empty
     coordinator display name, or use the stable neutral fallback `Enrolled
     device` when the enrollment name is null or blank. Existing revoked,
     otherwise non-active, or differently bound edges remain unchanged and
     surface a reconciliation issue; enrollment replay must never reactivate an
     owner-revoked device. Derive revision/source/idempotency fingerprints from
     the stable group, Identity, device, and key binding so repeats are no-ops.
     Later non-empty coordinator names may refresh active rows with
     `coordinator_enrollment` provenance, but never overwrite locally managed
     names. Processing Team invites first lets newly created Team actors receive
     their device edges in the same maintenance pass.
5. Missing, merged, deactivated, or inconsistent identities fail the
   maintenance pass and are skipped; they never produce grants. Persisting
   per-row reconciliation issues in a review workflow is tracked separately in
   `codemem-10qd`.

### 3. Grant reconciliation (the actual delivery)

After ingestion, desired state is derivable entirely owner-side:

1. Derive owner-policy candidate devices with
   `deriveRecipientPolicyEffectiveDevicesFromDatabase(db, projectId)`, using
   **active-only** inputs: exclude `pending_*` identities and non-`active`
   edges (this was an explicit PR-7 review requirement). These global Identity
   edges are candidates, not authorization for every coordinator boundary.
2. For each pre-existing exact managed Project boundary (ordinarily a
   `project_scope_mappings` row with `source = 'share_operation'`), retain its
   coordinator and group identity from `replication_scopes`. A Team-recipient
   Project without that boundary is not provisioned implicitly; it fails closed
   for the `codemem-hksk.6` follow-up. Intersect the owner-policy candidate set
   with the active enrollment snapshot from that same coordinator/group only to
   determine eligibility for new grants. A current active scope membership that
   remains in owner policy stays in the expected membership set for capability
   preflight, parity, and stable evidence even when its device is absent from
   that enrollment snapshot; omission alone neither revokes it nor removes it
   from expected parity. The expected set is retained current policy-desired
   memberships plus newly grant-eligible devices. An active enrollment that
   asserts a conflicting Identity remains a fail-closed exception and is
   revoked. Existing memberships are otherwise revoked only for owner-policy
   removal; enrollment omission alone is not a removal signal.
3. Missing devices get `grantMembership` calls through the existing
   recipient-policy reconciler, each wrapped in a durable effect record so
   crashes resume instead of re-granting. That reconciler remains the
   bidirectional authority for intentional owner-policy changes and can revoke
   devices removed from reviewed policy. Enrollment ingestion itself is
   additive: it does not interpret a device omitted from the active enrollment
   snapshot as a revocation signal.
4. Refresh scope-membership caches (`refreshConfiguredScopeMembershipCache`)
   so both devices observe the new grants, then provision pinned peer trust only
   when fresh cache evidence proves that both devices share an active managed
   Project under the exact coordinator/group that supplied the discovered key.
   Tag that trust as coordinator-policy-derived and clear its key binding when
   the last such fresh shared scope ends, without touching manual, local-device,
   or invite-derived trust. Recipient devices then pick up data through the
   authenticated scoped-sync path (verified in the dogfood: cursor bootstrap +
   backfill ops); membership alone never authorizes an unknown peer or enables a
   scope-less default sync path.

### 4. Safety requirements (from the PR-7 blocker map)

These previously identified blockers are addressed or explicitly scoped:

- **Stale-cache authorization**: the reconciler derives desired state from the
  owner's local policy DB (authoritative), and grants against the coordinator
  directly — the freshness-diagnostic-only cache is not part of the
  authorization decision.
- **Durable mutation idempotency**: every grant carries a persisted effect id;
  re-execution checks effects first (pattern already in
  `share-provisioning.ts` `executeStep`).
- **Non-unique project mappings**: retain the existing exact-one mapping safety
  rule and report ambiguous mappings; never silently broaden a policy boundary.
- **Pending identities in previews**: excluded from derivation (active-only).
- **Bootstrap capability evidence**: probe a paired peer normally first. When a
  newly enrolled device has no reviewed address yet, require both token-redacted,
  still-reviewed consumed Team/add-device invite evidence and unexpired,
  device-authenticated coordinator presence asserting `scoped` sync plus
  `reassign_scope`. The invite's device, Identity, public key, and fingerprint
  must match the current active enrollment in the target boundary's exact
  coordinator/group. Invite binding alone never proves client capability, and
  evidence from one configured group is never flattened into another. Every
  viewer and headless-daemon presence publisher includes these capability fields
  in its signed presence body, and coordinator enrollment reads preserve only
  the token-free capability object and expiry from that same group. Older or
  malformed presence remains `undetermined`. The headless sync daemon runs the
  same fresh-cache, shared-managed-scope trust refresh as the viewer path.
- **Disabled-enrollment revocation**: out of scope; deny-overlays
  (`recipient_policy_deny_overlays`) remain a hard filter, and the existing
  recipient-policy reconciler continues enforcing intentional owner-policy
  removals. This additive ingestion pass reads active enrollments only; grant
  reconciliation uses each managed boundary's own active coordinator/group
  enrollment snapshot.
  Reconciling devices disabled after ingestion, including stale policy edges and
  scope membership caused only by enrollment omission, is tracked separately in
  `codemem-8x4i`. Policy-derived peer trust still follows the shared-scope
  lifecycle above and is cleared when its last fresh authorization ends.
- **Transactional acceptance/onboarding separation**: owner-side ingestion is
  repeatable, but it cannot repair recipient-local state. If the recipient
  crashes after `/v1/join` consumes the invitation and before local Identity,
  Team/device, and sync-configuration writes finish, the recipient must retry
  the same import to resume its idempotent onboarding. Automatic recovery would
  require a separate durable recipient-side resume record and worker.

### 5. Truthful UX follow-through

- Add-device completion (PR #1367 copy) can be upgraded once this ships:
  "existing shares sync after the owner's next reconciliation" with the
  reconciler's actual cadence.
- Owner Sharing → Teams cards start showing real `member_count`.
- Second-device Received tab (PR #1366) populates without manual re-sharing.

## Delivery plan (Graphite stack)

1. **PR 1 — typed coordinator reads.** Typed actions over the existing admin
   device and token-redacted invite lists, with strict consumed-Team filtering
   and Node/D1 integration tests.
2. **PR 2 — enrollment ingestion.** `reconcileCoordinatorEnrollment` materializing
   `identity_devices` + `policy_team_memberships`, fail-closed issue reporting,
   and bounded maintenance-loop wiring.
3. **PR 3 — grant reconciliation and transport trust.** Desired-vs-actual diff,
   idempotent grants, deny-overlay enforcement, reporting of unexpected
   coordinator grants, authenticated presence capability publication, and
   exact-boundary peer-trust provisioning with policy-derived trust cleanup.
4. **PR 4 — E2E + dogfood.** Extend `e2e/scenarios/project-sharing.ts` with a
   second same-Identity device that receives existing + future memories only
   after reconciliation; extend the dogfood checklist; UX copy updates.

Each PR keeps `pnpm run check` green; PR 3 is the security-sensitive one and
gets the deep review pass.

## Open questions

1. **Non-admin owners.** Ingestion currently assumes the owner holds the
   coordinator admin secret (true for Team creators today). If non-admin owners
   become possible, the enrollment read needs a signed non-admin variant scoped
   to groups the device administers — same pattern as signed add-device
   issuance (PR #1360).
2. **Recipient-policy-only boundary provisioning.** `codemem-hksk.6` owns the
   reviewed, idempotent workflow that creates a managed coordinator scope,
   persists its exact Project mapping, reassigns existing memories, and
   bootstraps normal peer discovery. This stack must not mint that authorization
   boundary as an implicit reconciliation side effect.
3. **Cadence.** Piggyback on the existing maintenance tick (2 min in dogfood)
   vs. a slower dedicated interval. Proposal: same tick, with a per-group
   cooldown (5 min) matching the share-operation retry cooldowns.
4. **Team-invite acceptance observation.** Reuse the share-operation
   acceptance-polling shape, or have the recipient's first authenticated sync
   carry an acceptance receipt? Proposal: poll consumed invites in the same
   admin read as PR 2 — no new protocol surface.
