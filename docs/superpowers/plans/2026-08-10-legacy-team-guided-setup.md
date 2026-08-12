# Legacy Team Guided Setup Implementation Plan

## Status

Partially implemented. The fail-closed Team eligibility foundation is delivered
separately; this plan scopes the remaining guided-setup activation work from the
approved [Legacy Team Guided Setup Design](../specs/2026-08-10-legacy-team-guided-setup-design.md).

## Outcome

Configured pre-identity coordinator groups appear as resumable Team setup candidates. A user must review every active roster device before activation. Activation creates one canonical Team with reviewed memberships and a Team-specific device allowlist without changing current Project recipients. Normal invitation-created Teams retain person-level device expansion.

## Non-negotiable safety rules

- Draft rows never participate in authorization.
- Existing sharing remains authoritative until the finish transaction commits.
- `reviewed_allowlist` expansion must ship before any code can activate such a Team.
- Empty or missing allowlist decisions deny all Team-sourced devices; they never fall back to person-level expansion.
- A Team exclusion narrows only that Team path. A direct identity recipient or another Team may still grant the same device.
- Candidate and API payloads use opaque references and sanitized labels. They never expose coordinator URLs, group IDs, public keys, local paths, or raw database errors.
- No existing Team is silently converted to a different eligibility mode.

## Settled implementation decisions

### Canonical records

Add `policy_teams.device_eligibility_mode` with values:

- `person_all_devices`, the default for existing and invitation-created Teams;
- `reviewed_allowlist`, written explicitly by guided activation.

Add `policy_team_device_decisions`, keyed by `(team_id, device_id)`, with decision values `included`, `excluded`, and `unresolved`. Recipient expansion branches on the Team mode, not on the presence of decision rows.

The mode is required in every pure derivation input. Missing or unknown modes and unknown decision values produce blocking findings; they never default to `person_all_devices`.

Reviewed Teams store canonical memberships with status `reviewed_active`. The new runtime treats that status as active only for `reviewed_allowlist` Teams. An older runtime treats it as unknown and blocks derivation, preventing rollback from silently expanding a reviewed Team person-wide.

### Draft records

Use a draft header plus one row per roster device. Every transition into **Needs setup** creates a new immutable, opaque, non-enumerable `attempt_id`; the header owns that attempt ID, the opaque candidate reference, coordinator/group lookup data, roster fingerprint, persisted state, safe error code, finish digest, completed Team ID, and timestamps. Device rows own sanitized display data, stable key fingerprint, enabled state, decision, proposed identity, expected assignment version, and verified evidence kind. Persisted draft states are `needs_setup`, `in_progress`, `stale`, and `completed`; candidate status derives `ready` from a compatible completed canonical Team rather than storing `ready` as a draft state.

Coordinator and group identifiers may be retained only in local database columns needed to refresh the roster. They must not appear in responses, fixtures, diagnostics, or logs.

### Assignment concurrency and invalidation

If a requested assignment already matches the canonical active device-to-identity assignment, the writer is a no-op. It does not increment `assignment_version`, invalidate included decisions, or return an already reviewed Team to **Needs setup**.

Add a monotonic `assignment_version` to `identity_devices`. Introduce one canonical assignment writer that:

1. compares the expected assignment version;
2. updates the device assignment and increments the version;
3. changes every prior `included` Team decision for that device to `unresolved` in the same transaction;
4. marks affected setup state as `needs_setup`.

Route all production assignment writes through this boundary. Add a database-level invariant if any generic write path cannot reliably use the shared writer. Display-name-only updates do not increment the assignment version.

Drafts represent an unassigned device with an explicit absent-row token. If any `identity_devices` row appears before save or finish, compare-and-set fails with `team_setup_assignment_changed` even when the new row starts at assignment version zero.

### Candidate identity and roster fingerprint

Extract the existing deterministic candidate-ID function from `legacy-recipient-policy-projection.ts` and `deterministicPolicyTeamId` from `recipient-policy-migration.ts` into one dependency-free identifier module.

Compute the roster fingerprint from sorted records containing only:

- device ID;
- validated public-key fingerprint;
- enabled state;
- coordinator-reported identity assignment when present.

