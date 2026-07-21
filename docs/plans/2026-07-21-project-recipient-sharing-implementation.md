# Project-recipient sharing implementation plan

**Date:** 2026-07-21
**Status:** Approved implementation stack
**Design:** `2026-07-21-project-recipient-sharing-identity-design.md`

## Goal

Replace the default Team/Space/device-grant administration experience with a project-recipient policy model:

- Projects are shared with Identities or Teams.
- Devices inherit access through exactly one Identity per runtime.
- Team members inherit Projects explicitly shared with their Team.
- Managed Project scopes continue enforcing authorization behind the UI.
- Sync is presented as background status, not a top-level engine users operate.
- Existing state migrates through actionable, durable decisions without broadening access.

The July 20 project-first sharing stack remains the exact-project invitation and provisioning foundation. This plan adds the durable recipient-policy graph, Team and Identity inheritance, bidirectional bulk management, migration, and new information architecture.

Implementation starts from the merged July 20 stack on current `main`. It does not revert that work. Exact-Project boundaries, invitation binding, reassignment, provisioning, lifecycle, and E2E isolation remain the lower-level foundation; recipient policy and the new information architecture replace or evolve the policy and presentation layers above them.

## Delivery rules

- Build as a Graphite stack from contracts through policy authority and final UI promotion.
- Keep each PR independently reviewable and safe when deployed without its upstack descendants.
- Project-recipient intent must not become authorization authority until parity and fail-closed reconciliation are proven.
- Existing scopes remain the hard boundary throughout migration.
- Legacy controls remain available under Advanced until the new model is authoritative and rollback-safe.
- Every policy mutation is preview-first and bound to canonical IDs plus a reviewed revision/digest.
- OAuth/OIDC and GitHub organization/path/tag rules remain deferred.

## Proposed Graphite stack

```text
main
└── PR 1  Recipient-policy contracts and ADRs
    └── PR 2  Read-only legacy policy projection
        └── PR 3  Actionable migration review
            └── PR 4  Durable policy-intent graph
                └── PR 5  Bulk recipient management and Projects UI
                    └── PR 6  Identity, Team, device, and invite journeys
                        └── PR 7  Policy authority and reconciliation
                            └── PR 8  Navigation promotion, proof, and docs
```

## PR 1 — Recipient-policy contracts and ADRs

### Objective

Freeze the policy vocabulary and contract boundaries before persistence or UI work.

### Decisions to record

1. **Identity storage:** whether existing `actors` become the Identity backing record or remain a compatibility projection over a new table.
2. **Team storage:** whether coordinator groups are canonical Team records or external enrollment/discovery records linked to a policy Team.
3. **Authority cutover:** measurable per-Project parity and rollback criteria.
4. **Review audit:** attribution and owner-routing rules for review decisions.
5. **Legacy invitations:** whether they remain enrollment-only or may create non-authoritative policy projections.
6. **Navigation compatibility:** stable handling for existing `#sync` and Teams deep links.

### Contract

Define versioned shapes for:

- Identity;
- Team;
- Team membership;
- Identity device;
- Project recipient;
- policy projection;
- actionable review item;
- reconciliation status.

The contract must distinguish:

```text
user intent ≠ effective recipients ≠ current scope enforcement
```

### Likely files

- `docs/adr/`
- `docs/plans/2026-07-21-project-recipient-sharing-identity-design.md`
- new policy contract modules under `packages/core/src/`
- `packages/core/src/share-operation.ts`

### Validation

- Fixtures cover canonical Project uniqueness.
- One device/runtime maps to exactly one Identity.
- Team and direct Identity recipient shapes are distinct.
- `Keep current setup unchanged` is a first-class review outcome.
- No contract field treats group enrollment, trust, connectivity, or filters as authorization.

## PR 2 — Read-only policy projection over legacy state

### Objective

Describe current access through the new model without changing authorization or persistence.

### Contract

Add read-only policy projection APIs that return:

- canonical Projects;
- candidate Identities and Teams;
- current effective devices;
- direct, Team-derived, and legacy provenance;
- confidence and ambiguity;
- current scope-enforcement status;
- actionable versus diagnostic-only conditions.

### Behavior

- Managed exact-Project scopes project cleanly.
- Clear personal and Team candidates are suggestions only.
- Ambiguous multi-Project Spaces remain unresolved.
- Unassigned devices remain visible without receiving inferred Identity access.
- Replication behavior and scope membership remain unchanged.

### Likely files

- new projection modules under `packages/core/src/`
- `packages/core/src/share-operation.ts`
- `packages/core/src/share-operation-lifecycle.ts`
- `packages/viewer-server/src/routes/sync.ts`
- `packages/ui/src/lib/api/sync.ts`
- focused read-only prototypes in Projects/Sync tests

### Validation

- Projection does not mutate the database.
- Projection cannot broaden access.
- Normal projection responses omit secrets, payloads, addresses, fingerprints, epochs, and cursors.
- Tests cover managed, personal, Team candidate, unassigned-device, and ambiguous legacy fixtures.

