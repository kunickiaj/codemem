# Project-first teammate sharing design

**Date:** 2026-07-20
**Status:** Approved
**Related:** `codemem-00dc`, `2026-05-25-access-management-ia-design.md`, `2026-05-22-team-space-sharing-ux-design.md`

## Decision summary

Codemem will replace the current multi-surface teammate setup with one project-first operation:

> Choose who to share with, choose projects, review the exact data, send one invite, and start syncing when the recipient accepts.

The common flow must not require users to create a Person, rename a UUID, assign that Person to the device, pair the device, grant Spaces, map projects, or interpret per-Space cursors as separate setup tasks.

The existing Space authorization model remains the hard security boundary underneath the experience. Codemem will orchestrate it through a persisted, resumable sharing operation rather than exposing each internal gate as a user workflow.

## Problem

The current experience exposes implementation state without explaining the required action. A device can be enrolled, discovered, paired, assigned to a Person, granted coordinator-side access, missing local authorization cache state, and still sync no records. The UI presents these independent states together and makes unrelated controls look causal.

The reported device drawer demonstrates the failure:

- `Pending` means a Space has not completed its first receive, not that approval is pending.
- `Save assignment` changes who the device belongs to; it cannot grant access or start replication.
- `Manage Spaces in Teams` loses the device and recovery context.
- A heuristic warning asks users to check work/client-like access even when the intended access is unknown.
- New devices can appear as UUIDs because pairing payloads carry no friendly-name hint.
- Person creation and device assignment are separate manual operations even when the invite already identifies the teammate.

This is not primarily a copy problem. The product lacks one operation representing the user's intent.

## Experience contract

The following decisions are approved:

1. **One bundled invite.** Team enrollment, device trust, project access, identity linking, and initial sync are one resumable setup operation.
2. **Projects are the selection object.** Users select projects, not Spaces or filters.
3. **Exact sharing.** Selecting one project never grants access to unrelated projects in its current Space.
4. **Identity comes from the invite.** The inviter names the teammate. Acceptance creates or links that Person automatically.
5. **Devices send friendly hints.** Acceptance proposes a human-readable device name such as `Brian's MacBook`; UUIDs remain in diagnostics.
6. **Existing and future memories are shared.** Confirmation states the existing memory count and that future activity will also sync.
7. **One state, one action.** Every incomplete state names what is happening or what failed and offers one primary next action.

## User-facing model

Users need four concepts:

| Concept | Meaning |
| --- | --- |
| Person | A teammate, such as Brian. |
| Device | A machine belonging to a Person, such as Brian's MacBook. |
| Project | The unit the user chooses to share. |
| Sync status | Whether the invitation, setup, and replication are progressing. |

Spaces remain visible only in advanced access details and diagnostics. Coordinator groups, scope memberships, membership epochs, peer fingerprints, and replication cursors are not primary product language.

## Primary flow

### Entry points

- Projects: `Share` on a project row or project detail.
- Projects: multi-select followed by `Share projects`.
- Sync: `Share projects`, opening the same flow.

There are not separate normal-user flows for inviting, pairing, assigning a Person, and granting access.

### Step 1: Choose a teammate

```text
Share projects

Who are you sharing with?
[ Brian                              ]
```

If a matching active Person exists, the UI offers that Person instead of silently creating a duplicate. A new name creates a pending Person associated with the sharing operation.

### Step 2: Choose projects

```text
Select projects

[x] codemem          436 existing memories
[x] codemem-site      82 existing memories
[ ] private-notes    Private
```

Projects are resolved by canonical workspace identity. Basenames are display labels, not security identities. Ambiguous worktrees require review before the invite can be created.

### Step 3: Confirm exact access

```text
Share with Brian

Brian will receive:
• 436 existing memories and future activity from codemem
• 82 existing memories and future activity from codemem-site

No other projects will be shared.

[Create invite]
```

The confirmation is the security review. Advanced details may show the managed Spaces and project mappings, but understanding them is not required.

### Step 4: Wait for acceptance

```text
Brian
Invitation sent · expires in 7 days

Sharing after acceptance: codemem, codemem-site

[Copy invite]  [Cancel invitation]
```

The invitation is single-use, expiring, and pre-authorized only for the selected projects. Acceptance replaces a separate administrator approval step.

The coordinator is authoritative for invite consumption. It stores a digest of the bearer token and atomically compares-and-swaps the operation from `waiting_for_acceptance` to `accepted` while binding the first accepting device ID and public-key fingerprint. A retry from the same bound device and key with the same operation ID returns the existing acceptance result. Any second device or different key is rejected with a stable reason such as `invite_already_bound`; expired and invalid tokens return `invite_expired` and `invite_invalid`. The reviewed project set is loaded from the coordinator-side operation and is never accepted from recipient-controlled input.