Exclude display name, presence expiry, presence capabilities, and ordering. Treat `enabled === 1` as active. A public-key/fingerprint mismatch is a blocking roster error, not a suggestion.

### Existing legacy recipient review

Pre-identity Team candidates must no longer be materialized through `choose_recipients`. That path can create a Team and Project recipient before device review. Replace the selectable legacy candidate with the guided setup entry point, and fail closed if a stale saved resolution still targets it.

Guided activation creates the Team and memberships only. It does not create `project_recipients`; users select the ready Team through the normal Sharing flow afterward.

If the deterministic Team row already exists:

- reuse it only when it is a compatible, inactive-effect placeholder with no memberships or recipient edges;
- or adopt the exact legacy row previously materialized from this candidate by `choose_recipients` when its deterministic Team ID, `reviewed_team_candidate` provenance, source fingerprint, memberships, and recipient edges all match the saved legacy resolution. Preserve those recipient edges, expose their complete effective-access delta in review, and convert the Team to `reviewed_allowlist` only in the confirmed finish transaction. Any extra or mismatched canonical state returns `team_setup_conflict`;
- or, when it is the same canonical `reviewed_allowlist` Team returning to **Needs setup**, update it in place after validating its current memberships, decisions, assignment versions, and recipient edges. Preserve existing recipient edges and reject any incompatible mode, identity, or provenance drift;
- otherwise return `team_setup_conflict` without changing current sharing.

Do not rewrite existing `policy_teams` modes during additive schema upgrade.

### Idempotent finish

Each setup attempt stores a deterministic finish digest derived from its immutable `attempt_id`, candidate reference, fresh roster fingerprint, normalized decisions, normalized proposed identity assignments, expected assignment versions, the complete validated canonical Team snapshot, and the confirmed complete access-delta digest. The activation transaction persists an immutable successful completion record keyed by `(attempt_id, finish_digest)`, including the attempt's immutable candidate reference, completed Team ID, completion timestamp, and exact response. Every replay lookup also requires that stored candidate reference to equal the validated `:candidateRef` route parameter; submitting one candidate's completion tokens through another candidate route never replays success. An exact retry for that candidate and attempt returns the stored response without replaying writes or reconstructing it from later Team state. A later **Needs setup** cycle has a distinct attempt ID and completion record even when every roster and decision input is otherwise identical. A request that changes any canonical input, including a proposed identity, is a different finish operation.

### Display-name behavior

Display labels are not security evidence and are excluded from fingerprints and idempotency keys. Refresh the sanitized candidate label independently. A label change alone does not stale a draft or conflict with an otherwise compatible Team.

## Proposed Graphite stack

The remaining implementation should use focused PRs. Each PR must be independently
safe; guided activation must not change effective sharing before its finish
transaction commits.

### Delivered foundation: Add fail-closed Team device eligibility

**Purpose:** Establish the authorization model before activation can write it.

**Status:** Delivered separately as the Team eligibility foundation. The remaining
guided-setup work depends on it rather than reimplementing it.

**Files:**

- `packages/core/src/schema.ts`
- `packages/core/src/schema-bootstrap.ts`
- `packages/core/src/db.ts`
- `packages/core/src/test-schema.generated.ts` (generated)
- `packages/core/src/test-schema.generated.test.ts`
- `packages/core/src/db.test.ts`
- `packages/core/src/policy-team-device-eligibility.ts` (new)
- `packages/core/src/policy-team-device-eligibility.test.ts` (new)
- `packages/core/src/recipient-policy-reconciliation.ts`
- `packages/core/src/recipient-policy-reconciliation.test.ts`
- `packages/core/src/recipient-policy-edges.ts`
- `packages/core/src/recipient-policy-edges.test.ts`
- `packages/core/src/recipient-policy-intent.ts`
- `packages/core/src/recipient-policy-intent.test.ts` (new)
- `packages/core/src/recipient-policy-contract.test.ts`
- `packages/core/src/index.ts`

**Work:**