## PR 3 — Actionable migration review

### Objective

Ensure every ambiguity has concrete decisions and a durable completion state before migration writes exist.

### Persistence

Add review records keyed by a stable source-state fingerprint. Each record includes:

- finding and plain-language reason;
- recommended decision;
- all valid decisions;
- exact preview for each decision;
- status and selected outcome;
- deciding Identity/device attribution;
- source fingerprint and resolved timestamp.

### Required outcomes

- apply recommendation;
- choose recipients;
- preserve effective access exactly;
- keep Project local;
- keep Identities separate;
- attach device to Identity;
- create Identity;
- remove stale device;
- keep current setup unchanged.

Rejecting a suggestion or keeping current state clears the item until its source fingerprint changes.

### Likely files

- schema/bootstrap files in `packages/core/src/`
- new `packages/core/src/policy-review*.ts`
- `packages/viewer-server/src/routes/sync.ts`
- `packages/ui/src/tabs/projects.ts`
- existing sharing-review components under `packages/ui/src/tabs/sync/`

### Validation

- No review item exists without at least one safe decision.
- Every decision has a preview and clears the item.
- `Keep current` makes no authorization change.
- Durable reject outcomes do not reappear until source state changes.
- Bulk resolution is atomic per review item and reports partial failures precisely.
- Non-local/source-owned conditions route to a named owner action or become `Blocked`, not `Needs review`.

## PR 4 — Durable policy-intent graph and migration writer

### Objective

Persist recipient intent without changing scope authorization.

### Persistence

Add or adapt durable records for:

```text
Identity
Team
TeamMembership(Team, Identity)
IdentityDevice(Identity, Device)
ProjectRecipient(Project, Identity | Team)
```

Records carry provenance, version/revision, migration state, timestamps, and idempotency identities.

### Migration behavior

- Convert managed exact-Project operations idempotently.
- Convert only unambiguous legacy state automatically.
- Require a resolved PR 3 decision for every ambiguous write.
- Preserve existing scopes, mappings, and narrowing filters.
- Do not change scope membership in this PR.

### Likely files

- schema/bootstrap files in `packages/core/src/`
- new `packages/core/src/recipient-policy.ts`
- `packages/core/src/share-operation.ts`
- `packages/core/src/store.ts`
- `packages/viewer-server/src/routes/sync.ts`

### Validation

- Migration is replay-safe and idempotent.
- Personal and Work Identities remain separate.
- A device belongs to only one Identity.
- Team membership changes effective projection but not authorization yet.
- Recipient-controlled requests cannot replace canonical Project IDs or bypass reviewed revisions.

## PR 5 — Bidirectional recipient management and Projects UI

### Objective

Support scalable Project-to-recipient and recipient-to-Project management against the intent graph.

### API

Preview-first endpoints return:

- exact canonical Projects;
- selected Teams and Identities;
- current and future member inheritance;
- effective devices;
- existing-memory counts;
- unchanged Projects;
- reviewed policy revision/digest.

Commit rejects stale previews and display-name-only selection.

### UI

Projects gains:

- concise Project rows;
- Team and Identity recipient chips;
- multi-select;
- `Share selected`;
- Project detail recipient management;
- a separate actionable review queue.

Sharing gains Team and Identity detail with `Add projects` and `Manage projects` bulk workflows.

Legacy Space selectors, mappings, and filters move under Advanced but remain functional.

### Likely files

- `packages/viewer-server/src/routes/sync.ts`
- `packages/ui/src/lib/api/sync.ts`
- `packages/ui/src/tabs/projects.ts`
- `packages/ui/src/tabs/project-sharing.tsx`
- new Sharing tab modules
- `packages/ui/static/index.html`

### Validation

- Both management directions produce identical `ProjectRecipient` records.
- Bulk previews and commits remain exact after concurrent changes.
- Normal Project flows contain no scope, grant, actor, peer, filter, epoch, or cursor controls.
- Keyboard, focus, responsive, empty, loading, and partial-failure states have component coverage.

## PR 6 — Identity, Team, device, and invitation journeys

### Objective

Make recipient onboarding and device registration match the approved inheritance model.

### Journeys

#### Team invitation

- Preview current Team Projects, memory counts, and future inheritance.
- Bind acceptance to one Identity and device/key.
- Create Team membership.
- Do not treat enrollment or trust as Project authorization before PR 7 reconciliation.

#### Direct Project invitation

- Preserve the July 20 exact reviewed-Project contract.
- Create or link one recipient Identity.
- Do not create Team membership.

#### Add-device invitation

- Bind the device to exactly one Identity.
- Preview direct and Team-inherited Projects plus exclusions.
- Reject cross-Identity merging.

### Compatibility

- Existing pairing and coordinator invitations remain valid.
- Legacy invitations are clearly enrollment-only unless the ADR explicitly defines a safe translation.
- Manual Identity/device correction remains under Advanced.

### Likely files

