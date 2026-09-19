# Canonical Viewer Workflow Ownership Design

The viewer will give each routine task one editable home: Sharing owns access policy, Devices owns device identity and pairing, Health owns operational recovery, Projects owns migration review, and Advanced owns diagnostics, operator administration, and compatibility.

## Decision

Strict canonical ownership removes contradictory controls without changing authorization, reconciliation, presence, trust, or transport semantics.

- Sharing is the only routine editor for Team and Identity recipients, invitations, and Project access.
- Devices is the only editor for pairing, naming, removal, and Identity binding or rebinding.
- Health owns retries, immediate sync, restart guidance, stale or offline recovery, and repair commands.
- Projects owns actionable migration decisions and blocked legacy-source repair.
- Advanced keeps read-only technical summaries, diagnostics, destructive expert controls, coordinator administration, and compatibility.
- Other tabs may show a short read-only status and a focused link to the owner. They must not duplicate a mutation.

Connection state and access state remain independent. An active Team can coexist with a Project reconciliation failure, and an offline device can retain valid access without being eligible for pairing or review.

## Current-to-Target Ownership

The target map moves mutations rather than cloning handlers or inventing parallel state.

| Current surface | Current responsibilities | Classification | Canonical target | Disposition |
| --- | --- | --- | --- | --- |
| Sharing | Teams, Identities, received Projects, invitations, Project-access mutations, Team settings, legacy setup, device and reconciliation notices | Routine access policy plus misplaced migration and device state | Sharing | Keep recipient and invitation mutations. Link device setup to Devices. Move legacy migration entry to Projects. |
| Devices | Active and revoked devices, owner Identity, availability, pairing, naming, removal, Identity setup, access summaries, health links | Device management plus read-only access and health summaries | Devices | Keep device and Identity mutations. Route access edits to Sharing and recovery to Health. |
| Health | Overall health, offline peers, stale sync, maintenance failures, immediate sync, recommendations, diagnostics link | Health and operational repair | Health | Keep retries, restart guidance, immediate sync, and recovery. Route deep evidence to Advanced diagnostics. |
| Advanced Sync | Sync status, sync now, invites, pairing, Identity controls, peer mutation, Space/access summaries, rules, legacy claims, diagnostics, attempts | Mixed routine, health, diagnostics, and compatibility | Sharing, Devices, Health, or Advanced by task | Remove routine mutations. Keep read-only technical summaries, diagnostics, compatibility, and justified expert controls. |
| Coordinator Administration | Older groups, Spaces, grants, enrollment, join requests, invites, defaults, recovery, raw IDs | Operator administration and legacy compatibility | Advanced → Coordinator Administration | Keep older coordinator-group and Space administration. Do not make it the routine Team or Project-access editor. |
| Projects | Inventory, recipient chips and mutations, relationship state, migration review, blocked repair | Inventory, duplicate access editing, migration repair | Projects for inventory and migration; Sharing for policy | Replace recipient mutations with focused Sharing links. Keep migration decisions and blocked-source repair. |
| Legacy Team setup | Ownership decisions, Project mapping, review, finish, retry, unavailable and item errors | Migration compatibility | Projects → Migration review | Launch only from the affected migration item. Remove routine Team-setup entry points elsewhere. |
| Preserved legacy history | Claims, attach-device history, continuity notices, old delivery projections | Audit history | Backend audit record; optional Advanced diagnostics | Remove normal-page notices and actions. On explicit inspection, label the record historical. |

## State Ownership

Every visible state must name the operation it affects instead of collapsing unrelated evidence into “access.”

### Connection state

Devices shows per-device online, offline, stale-presence, pairing, trust, and last-seen state. Health owns recovery from daemon, delivery, sync, and maintenance failures. Advanced diagnostics shows technical evidence and attempts.

Connection state does not imply access. An offline device remains in inventory and may retain current policy, but actions that require fresh presence stay unavailable.

### Access state

Sharing shows current Team and Identity recipient intent, invitations, Project policy, and enforcement reconciliation. Projects shows only migration decisions where older source evidence cannot yet be interpreted safely.

