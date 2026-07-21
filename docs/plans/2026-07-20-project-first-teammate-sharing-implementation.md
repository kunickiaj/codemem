# Project-first teammate sharing implementation plan

**Date:** 2026-07-20
**Status:** Ready for implementation
**Design:** `2026-07-20-project-first-teammate-sharing-design.md`
**Tracking:** `codemem-00dc.13`

## Delivery strategy

Deliver the approved experience as a six-PR Graphite stack. Each implementation PR advances the inviter-to-recipient workflow rather than landing disconnected horizontal plumbing.

The first PR freezes the additive persistence and protocol contract. The next three build invite creation, acceptance, and exact project provisioning. The fifth replaces the misleading primary UI. The final PR proves compatibility and exact sharing with two isolated local nodes.

## PR 1: Share-operation contract and exact-boundary plan

### Goal

Define the additive data and protocol contract before changing authorization-sensitive code.

### Work

- Define the persisted sharing-operation shape and lifecycle.
- Define deterministic idempotency identities for Person creation, invite consumption, managed boundaries, device links, grants, memory reassignment, project assignment, and initial sync.
- Define one managed authorization boundary per canonical selected project.
- Make the coordinator the authoritative invite-consume boundary: atomic first-device/public-key binding, same-binding retry, stable replay/expiry rejection, and coordinator-loaded project intent.
- Define bounded membership derivation that preserves existing effective project access without inheriting a source Space member list.
- Add `revoking` and truthful `revoked` lifecycle contracts.
- Define legacy invite and pairing compatibility.
- Define local reassignment for proven-never-replicated memories and additive, capability-negotiated `reassign_scope` semantics for memories that may have replicated.

### Likely files

- `docs/plans/2026-07-20-project-first-teammate-sharing-design.md`
- `packages/core/src/schema.ts`
- `packages/core/src/sync-scope-protocol.ts`
- `packages/viewer-server/src/routes/sync.ts`
- `packages/cloudflare-coordinator-worker/`

### Exit criteria

- The contract can represent every approved lifecycle and retry state.
- Every durable effect has a deterministic retry identity.
- Invite consumption is atomic and bound to one device and public key.
- Canonical project identity determines access; display names cannot.
- A selected project cannot imply sibling-project access.
- Managed boundaries never inherit an unreviewed device set.
- Existing-memory reassignment is fail-closed when required devices lack protocol capability.
- No durable backend table or existing protocol field is renamed.

### Validation

```text
pnpm run tsc
pnpm run lint
```

### Risk

High: authorization and protocol boundary.

## PR 2: Project-first invite creation

### Goal

Deliver the complete inviter-side flow through creation of a reviewed, project-scoped invite.

### Work

- Add the sharing-operation persistence and pure planner.
- Add `Share` and multi-project `Share projects` entry points.
- Select or enter the teammate Person.
- Resolve canonical project identities and reject collisions.
- Show existing-memory counts and future-sharing confirmation.
- Persist the exact reviewed project set.
- Create a single-use expiring invitation.

### Likely files

- `packages/core/src/schema.ts`
- New core sharing-operation and planner modules with tests
- `packages/viewer-server/src/routes/sync.ts`
- `packages/ui/src/tabs/projects.ts`
- `packages/ui/src/lib/api/sync.ts`
- Project and viewer-server tests

### Exit criteria

- Users can create an invite without selecting Spaces or creating mappings.
- Confirmation states exact projects, existing counts, and future activity.
- Empty, ambiguous, or unsupported selections fail before invite creation.

### Validation

```text
pnpm exec vitest run <focused core and viewer-server tests>
pnpm --filter @codemem/ui build
pnpm run tsc
pnpm run lint
```

### Risk

High: this UI is the security review for the intended access set.

## PR 3: Acceptance, Person linking, and friendly device identity

### Goal

Make one acceptance bind the recipient Person and device and establish trust without manual identity setup.

### Work

- Include actor identity and friendly device-name hint in acceptance.
- Implement the approved friendly-name precedence.
- Atomically consume the coordinator-authoritative invite and bind it to one device ID and public-key fingerprint.
- Link or activate the pending Person.
- Register and automatically assign the recipient device.
- Bootstrap reciprocal trust from the invitation.
- Return the existing result for the same bound-device retry; reject a second device/key, expiry, invalid tokens, project-set tampering, and identity conflicts with stable reason codes.
- Keep existing coordinator invites and pairing payloads compatible.

### Likely files

- `packages/viewer-server/src/routes/sync.ts`
- Core identity and sharing-operation modules
- `packages/ui/src/tabs/sync/`
- `packages/ui/src/lib/api/sync.ts`
- Coordinator worker invite/bootstrap handlers and tests

### Exit criteria

- Acceptance creates or links Brian and `Brian's MacBook` automatically.
- Raw UUIDs are absent from the primary accepted-device presentation.
- Retried acceptance cannot duplicate identity or trust state.
- The recipient cannot supply or broaden the coordinator-persisted reviewed project set.

### Validation

```text
pnpm exec vitest run <focused identity, protocol, and viewer-server tests>
pnpm run tsc
pnpm run lint
```

### Risk

High: identity and trusted-device binding.

## PR 4: Exact project access and initial replication

### Goal

Make acceptance fulfill the sharing promise without waiting for hidden manual grants or daemon refreshes.

### Work