1. Add `device_eligibility_mode`, `policy_team_device_decisions`, and `identity_devices.assignment_version` to Drizzle schema, bootstrap DDL, and additive compatibility DDL.
2. Keep the Team mode default `person_all_devices`; do not backfill existing rows to `reviewed_allowlist`. Existing assignment versions start at zero.
3. Regenerate test schema with `pnpm --filter @codemem/core run generate:test-schema`.
4. Make Team mode required in pure derivation inputs and add blocking codes for unknown modes, unknown decision values, and invalid membership-mode combinations.
5. Implement one pure Team-device eligibility filter reused by authoritative reconciliation and edge preview.
6. Load Team mode and decisions in both database projection paths.
7. Include mode and decisions in preview CAS facts only for `reviewed_allowlist` Teams so existing `person_all_devices` digests remain byte-identical. A mode change invalidates any outstanding preview digest.
8. Recognize `reviewed_active` memberships only for `reviewed_allowlist` Teams; all other combinations block.
9. Replace intent projection's unknown-to-`active` fallbacks with explicit status mapping. Map `reviewed_active` to the public `active` contract only after confirming `reviewed_allowlist`; map unknown or invalid combinations to a non-active presentation. Keep the public contract union unchanged.

**Acceptance:**

- Existing Teams expand exactly as before.
- A reviewed Team includes only active `included` devices owned by active members.
- Empty, excluded, unresolved, disabled, unbound, and off-roster devices remain ineligible.
- Direct identity and other-Team sources remain independent.
- Preview and authoritative derivation agree.
- Missing or unknown modes and decisions block instead of expanding.
- A reviewed Team's `reviewed_active` membership fails closed under an older-runtime interpretation.
- Changing Team mode invalidates outstanding edge-preview CAS facts.
- Intent projection never normalizes an unknown Team, membership, or device status to active.

**Validate:**

```fish
pnpm --filter @codemem/core run generate:test-schema
pnpm exec vitest run packages/core/src/test-schema.generated.test.ts packages/core/src/db.test.ts packages/core/src/policy-team-device-eligibility.test.ts packages/core/src/recipient-policy-reconciliation.test.ts packages/core/src/recipient-policy-edges.test.ts packages/core/src/recipient-policy-intent.test.ts packages/core/src/recipient-policy-contract.test.ts
pnpm run tsc
pnpm run lint
```

### PR 2: Add candidate discovery and durable drafts

**Purpose:** Represent setup progress without affecting authorization.

**Files:**

- `packages/core/src/schema.ts`
- `packages/core/src/schema-bootstrap.ts`
- `packages/core/src/db.ts`
- `packages/core/src/test-schema.generated.ts` (generated)
- `packages/core/src/legacy-team-candidate.ts` (new)
- `packages/core/src/legacy-team-candidate.test.ts` (new)
- `packages/core/src/legacy-team-setup-draft.ts` (new)
- `packages/core/src/legacy-team-setup-draft.test.ts` (new)
- `packages/core/src/legacy-recipient-policy-projection.ts`
- `packages/core/src/legacy-recipient-policy-projection.test.ts`
- `packages/core/src/recipient-policy-identifiers.ts` (new)
- `packages/core/src/recipient-policy-migration.ts`
- `packages/core/src/recipient-policy-migration.test.ts`
- `packages/core/src/index.ts`

**Work:**

1. Add draft header and device tables with foreign keys, uniqueness, and indexes for state and finish digest.
2. Extract deterministic candidate identity and stable roster fingerprint helpers.
3. Discover candidates from configured coordinator groups and validated roster snapshots.
4. Derive candidate-facing status as `needs_setup`, `in_progress`, `stale`, or `ready` without exposing lookup identifiers.
5. Persist assignment confirmation and Team decisions with compare-and-set semantics against either an explicit absent-row token or the existing row's assignment version and identity.
6. Preserve unchanged decisions across refresh; mark new devices unresolved and removed or disabled devices pending review. Confirmed finish retires those removed or disabled devices' Team-specific decision rows instead of carrying them into the refreshed roster.
7. Permit an excluded device to remain globally unassigned.

**Acceptance:**

- Opening and saving a draft causes no policy, membership, assignment, or Project-recipient writes.
- Display-name and presence-only changes preserve the roster fingerprint.
- Key, enabled-state, identity, addition, or removal changes stale the draft.
- Suggestions are emitted only for exact, verified local assignment evidence and remain unselected.

**Validate:**