Active membership does not prove device delivery eligibility. Unknown eligibility must remain unknown rather than becoming “No access.”

### Preserved continuity

Preserved legacy continuity is backend audit data, not a current recipient, grant, warning, or action. It produces no normal-page notice.

An explicit audit view may show: `Historical record only — this does not describe current access.`

## Exact State Copy and Actions

State copy names the affected task, separates access from transport, and offers only an action owned by the current page.

| State | Required copy | Canonical action |
| --- | --- | --- |
| Actionable access review | `Project access update needs review.` Name the affected Project and safe failure reason when available. | `Review access` opens the focused Sharing target. |
| Blocked migration repair | `Access has not changed. Repair this source record before Codemem can interpret its older sharing state.` | Use the specific repair label in Projects. |
| Offline or stale device | `Offline — this device’s coordinator presence has expired. Pairing is unavailable until it checks in again.` | No pairing or review action. Optional `Check device health` opens Health. |
| Unknown Team eligibility | `Team delivery eligibility is unavailable. Current Team membership does not confirm that this device receives the Team’s Projects.` | Refresh the owning surface; never show `No access`. |
| Sync failure | `Sync failed for {device or Project}. Access settings are unchanged.` | `Retry sync` in Health; `View diagnostics` opens Advanced. |
| Stale snapshot | `Showing information from the last successful refresh.` | Keep cached content visible and disable mutations until fresh data loads. |
| Missing owner evidence | `Device ownership information is unavailable. Refresh Devices before changing Identity setup.` | `Refresh Devices`. |
| Preserved history | No normal-page copy. | Explicit audit inspection only. |

Errors state what happened and the next useful action. They include a cause only when the backend returns a safe, actionable reason.

## Canonical Routes and Focus

Canonical hashes identify the owning task and include stable encoded identifiers only when a specific item must receive focus.

| Task | Canonical hash | Focus target and fallback |
| --- | --- | --- |
| Routine recipient policy | `#sharing` | Affected Team, Identity, or Project management heading; then `#sharing-heading`. |
| Affected Project access | `#sharing/project/<encoded-project-id>` | Project management dialog heading; then Sharing heading. |
| Device inventory and setup | `#devices` | `#devices-heading`. |
| Specific device | `#devices/device/<encoded-device-id>` | Device card; then review heading; then Devices heading. |
| Operational recovery | `#health` or `#health/device/<encoded-device-id>` | Affected recommendation; then Health heading. |
| Migration review | `#projects/sharing-review/<encoded-review-id>` | Review group or blocked repair; then `#recipientPolicyReviewTitle`. |
| Advanced sync summary | `#advanced/sync` | Advanced Sync heading. |
| Diagnostics | `#advanced/sync/diagnostics` | Sync diagnostics heading. |
| Legacy operator administration | `#advanced/teams` | Legacy notice; then administration heading. |
| Legacy Team migration | `#projects/legacy-team/<encoded-candidate-ref>` | Dialog title; then first unresolved item. |

Route handling waits for the owner’s content before moving focus. If the target no longer exists, focus moves to the page heading and a polite status explains that the item is no longer available.

## Compatibility Redirects

Old bookmarks remain usable, but the address bar changes to the canonical owner with `history.replaceState`.

- `#sync` redirects to `#advanced/sync`.
- `#sync/diagnostics` redirects to `#advanced/sync/diagnostics`.
- `#coordinator-admin` redirects to `#advanced/teams`.
- Old access-edit links under Sync or Teams redirect to the focused Sharing target.
- Old device-review or pairing links under Sync redirect to the focused Devices target.
- Old legacy setup entry points redirect to the focused Projects migration item.

Redirects preserve only safe identifiers needed for focus. They do not preserve an obsolete tab as a second owner.

## Loading, Empty, Stale, and Failure Behavior

Each owner distinguishes absent data from data that has not loaded or cannot refresh.