This is a bearer-token trust model: possession authorizes the first device to bind, so invite entropy, expiry, and careful delivery matter. Its blast radius is limited to the exact reviewed project set.

### Recipient acceptance

```text
Adam invited you to share 2 projects

Your name
[ Brian                 ]

This device
[ Brian's MacBook       ]

[Accept and start syncing]
```

The recipient may correct both suggestions before accepting. The device name uses this precedence:

1. explicit local Codemem device name;
2. OS computer name or hostname, normalized for display;
3. coordinator-provided display name;
4. short generated fallback;
5. raw UUID in advanced diagnostics only.

### Active state

```text
Brian
└─ Brian's MacBook

Sharing: codemem, codemem-site
Status: Up to date · synced 2 minutes ago
```

Person and device names are editable corrections. Creating a Person and assigning the device are not onboarding tasks.

## Lifecycle and status language

A persisted sharing operation owns the visible state:

| Internal lifecycle | User-facing status | Primary action |
| --- | --- | --- |
| `waiting_for_acceptance` | Waiting for Brian to accept | Copy invite |
| `accepted` / `provisioning` | Setting up project access | None while progressing |
| `initial_sync` | Starting first sync | None while progressing |
| `waiting_for_device` | Waiting for Brian's device | None; this is not an error |
| `active` | Up to date | None |
| `needs_attention` | Exact failed step in plain language | Retry setup |
| `revoking` | Removing future access | None while progressing |
| `revoked` | Access removed · previously copied memories may remain | Share again |
| `cancelled` | Invitation cancelled | Create new invite |

The primary UI must not use bare `Pending` or `Received` labels. Per-Space progress belongs in diagnostics and may use precise cursor terminology there.

A provisioning step remains passive only while it has no explicit failure and is within its deadline and retry budget. A non-device step that exceeds 10 minutes or three failed attempts becomes `needs_attention`. A recipient device that is simply offline remains `waiting_for_device`, shows its last-seen time when known, and does not become an error solely because time passed.

## Orchestration model

The operation spans local and coordinator state, so it cannot be an ACID transaction. Implement it as an idempotent, persisted saga.

Conceptual operation data:

```text
ShareOperation
├─ operation ID
├─ inviter identity and explicitly derived participating devices
├─ pending or existing Person
├─ canonical project identities
├─ existing-memory counts captured for confirmation
├─ existing-and-future sharing policy
├─ single-use invite digest and expiry
├─ reviewed project-set digest
├─ recipient identity, device, and public-key binding after acceptance
├─ current lifecycle state
├─ per-step completion markers and attempt counts
├─ revocation state
└─ last actionable failure
```

### Idempotency contract

Every durable effect has a deterministic identity derived from the immutable operation ID:

| Effect | Idempotency identity |
| --- | --- |
| Pending Person | persisted `person_id` plus unique `pending_person_operation_id` |
| Invite consume | unique operation ID plus token digest; atomic binding to device ID and key fingerprint |
| Managed project boundary | deterministic hash of canonical project identity under the owning Team |
| Person/device link | operation ID plus recipient device ID |
| Space grant | existing unique coordinator, Space, device, and membership-epoch identity |
| Memory reassignment | operation ID plus memory ID plus target Space ID |
| Project assignment | operation ID plus canonical workspace identity plus target Space ID |
| Initial sync job | operation ID plus recipient device ID |

Each step records `pending`, `running`, `completed`, or `failed`, its deterministic effect identity, attempt count, timestamps, and a safe error code. Retry first verifies an existing completed effect, then continues from the first incomplete step. It never creates a replacement Person, boundary, grant, reassignment, mapping, or sync job merely because a response was lost.

### Preparation

Before creating the invite, Codemem:

1. resolves canonical project identities;
2. detects collisions and unsupported legacy state;
3. counts existing memories;
4. creates or links the pending Person;
5. plans managed project-specific sharing boundaries;
6. records the exact reviewed access set;
7. creates the single-use invite.

### Acceptance and provisioning

Acceptance submits the recipient's device ID, public key, addresses, friendly-name hint, actor identity, and confirmed display name. The existing coordinator bootstrap-grant path establishes reciprocal trust; project-first invitations extend its bound metadata rather than inventing a second pairing protocol. Manual pairing remains a legacy compatibility path and does not gain project access by itself.

Codemem then idempotently:

1. atomically consumes and binds the invite to the accepting device and public key;
2. links the supplied actor identity to the pending Person;
3. registers the friendly device name;
4. establishes reciprocal device trust through the coordinator bootstrap grant;
5. creates or reuses one managed authorization boundary per selected project;
6. grants only the reviewed participating inviter devices and the bound recipient device;
7. reassigns existing selected-project memories to those boundaries;
8. writes future project assignments;
9. refreshes local authorization state immediately;
10. starts and observes the initial sync.

One managed boundary per project preserves exact sharing when audiences diverge later. The UI may group these boundaries for display but must not broaden access by grouping unrelated projects.

### Bounded device membership

Boundary creation never copies the full member list from the source Space. The participating inviter-device set contains:

1. the initiating device; and
2. existing inviter devices that already had effective access to the selected project through both source-Space membership and current project filters.

Carrying those devices forward preserves existing project access without granting the project to a device that could not previously receive it. The confirmation summarizes additional owner devices that retain access. If effective project access cannot be derived unambiguously, invite creation stops for explicit review. The accepting device is the only new recipient added by the invite.

### Existing-memory reassignment

Moving an existing memory to a managed project boundary is a scope reassignment, not a local label edit.

- A memory proven never to have been replication-eligible may be reassigned in one local transaction that updates its Space and emits the normal upsert for the new Space.
- A memory that may have replicated uses a new additive `reassign_scope` replication operation keyed by operation ID, memory ID, old Space, and new Space.
- Applying `reassign_scope` is transactional and idempotent: an old-Space tombstone and new-Space upsert share one logical reassignment revision. Receivers apply whichever side they are authorized to observe without exposing the other Space's data.
- Project-first history sharing requires negotiated `reassign_scope` capability on participating owner devices. If a required device lacks support, provisioning fails closed with `reassign_capability_required` and the UI asks the user to update that device before retrying.
- Reassignment never claims to recall copies held by previously authorized devices. Revocation and confirmation copy retain that warning.

The implementation must define the additive wire payload and capability negotiation before enabling this step. Older peers continue syncing existing operation types; they do not receive or partially apply unsupported reassignment operations.

## Failure recovery

Every step is idempotent and retryable. Retrying must not duplicate People, devices, grants, project mappings, or replication operations.

Rules:

- Do not report the operation as connected or active until all required setup steps succeed.
- A failed step must fail closed and never broaden project access.
- Preserve completed safe steps and resume from the first incomplete step.
- Show one plain-language cause and one primary action.
- Keep technical errors, raw IDs, and per-step traces in diagnostics.
- Cancelling an unused invite removes pending access and leaves existing project placement unchanged where possible.
- Revocation transitions `active` → `revoking` → `revoked`, revokes future Space access, and explicitly states that memories already copied to another device may remain there.

Examples:

```text
Brian accepted the invitation
Project access could not be completed

[Retry setup]
```

```text
Brian's MacBook is offline
Sync will continue when the device reconnects
```

Offline is informational unless the user must repair trust or configuration.

## Surface responsibilities

### Projects

- Own project selection and `Share` actions.
- Show who each project is shared with.
- Show existing-memory counts before sharing.
- Own adding or removing projects from a Person's sharing set.

### Sync

- Show People with devices nested underneath.
- Show invitation, provisioning, connectivity, and replication health.
- Offer retry or repair actions.
- Show a read-only project-sharing summary.
- Keep Space, filter, cursor, and address detail under diagnostics.

### Teams

- Remain the advanced administration surface for invites, devices, managed Spaces, grants, and revocation.
- Reflect project-first operations without requiring users to reconstruct them.
- Do not compete with Projects as the normal sharing entry point.

## Current UI removals

The implementation must remove or demote these patterns from the normal path:

- bare `Pending` per-Space badges;
- `Save assignment` beside sync/access recovery;
- manual `Create person` as a prerequisite for teammate setup;
- raw UUID as a default device label;
- `Review Space fit` heuristics that cannot name the intended project access;
- generic `Manage Spaces in Teams` links that discard Person, device, and operation context;
- repeated explanatory wallpaper about Spaces and filters.

Manual identity correction and Space administration remain available in advanced management.

## Compatibility and migration

- Continue parsing existing coordinator invitations and pairing payloads.
- Old invitations without project intent use the legacy enrollment path and are clearly labeled as not granting project access.
- Existing People and device assignments remain valid and can be linked to new sharing operations.
- Existing multi-project Spaces are not silently split. A share operation creates managed project-specific boundaries only for selected projects after confirmation.
- Existing copied data is never represented as recalled after revocation or remapping.

## Security constraints