```fish
pnpm --filter @codemem/core run generate:test-schema
pnpm exec vitest run packages/core/src/test-schema.generated.test.ts packages/core/src/legacy-team-candidate.test.ts packages/core/src/legacy-team-setup-draft.test.ts packages/core/src/legacy-recipient-policy-projection.test.ts packages/core/src/recipient-policy-migration.test.ts packages/core/src/db.test.ts
pnpm run tsc
pnpm run lint
```

### PR 3: Add atomic activation and assignment invalidation

**Purpose:** Materialize a complete reviewed draft without unreviewed access widening.

**Files:**

- `packages/core/src/schema.ts`
- `packages/core/src/schema-bootstrap.ts`
- `packages/core/src/db.ts`
- `packages/core/src/identity-device-assignment.ts` (new)
- `packages/core/src/identity-device-assignment.test.ts` (new)
- `packages/core/src/coordinator-enrollment-reconciler.ts`
- `packages/core/src/coordinator-enrollment-reconciler.test.ts`
- `packages/core/src/legacy-team-setup-activation.ts` (new)
- `packages/core/src/legacy-team-setup-activation.test.ts` (new)
- `packages/core/src/recipient-policy-onboarding.ts`
- `packages/core/src/recipient-policy-migration.ts`
- `packages/core/src/recipient-policy-migration.test.ts`
- `packages/core/src/recipient-policy-review.ts`
- `packages/core/src/recipient-policy-review.test.ts`
- `packages/core/src/recipient-policy-contract.ts`
- `packages/core/src/index.ts`

**Work:**

0. Add an immutable completion table with `UNIQUE (attempt_id, finish_digest)`, storing the attempt's immutable candidate reference, completed Team ID, completion timestamp, and exact bounded response. This constraint backs the concurrent-finish loser replay path, while the stored candidate reference binds every replay to its candidate route.
1. Add the canonical assignment mutation boundary over the assignment-version column introduced in PR 1.
2. Route every production assignment insert or update through it, including coordinator enrollment reconciliation, reviewed onboarding, and recipient-policy migration; invalidate prior included decisions atomically.
3. Validate draft completeness, fresh roster fingerprint, expected assignment versions, active identities, compatible Team state, and the exact proposed identity for every assignment.
4. Before finish, use authoritative recipient derivation to compute the complete before/after effective-device graph for every affected existing direct-identity or Team recipient. Cover every cause in the proposed transaction: assignment writes and invalidations, Team-mode conversion, final device decisions, guided-setup membership reconciliation, and preserved recipient edges on an adopted Team. Include every added and removed Project/device edge in the review payload and finish digest; no access change is exempt from explicit confirmation.
5. In one `BEGIN IMMEDIATE` transaction, recheck `(candidate_ref, attempt_id, finish_digest)` before any validation or canonical write; if another request already committed that completion for the validated route candidate, return its exact stored response and commit no new work. A completion for any other candidate is not a replay match. Otherwise rederive and compare the confirmed complete access delta, then write assignments, Team mode, device decisions, provenance, and the immutable completion result. Reconcile only memberships owned by this guided-setup provenance: insert or retain setup-managed `reviewed_active` memberships for active identities owning at least one final `included` device and revoke obsolete setup-managed memberships. Preserve explicit invitation-provenance memberships even when they currently have only unresolved or no roster decisions. Retire confirmed removed or disabled roster-device decisions in the same transaction. If completion insertion loses a uniqueness race, load and replay the winner only after verifying its stored candidate reference matches the validated route candidate; otherwise fail closed rather than returning another candidate's result.
6. Apply each changed assignment before writing its Team decision, read the resulting canonical `assignment_version`, and persist that post-write version on the final decision row. Never copy the draft's pre-write expected version into an `included` decision.
7. Store and replay the completed finish result only when the proposed identities and every other canonical write input match the completed digest.
8. Remove unresolved legacy Team candidates from recipient selection and reject stale resolutions that target them.
9. Leave all `project_recipients` rows unchanged; do not treat row stability as proof that effective access is unchanged.
10. When a consumed invite adds a person to a reviewed Team, store an invitation-provenance `reviewed_active` membership, create unresolved decisions for that person's active roster devices, and return the Team to **Needs setup** without granting a device. Preserve that explicit membership through later setup even when the invitee has no roster device; membership alone never grants eligibility.
11. Add a constrained adoption path for canonical Teams already materialized by historical `choose_recipients`: require exact deterministic identity, provenance, source fingerprint, saved-resolution linkage, memberships, and recipient-edge validation; preserve all existing edges and include every resulting effective-access change in review. Never adopt an arbitrary or partially matching Team.