- `packages/core/src/share-operation.ts`
- `packages/core/src/share-operation-lifecycle.ts`
- `packages/viewer-server/src/routes/sync.ts`
- coordinator store/API and Worker invite handlers
- `packages/ui/src/tabs/sync/`
- `packages/ui/src/tabs/coordinator-admin/`
- new Sharing/Devices components
- `packages/ui/static/index.html`

### Validation

- Team acceptance shows current and future inheritance.
- Add-device acceptance shows exact inherited access and exclusions.
- Identical retry is idempotent; another device/key is rejected.
- Friendly names are normalized, escaped, and length-limited.
- Team enrollment, trust, connectivity, and discovery never create Project access by themselves.

## PR 7 — Policy authority and fail-closed reconciliation

### Objective

Promote recipient policy to desired-state authority and reconcile it into managed exact-Project scopes.

### Reconciler

For each canonical Project:

```text
desired devices = direct Identity devices
                + Team member Identity devices

desired − current → grant
current − desired → revoke
```

The reconciler:

- persists step state and idempotency identities;
- verifies one managed scope per canonical shared Project;
- never copies a source Space's full membership;
- refreshes authorization immediately;
- resumes from the first incomplete step;
- treats offline devices as waiting;
- fails closed for ambiguity, stale membership, unsupported peers, or capability gaps;
- preserves truthful revocation warnings for delivered copies.

### Cutover

Use a per-Project dual-read/status period. Legacy scope enforcement remains authoritative until the Project satisfies ADR-defined parity and rollback gates. No global flag flips all Projects at once.

### Likely files

- `packages/core/src/share-provisioning.ts`
- new recipient-policy reconciler modules
- `packages/core/src/sync-replication.ts`
- `packages/core/src/scope-membership-cache.ts`
- `packages/core/src/sync-daemon.ts`
- `packages/viewer-server/src/routes/sync.ts`
- coordinator scope membership handlers

### Validation

- Current and future Team members receive only explicitly Team-shared Projects.
- New Identity devices inherit only that Identity's access.
- Personal and Work remain isolated until an explicit cross-Identity share.
- Desired/current diffs are idempotent under retries and response loss.
- Revocation blocks future ops and refreshes authorization promptly.
- Filters and visibility only narrow.
- Unsupported peers fail before partial reassignment.
- Every unrelated Project remains absent, including inactive and tombstoned rows.

## PR 8 — Navigation promotion, proof, and documentation

### Objective

Promote the new information architecture only after migration and policy-authority gates pass.

### UI

Ship:

```text
Feed     Projects     Sharing     Devices     Health
```

- `Sharing` owns Teams, Identities, and invitations.
- `Devices` owns device availability and inherited-access summaries.
- `Sync` becomes an Advanced compatibility/diagnostics alias with stable deep-link handling.
- Teams/Space/grant administration remains available under Advanced.

### Promotion gates

- policy projection covers current supported state;
- every blocking review item is actionable;
- migration decisions are durable;
- exact per-Project reconciliation parity is proven;
- rollback visibility remains available;
- primary UI has no raw internal terminology.

### Likely files

- `packages/ui/src/lib/state.ts`
- `packages/ui/static/index.html`
- `packages/ui/src/tabs/projects.ts`
- new Sharing and Devices modules
- `packages/ui/src/tabs/sync/`
- `packages/ui/src/tabs/coordinator-admin/`
- `e2e/scenarios/project-sharing.ts`
- `README.md`
- `docs/user-guide.md`
- affected sync/coordinator documentation

### Validation

- Team bulk share and future-member inheritance E2E.
- Direct Identity share without Team membership E2E.
- New-device Identity inheritance E2E.
- Personal/Work isolation plus explicit cross-Identity OSS share E2E.
- Revocation, offline resume, stale preview, and unsupported-peer E2E.
- Ambiguous migration under-sharing and durable `Keep current` E2E.
- Normal UI absence assertions for scopes, grants, addresses, fingerprints, filters, epochs, and cursors.
- `pnpm run check` plus project-sharing, sharing-domain, smoke, and Worker integration gates.

## Rollout and rollback

- Enable projection before persistence.
- Enable persistence before authority.
- Cut over one Project at a time after parity proof.
- Keep legacy enforcement and diagnostics visible until the next stable release proves the new path.
- A cutover failure returns that Project to legacy enforcement without deleting policy intent or review history.
- Never perform a database-wide rescope or grant rewrite as one migration transaction.

## Deferred follow-ups

- OAuth/OIDC-backed Identity verification and account recovery.
- GitHub organization, path, and tag automation with preview-first defaults.
- Multiple Identities in one runtime.
- Device profiles or role-based defaults.
- Remote deletion or cryptographic recall of delivered data.
- Coordinator data-path or centralized memory storage changes.

## Stack completion criteria

- The four visible concepts are Project, Identity, Team, and Device.
- Projects and recipients are manageable in bulk from either direction.
- Team and device invitations preview inherited access truthfully.
- Every review item provides valid decisions and clears durably.
- Scopes remain authoritative, exact, and hidden in normal use.
- No migration or retry path broadens access.
- Two-node tests prove exact current/future sharing, inheritance, isolation, revocation, and recovery.