- Invite tokens are high-entropy, single-use, scoped to reviewed project identities, and expire.
- The coordinator atomically binds first acceptance to one device identity and public-key fingerprint; only an identical retry is idempotently accepted.
- The server loads the reviewed project set from persisted operation state; recipient input cannot add or replace projects.
- Friendly names and Person names are untrusted display strings and must be normalized, escaped, and length-limited.
- Canonical project identity, not display name, determines the authorization plan.
- Managed-boundary membership contains only reviewed or provably access-preserving inviter devices plus the bound recipient device; it never inherits a source Space member list.
- The recipient cannot add projects or broaden the reviewed access set during acceptance.
- Project assignment and advanced filters never substitute for authorization grants.
- Diagnostics must not expose secrets, raw memory payloads, or private network details by default.

## Validation strategy

Use two isolated local nodes; Brian's separate machine is not required.

### Unit and component coverage

- sharing-operation lifecycle derivation;
- canonical project selection and collision handling;
- exact project-to-managed-boundary planning;
- friendly device-name precedence;
- existing Person matching without silent merges;
- status and single-action rendering;
- idempotent retry planning;
- legacy invitation compatibility.

### API and integration coverage

- create an invite containing Person and exact project intent;
- atomically bind first acceptance to one device and public-key fingerprint;
- accept an identical retry from that binding and reject a second device/key with `invite_already_bound`;
- reject expiry, invalid tokens, and any attempt to alter the persisted project set;
- accept with actor and friendly device metadata;
- migrate never-replicated selected-project memories locally;
- apply replicated `reassign_scope` as an idempotent old-Space tombstone plus new-Space upsert;
- reject history provisioning with `reassign_capability_required` before partial migration when a required owner device lacks support;
- preserve only existing effective inviter-device access and never inherit the source Space member list;
- persist future project assignment;
- refresh authorization without waiting for a daemon interval;
- transition stalled non-device provisioning to `needs_attention` while leaving an offline recipient in `waiting_for_device`;
- resume after injected grant, migration, refresh, and bootstrap failures;
- transition active sharing through truthful `revoking` and `revoked` states.

### Two-node end-to-end coverage

1. Seed multiple projects and existing memories on node A.
2. Share one selected project with Brian.
3. Accept on node B as `Brian's Test Mac`.
4. Verify Person and device linking.
5. Verify existing selected-project memories arrive.
6. Add a new selected-project memory and verify it arrives.
7. Verify every unrelated project remains absent.
8. Verify the visible lifecycle reaches `Up to date`.
9. Repeat acceptance and retry requests to prove idempotency.

## Implementation slices

1. **Sharing-operation contract and planner**
   - Persist reviewed Person, project set, history policy, lifecycle, and step state.
   - Add pure planning and status derivation with tests.
2. **Project-first invite creation**
   - Add Projects entry points, Person/project selection, counts, confirmation, and invite creation.
3. **Acceptance identity and device metadata**
   - Send actor identity and friendly device hint; automatically link Person and device.
4. **Exact project access provisioning**
   - Create managed project boundaries, grant devices, migrate existing memories, assign future writes, and refresh authorization.
5. **Resumable initial sync and recovery**
   - Observe initial sync, persist failures, and implement idempotent retry.
6. **Sync and Teams presentation cleanup**
   - Render the approved lifecycle and sharing summaries; remove misleading primary controls and labels.
7. **Compatibility, migration, and end-to-end validation**
   - Preserve legacy payload parsing and prove exact sharing with two local nodes.

## Acceptance criteria

- A user can share selected projects with a new teammate through one invite.
- The inviter enters the teammate's name once.
- The recipient sees and may correct a friendly device-name suggestion.
- Acceptance automatically creates or links the Person and device.
- Selecting one project cannot share unrelated projects from the same existing Space.
- The confirmation includes existing memory counts and future activity.
- Existing and future selected-project memories sync after acceptance.
- No additional pairing, approval, Person assignment, Space grant, or project mapping task is required.
- Every incomplete visible state names what is happening or offers exactly one element marked as the primary recovery action.
- Primary-flow component tests assert that UUIDs, Space IDs, filter controls, and cursor labels are absent.
- Retrying any failed setup step is idempotent under the deterministic identities in this contract.
- Tests prove unrelated projects never reach the recipient and exercise fail-closed `sender_not_member`, `receiver_not_member`, and `scope_mismatch` outcomes.

## Non-goals

- Testing or repairing Brian's current separate machine.
- Replacing the Space authorization protocol.
- Adding hosted accounts, email delivery, or a new organization RBAC system.
- Recalling already-copied data after revocation.
- Solving always-on or anchor-peer deployment in this workflow.