**Acceptance:**

- Incomplete, stale, conflicting, or unavailable drafts make no canonical changes.
- Any failed write rolls back assignments, Team, memberships, decisions, and completion state.
- Reassignment immediately makes the device ineligible for every affected reviewed Team.
- Reconfirming an unchanged canonical assignment preserves its version, reviewed decisions, Team readiness, and effective access.
- Finishing reconciles setup-managed memberships to exactly the identities represented by final included devices; excluding, removing, or reassigning a person's last included device revokes that obsolete setup-managed membership atomically, while explicit invitation memberships remain.
- Every access addition or removal caused by assignments, mode conversion, memberships, decisions, or preserved recipient edges is shown and explicitly confirmed before finish; an unconfirmed change is not written.
- A newly assigned included device is immediately eligible after finish because its decision stores the canonical post-write assignment version.
- Two overlapping Teams reuse one confirmed global assignment.
- A device absent when the draft was created conflicts if enrollment maintenance binds it before finish.
- A consumed invite on a reviewed Team creates reviewed membership plus unresolved decisions for active roster devices, returns the Team to **Needs setup**, and grants no device until review.
- The same canonical reviewed Team can complete setup repeatedly after reassignment, roster growth, or invitation changes without recreating the Team or dropping its recipient edges.
- A compatible Team previously materialized by `choose_recipients` is adopted without dropping its existing recipient edges; incompatible or ambiguous legacy rows fail closed.
- Finish retries through the same candidate route return the original completed result; another candidate route cannot replay it.
- Existing sharing rows are byte-for-byte unchanged. Effective access is unchanged before finish and every change afterward is present in the explicitly confirmed complete access delta.

**Validate:**

```fish
pnpm --filter @codemem/core run generate:test-schema
pnpm exec vitest run packages/core/src/test-schema.generated.test.ts packages/core/src/identity-device-assignment.test.ts packages/core/src/legacy-team-setup-activation.test.ts packages/core/src/coordinator-enrollment-reconciler.test.ts packages/core/src/recipient-policy-contract.test.ts packages/core/src/recipient-policy-migration.test.ts packages/core/src/recipient-policy-onboarding.test.ts packages/core/src/recipient-policy-review.test.ts packages/core/src/recipient-policy-reconciliation.test.ts
pnpm run tsc
pnpm run lint
```

### PR 4: Add bounded viewer API

**Purpose:** Expose setup operations without leaking coordinator or database details.

**Files:**

- `packages/viewer-server/src/routes/team-setup.ts` (new)
- `packages/viewer-server/src/index.ts`
- `packages/viewer-server/src/index.test.ts`
- `packages/core/src/index.ts`

**Endpoints:**

- `GET /api/sync/team-setup/v1`
- `GET /api/sync/team-setup/v1/:candidateRef`
- `PUT /api/sync/team-setup/v1/:candidateRef/devices/:deviceRef/assignment`
- `PUT /api/sync/team-setup/v1/:candidateRef/devices/:deviceRef/decision`
- `DELETE /api/sync/team-setup/v1/:candidateRef/devices/:deviceRef/decision`
- `POST /api/sync/team-setup/v1/:candidateRef/refresh`
- `POST /api/sync/team-setup/v1/:candidateRef/finish`

**Work:**