- Loading keeps the heading and focus target mounted, renders the owner’s skeleton, and never flashes an empty state.
- Empty states state what is absent and offer only an owner action: `No active devices are registered.`, `No Projects are shared.`, or `No migration findings need review.`
- A refresh failure with cached data keeps the snapshot visible, shows the stale copy, disables mutations, and preserves navigation and focus.
- An initial-load failure replaces the body with owner-specific unavailable copy and a `Refresh` action.
- A partial failure keeps successful sections visible and marks only the missing evidence unavailable.
- Offline devices remain inventory rows. Offline state alone does not create an attention item.
- Projects hides the migration-review card when no actionable or repairable findings remain.

Mutation controls stay disabled while their required owner data is stale or unavailable. Read-only navigation remains available.

## Interaction and Layout

Cross-tab links behave as navigation, while controls on the canonical owner remain normal buttons and form controls.

- After navigation, focus moves to the named target without scrolling the tab bar away from view.
- Keyboard order follows heading, status, primary action, then detail controls.
- A routed target receives a temporary non-color highlight; reduced-motion mode removes its transition.
- At 755 px, actions stack below state copy, hashes never cause horizontal scrolling, and long device or Project labels wrap before controls.
- Screen-reader names include the affected device, Project, Team, or Identity when the visible label is generic.
- Cached stale content remains readable but mutation controls expose why they are disabled.

## Advanced Boundary

Advanced remains useful by owning technical and operator work rather than serving as a second route to routine tasks.

Advanced keeps:

- read-only sync, Space-access, filter, and transport summaries;
- recent attempts, redacted diagnostics, and technical history;
- destructive expert controls with existing authorization and confirmation;
- older coordinator-group and Space administration;
- explicit compatibility and audit inspection.

Advanced removes or routes away:

- routine Team and Identity invitations;
- routine Project-access editing;
- normal device pairing, naming, removal, and Identity binding;
- ordinary retry and immediate-sync recovery;
- preserved-history notices on the normal page.

## Relationship to Existing Access Work

This design reuses terminology and technical summaries from `codemem-00dc.10` and `.11` while superseding their ownership where they conflict with one canonical editor.

- Reuse from `.10`: Space terminology, raw-ID demotion, operator-only Space grants, and advanced-filter narrowing below Space access.
- Supersede from `.10`: Coordinator Administration is not the primary routine access surface; Sharing owns current Team and Identity Project policy.
- Reuse from `.11`: Advanced Sync keeps read-only Space-access and advanced-filter summaries and routes edits away from Sync.
- Supersede from `.11`: policy edits route to Sharing and device or Identity edits route to Devices, not generically to Teams.
- Out of scope: grant semantics, default-Space creation, reconciliation authority, presence expiry, trust checks, and transport behavior.

## Implementation Slices

The rollout should move one ownership boundary at a time while reusing current handlers and state.

1. Add canonical hash parsing, redirects, stable focus targets, and route tests.
2. Make Sharing the sole recipient-policy editor and replace Projects mutations with focused links.
3. Move pairing, peer mutation, and Identity setup from Advanced Sync to Devices.
4. Move operational retries and immediate sync to Health while preserving Advanced diagnostics.
5. Move legacy Team setup entry points to Projects migration review.
6. Reduce Advanced to summaries, diagnostics, operator controls, and compatibility.
7. Remove preserved-history notices from normal pages and retain explicit audit access.
8. Update README and user documentation with the final task locations.

Each slice removes the old mutation in the same change that exposes the canonical action. No slice may leave two active mutation entry points.

## Validation

Tests must prove ownership, state separation, compatibility, and recovery without changing backend policy.

- Every routine mutation appears on exactly one visible canonical tab.
- Connection failures never rewrite access state, and access failures never claim that a device is offline.
- Offline or stale devices expose no unavailable pairing or review action.
- Unknown Team eligibility never renders as `No access`.
- Preserved-only continuity creates no normal-page notice or action.
- Old hashes redirect with `replaceState`, open the correct owner, and focus the named target or fallback.
- Loading, empty, cached-stale, initial failure, and partial-failure fixtures remain distinct.
- Focus survives refresh; redirected focus works by keyboard and screen reader.
- Desktop and 755 px layouts keep copy, actions, and hashes readable without overflow.
- Existing authorization, recipient-policy, coordinator, trust, and sync contracts remain unchanged.