- Create or reuse one managed boundary per reviewed project.
- Grant only the initiating device, inviter devices proven to already have effective selected-project access, and the accepting device; never inherit the source Space member list.
- Implement additive capability negotiation and transactional, idempotent `reassign_scope` for selected memories that may have replicated.
- Reassign proven-never-replicated selected memories locally and fail closed before partial migration when a required owner device lacks reassignment capability.
- Persist future selected-project assignment.
- Refresh local authorization state immediately.
- Start and observe initial sync.
- Persist per-step failures and resume idempotently.

### Likely files

- `packages/core/src/schema.ts`
- `packages/core/src/scope-membership-cache.ts`
- `packages/core/src/sync-scope-protocol.ts`
- `packages/core/src/sync-pass.ts`
- `packages/core/src/sync-daemon.ts`
- Project mapping and replication modules/tests
- `packages/viewer-server/src/routes/sync.ts`
- Coordinator worker scope and membership handlers/tests

### Exit criteria

- Existing and future selected-project memories can replicate.
- Unrelated-project memories never move into the managed boundary.
- Unreviewed devices never gain selected-project access through source-Space membership inheritance.
- Authorization becomes usable immediately after provisioning.
- Grant, migration, assignment, refresh, and bootstrap retries are idempotent.

### Validation

```text
pnpm exec vitest run <focused core, coordinator, and viewer-server tests>
pnpm run tsc
pnpm run lint
```

### Risk

High: authorization and replication correctness.

## PR 5: Lifecycle UI and recovery replacement

### Goal

Replace implementation-state UI with the approved Person, device, project-sharing, and recovery experience.

### Work

- Derive primary lifecycle from sharing-operation state.
- Render People with devices nested beneath them.
- Show exact shared-project summaries.
- Render `Waiting for acceptance`, `Setting up project access`, `Starting first sync`, `Waiting for device`, `Up to date`, truthful revocation states, and exact failure states.
- Move stalled non-device provisioning to `needs_attention` after its deadline/retry budget while keeping an offline recipient passive.
- Provide one primary recovery action.
- Move Space, filter, cursor, membership, address, and raw-ID detail into diagnostics.
- Remove or demote bare `Pending`, `Received`, `Save assignment`, `Review Space fit`, and generic context-losing Teams links.
- Reflect project-first operations in Teams without making Teams the common entry point.

### Likely files

- Sharing-operation status derivation and tests
- `packages/ui/src/tabs/sync/index.ts`
- `packages/ui/src/tabs/sync/view-model/peer-status.ts`
- `packages/ui/src/tabs/sync/components/sync-peers.tsx`
- `packages/ui/src/tabs/sync/components/sync-sharing-review.tsx`
- `packages/ui/src/tabs/projects.ts`
- `packages/ui/src/tabs/coordinator-admin/`

### Exit criteria

- The screenshot state can no longer show ambiguous `Pending` beside unrelated assignment controls.
- Every incomplete primary state either explains passive waiting or provides one repair action.
- Revoked state states that previously copied memories may remain.
- Advanced details preserve diagnostic precision without leaking into the normal workflow.

### Validation

```text
pnpm exec vitest run <focused UI tests>
pnpm --filter @codemem/ui build
pnpm run tsc
pnpm run lint
```

### Risk

Medium: interaction and recovery clarity.

## PR 6: Compatibility, two-node proof, and documentation

### Goal

Prove the full contract and document the replacement workflow.

### Work

- Extend the isolated two-node sharing E2E scenario.
- Seed multiple projects and share exactly one.
- Verify automatic Person/device linking and friendly naming.
- Verify existing and future selected-project memories arrive.
- Verify unrelated projects remain absent.
- Verify the source Space member list is not inherited and fail-closed membership reason codes remain enforced.
- Verify `reassign_scope` capability negotiation, transactional application, and unsupported-peer rejection before partial migration.
- Inject provisioning failures and prove resumable idempotent retry.
- Cover identical bound-device retry plus second-device replay, expiry, tampering, and legacy invitations.
- Update user-facing sync/sharing docs and compatibility notes.

### Likely files

- `e2e/scenarios/sharing-domains.ts`
- New focused project-sharing E2E scenario if separation improves clarity
- Core, viewer-server, coordinator, and UI regression tests
- `README.md` and affected files under `docs/`

### Exit criteria

- Two local nodes complete the approved flow without manual repair steps.
- Exact-project isolation is asserted at the destination.
- Full compatibility and failure-recovery coverage passes.
- Documentation no longer teaches the old manual sequence as the normal path.

### Validation

```text
CODEMEM_E2E_BUILD=1 CODEMEM_E2E_JSON=1 pnpm run e2e:smoke -- --json
pnpm run check
```

### Risk

Medium: broad validation surface.

## Dependency order

```text
PR 1 contract
  └─ PR 2 invite creation
       └─ PR 3 acceptance and identity
            └─ PR 4 exact provisioning
                 └─ PR 5 lifecycle UI
                      └─ PR 6 E2E, compatibility, docs
```

## Review gates

- PRs 1–4 require security and authorization review.
- PRs 2–5 require user-flow review against the approved experience contract.
- PR 4 must prove fail-closed behavior before UI work can describe setup as automatic.
- PR 6 must assert absence of unrelated project data, not merely presence of selected data.

## Final release gate

Run the repository's normal gate in CI order:

```text
pnpm run tsc && pnpm run lint && pnpm run test
```

Build the UI/viewer assets when the touched slice requires them. Generated viewer static assets remain untracked.