1. Register a focused route module under the existing same-origin guard.
2. Validate opaque references and bounded JSON bodies at the boundary.
3. Map domain failures to the seven approved stable error codes and appropriate 400/404/409/503 statuses. Validate the opaque `:candidateRef`, then perform an optimistic immutable-completion lookup constrained by that candidate reference before entering activation; repeat the candidate-constrained lookup after acquiring the `BEGIN IMMEDIATE` lock. An exact completed retry for that route candidate replays its stored result before roster, assignment, or confirmation validation. Completion tokens belonging to another candidate never replay and instead follow the normal bounded candidate/request validation path. Otherwise validate fresh roster state and assignment compare-and-set evidence before comparing confirmation tokens so `team_setup_roster_changed` and `team_setup_assignment_changed` take precedence. Use `team_setup_confirmation_stale` with HTTP 409 when the attempt, finish, or access-delta confirmation token is missing or no longer matches the current detail representation. A completion-record uniqueness race replays the committed winner only when its immutable candidate reference matches the validated route candidate.
4. Return server-derived `can_finish`, unresolved counts, conflict state, and safe evidence labels.
5. The detail response returns the complete server-derived access delta across every transaction cause as bounded additions and removals plus `access_delta_digest`, opaque `attempt_id`, and `finish_digest`. The finish request must submit the same `attempt_id`, `finish_digest`, and `confirmed_access_delta_digest`; absence or mismatch returns `team_setup_confirmation_stale` with HTTP 409 and performs no writes. Empty deltas still have a deterministic digest, so confirmation is bound to one exact server representation.
6. Redact coordinator URLs, raw group/device IDs, public keys, paths, SQL text, and exception messages.
7. Make an exact `(candidate_ref, attempt_id, finish_digest)` retry return its immutable stored successful representation, including after later setup attempts or Team changes. Never replay that representation through a different candidate route.

**Acceptance:**

- Malformed and stale requests receive bounded errors.
- No response or diagnostic contains prohibited values.
- Unknown failures return `team_setup_failed` and no raw message.
- Detail and finish contracts bind confirmation to the exact server-derived access delta; stale, missing, or mismatched digests cannot finish.
- Concurrent identical finish requests converge on one completion record and return the same immutable response; the loser never reports a canonical-state conflict.
- Reusing candidate A's valid completion tokens on candidate B's finish route never returns candidate A's completion response.
- Route inventory and same-origin tests include the new module.

**Validate:**

```fish
pnpm exec vitest run packages/viewer-server/src/index.test.ts
pnpm --filter @codemem/server run typecheck
pnpm run lint
```

### PR 5: Add the guided Sharing UI

**Purpose:** Provide the approved three-step, resumable setup experience.

**Files:**

- `packages/ui/src/lib/api/sync.ts`
- `packages/ui/src/lib/api/sync.test.ts`
- `packages/ui/src/lib/api.ts`
- `packages/ui/src/app-sharing.ts`
- `packages/ui/src/tabs/recipient-policy-sharing.tsx`
- `packages/ui/src/tabs/recipient-policy-sharing.test.tsx`
- `packages/ui/src/tabs/projects.ts`
- `packages/ui/src/tabs/projects.test.ts`
- `packages/ui/src/tabs/legacy-team-setup.tsx` (new)
- `packages/ui/src/tabs/legacy-team-setup.test.tsx` (new)
- `packages/ui/static/index.html`

**Work:**

1. Add typed API wrappers using the existing JSON/error helpers.
2. Load setup summaries with Sharing state and refresh both after activation.
3. Add the overview notice, status badges, and **Continue setup** entry point.
4. Replace the legacy Team candidate dead end in Projects with plain-language copy and a link into guided setup.
5. Implement the three-step dialog using existing Radix dialog and radio-group primitives.
6. Persist every decision immediately; keep only transient navigation and busy state in the component.
7. Keep suggestions unselected until explicit confirmation.
8. Render stable recovery copy for roster and assignment conflicts.
9. Render reviewed-Team eligible-device counts and labels only from server-derived eligibility fields; do not infer them from roster membership or client-side decisions.
10. Use reviewed-Team future-member copy that explains that membership alone does not make every device eligible and that only reviewed, included devices receive Team sharing.
11. Show that exclusion affects only this Team and does not suppress other sharing paths.
12. Render the complete server-derived Project/device access delta in Step 3 exactly as returned by the detail response, separating additions from removals and covering assignments, Team-mode conversion, membership reconciliation, final decisions, and preserved recipient edges. Disable **Finish Team setup** until the user explicitly confirms that displayed delta; never derive, filter, or summarize it client-side. Render an explicit no-access-changes state for an empty delta and still confirm its digest.
13. Add semantic headings, `aria-current`, fieldsets/legends, status/alert live regions, focus restoration, first-error focus, keyboard operation, and `aria-busy`.
14. Add styles only to UI source assets; never edit generated viewer-server static files.

**Acceptance:**

- Progress survives reload.
- Finish remains disabled while the server reports unresolved devices.
- Reviewed-Team device counts and eligibility labels exactly match server-derived values, including empty and mixed-decision states.
- Reviewed-Team future-member copy does not claim normal person-level device inheritance; it states that only reviewed, included devices become eligible.
- Whenever the server reports any access addition or removal—from assignments, mode conversion, membership reconciliation, decisions, or preserved recipient edges—Step 3 shows the complete server-derived additions and removals and requires explicit confirmation before finish.
- A finish with no assignment write still displays and confirms access changes caused by mode conversion, setup-managed membership revocation, decisions, or adopted recipient edges.
- An empty server-derived access delta is displayed explicitly and its digest is still confirmed.
- All steps are keyboard and screen-reader operable.
- User copy contains none of the prohibited internal terms or identifiers.
- Finishing closes the dialog, restores focus, and displays the ready Team.

**Validate:**

```fish
pnpm exec vitest run packages/ui/src/lib/api/sync.test.ts packages/ui/src/tabs/projects.test.ts packages/ui/src/tabs/recipient-policy-sharing.test.tsx packages/ui/src/tabs/legacy-team-setup.test.tsx
pnpm --filter @codemem/ui run typecheck
pnpm --filter @codemem/ui build
pnpm run lint
```

### PR 6: Add overlapping-Team E2E coverage and user docs

**Purpose:** Prove the end-to-end safety boundary and document the user-visible behavior.

**Files:**

- `e2e/scenarios/legacy-team-setup.ts` (new)
- `e2e/scripts/legacy-team-setup-smoke.ts` (new, if a dedicated runner is clearer)
- `e2e/lib/coordinator.ts`
- `e2e/bin/run-local.ts`
- `package.json`
- `README.md`
- affected Sharing documentation under `docs/`

**Scenario:**

1. Discover two overlapping pre-identity groups.
2. Confirm one shared device assignment once and reuse it in both drafts.
3. Exclude a second device from one Team only.
4. Assert current sharing is unchanged before each finish.
5. Finish both Teams and verify memberships and path-specific device eligibility.
6. Add an off-roster device to an included person and verify it remains ineligible.
7. Add a roster device mid-draft and verify finish returns `team_setup_roster_changed`.
8. Reassign an included device and verify it immediately becomes unresolved and ineligible.
9. Simulate a lost finish response and verify retry returns the same completed result.

Register the scenario in the static E2E runner and add a dedicated `e2e:legacy-team-setup` root script. The scenario is not complete unless the validation command invokes that registry entry.

**Validate:**

```fish
set -lx CODEMEM_E2E_BUILD 1
set -lx CODEMEM_E2E_JSON 1
pnpm run e2e:legacy-team-setup -- --json
pnpm run check
pnpm run build
```

## Final quality gates

Before submitting the complete stack:

1. Run `pnpm run tsc && pnpm run lint && pnpm run test`.
2. Run `pnpm run build` so viewer assets are generated and staged correctly.
3. Run `pnpm run e2e:legacy-team-setup -- --json` with `CODEMEM_E2E_BUILD=1` and `CODEMEM_E2E_JSON=1`.
4. Inspect `git status --short --branch`; generated `packages/viewer-server/static/` content must remain ignored.
5. Review every PR for accidental coordinator identifiers, URLs, key material, local paths, or raw error messages.
6. Use a security-focused CodeReviewer on PRs 1, 3, and 4, and an accessibility review on PR 5.

## Rollback behavior

- The delivered eligibility foundation is active fail-closed authorization code.
  Existing `person_all_devices` Teams retain their current expansion behavior;
  guided activation remains unavailable until the remaining setup PRs land.
- Disabling the UI or API leaves drafts intact and leaves current sharing unchanged.
- A completed `reviewed_allowlist` Team must not be downgraded to `person_all_devices` during rollback. Its `reviewed_active` membership status is an explicit downgrade sentinel: older runtimes reject the unknown status and block derivation rather than expanding person-wide.
- Data repair must use forward migrations; do not delete drafts, decisions, assignments, memberships, or Teams automatically.
