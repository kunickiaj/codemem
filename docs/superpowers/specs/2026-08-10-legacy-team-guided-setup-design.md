# Legacy Team Guided Setup Design

## Status

Approved on 2026-08-10.

## Problem

Coordinator groups created before person and Team identity support contain enrolled devices but no trustworthy device-to-person assignments or consumed Team invitations. Current enrollment maintenance can read and validate these rosters, but it correctly produces no Team memberships because there is no reviewed identity provenance.

Automatically inventing people or memberships would risk widening access. Doing nothing leaves users with configured groups that cannot participate in person- and Team-based sharing.

Users should not need to understand migration, reconciliation, coordinator internals, or legacy access. The product should guide them through identifying devices and deciding Team membership in plain language.

## Goals

- Turn a configured pre-identity coordinator group into a reviewed Team.
- Require every enrolled device to be handled before activation.
- Reuse one confirmed device-to-person assignment across Teams.
- Allow a device to be excluded from one Team without excluding it globally.
- Preserve current sharing until the complete setup is confirmed.
- Make setup resumable, clear, and safe when the coordinator roster changes.
- Avoid exposing internal identifiers, coordinator URLs, secrets, or migration terminology.

## Non-goals

- Inferring a person from a device display name.
- Automatically activating a partially reviewed Team.
- Changing current sharing while a draft is incomplete.
- Replacing normal Team invitations for newly created Teams.
- Repairing unrelated Project, workspace, or mixed-scope findings.
- Providing device-key recovery or principal account linking.

## Evidence and Safety Boundary

The observed pre-identity rosters have valid device records, but no device has an assigned person and there are no consumed Team invitations. Current response parsing and local snapshot projection both succeed and produce a safe no-op.

Therefore:

- coordinator enrollment proves that a device belongs to a group;
- it does not prove which person controls that device;
- a local assignment may be suggested only when stronger existing identity evidence already binds that exact device;
- every suggestion requires explicit confirmation;
- device names are display hints, never identity evidence.

## Chosen Experience

Use a three-step guided setup flow. A single dense checklist and a separate device inbox were considered, but the guided flow provides the clearest explanation and safest review for users unfamiliar with the underlying model.

### Entry points

The Sharing overview shows a compact notice such as:

> 2 Teams need setup
>
> Tell Codemem who uses each device before using these Teams for sharing.

The primary action is **Continue setup**.

The Teams list shows one of:

- **Needs setup**
- **In progress**
- **Ready**

### Step 1: Identify devices

Heading: **Who uses each device?**

For each device, the user can:

- confirm a verified suggestion;
- choose an existing person;
- create a person.

A suggestion explains its evidence in user language, for example:

- “Already assigned on this device”
- “Assigned through a trusted peer”

No suggestion is selected automatically. The user must confirm it.

Assignments are global. Once confirmed, the same physical device is prefilled in every Team where it appears.

The user may leave a device unassigned in this step only if they mark it **Not part of this Team** in Step 2. Excluded devices do not require a person assignment.

### Step 2: Choose Team devices

Heading: **Which devices belong to this Team?**

Each roster device is either:

- **Included**, with a confirmed person assignment; or
- **Not part of this Team**.

Exclusion copy:

> This device won’t receive future sharing for this Team.

An exclusion applies only to the selected Team. It does not erase the global person assignment.

### Step 3: Review and confirm

The review shows:

- people who will become Team members;
- included devices grouped by person;
- devices excluded from this Team;
- other Teams that reuse newly confirmed assignments.
- every Project/device access change this setup would make through existing sharing, including reviewed Teams, whether caused by assignments, Team-mode conversion, membership reconciliation, device decisions, or access preserved from an existing Team.

When finishing would change existing sharing for any reason, the user must explicitly confirm the complete additions and removals before finishing. An empty delta is shown explicitly and still bound to confirmation by its digest.

Confirmation copy:

> Nothing changes until you confirm. Afterward, Codemem will use these people and devices when sharing with this Team.

The primary action is **Finish Team setup**.

## Activation Rules

Activation is all-or-nothing.

Every active roster device must have exactly one decision:

1. assigned to an active person and included; or
2. excluded from this Team.

The Team cannot activate while any device is unresolved, any identity evidence conflicts, or the draft targets an outdated roster.

On confirmation, one database transaction materializes:

- the active policy Team;
- its authoritative device eligibility mode, `reviewed_allowlist`;
- active Team memberships for people with at least one included device;
- confirmed global device-to-person assignments;
- Team-specific device decisions;
- the completed setup state and provenance metadata.

The membership write is provenance-aware reconciliation, not an append. Setup-managed `reviewed_active` memberships contain only active identities that own at least one final **Included** device. If exclusion, removal, or reassignment leaves a person with no included device, confirmation revokes that obsolete setup-managed membership in the same transaction. Explicit invitation-provenance memberships are preserved even when the invitee currently has only unresolved or no roster devices; membership alone does not grant device eligibility.

If any write fails, the whole transaction rolls back.

## Team-specific Device Decisions

Every Team stores an authoritative device eligibility mode:

- `person_all_devices` — normal invitation-created Team behavior;
- `reviewed_allowlist` — reviewed pre-identity Team behavior.

Activation writes `reviewed_allowlist` in the same transaction that creates the Team and its device decisions. Recipient expansion branches on this stored mode, never on whether decision rows happen to exist.

A reviewed pre-identity Team uses an explicit device allowlist. Person membership does not make an unreviewed device eligible for this Team. Recipient expansion resolves Team members to devices, then keeps only devices with an active **Included** decision for this Team.

This is deliberately narrower than normal person-level expansion. It prevents another device belonging to the same person—but absent from the reviewed roster—from gaining access without review.

Rules:

- decision keys are Team ID plus device ID;
- decisions are `included`, `excluded`, or `unresolved`;
- only `included` can make a device eligible, and only while its person remains an active Team member;
- an exclusion never grants access and cannot affect another Team;
- deleting a decision makes the device ineligible until it is reviewed again;
- deleting every decision from a `reviewed_allowlist` Team does not change its mode or fall back to person-level expansion;
- disabled or unbound devices remain ineligible regardless of decision state;
- a newly enrolled roster device starts `unresolved` and returns the Team to **Needs setup**;
- changing a roster device’s global assignment atomically changes every prior `included` decision for that device to `unresolved`, immediately removes its eligibility, and returns those Teams to **Needs setup**;
- reconfirming the same active global assignment is a no-op that preserves its assignment version, reviewed decisions, and Team readiness;
- a globally assigned device absent from this Team’s roster remains ineligible without reopening the Team;
- decision provenance records the reviewed pre-identity group setup that created it.

## Draft Model

Draft state is durable and local. It stores:

- an immutable, opaque, non-enumerable setup-attempt identifier created each time the Team enters **Needs setup**;
- deterministic candidate Team identity derived from coordinator and group identity;
- sanitized display name;
- roster fingerprint;
- per-device assignment confirmation or Team exclusion;
- expected canonical assignment revision for every confirmed global assignment;
- evidence type for suggestions;
- creation and update timestamps;
- state: `needs_setup`, `in_progress`, `stale`, or `completed`.

The candidate's **Ready** status is derived from a completed draft plus compatible canonical Team state; `ready` is not a persisted draft state.

Draft rows do not participate in authorization. Only confirmed canonical policy rows do.

Saving or finishing a draft compares each expected assignment revision with the canonical assignment. If another Team setup confirmed a different person first, the stale draft is not rebased or overwritten automatically. It becomes blocked until the user accepts the canonical assignment or explicitly chooses another non-conflicting device.

The roster fingerprint covers stable security-relevant fields, including device ID, public-key fingerprint, enabled state, and existing assigned identity when present. Display-name-only changes do not invalidate a draft.

## Roster Changes and Recovery

Before confirmation, Codemem fetches and validates a fresh roster without holding the SQLite write lock. After the fetch completes, the finish transaction acquires `BEGIN IMMEDIATE`, rechecks an exact completion for replay, verifies the fetched fingerprint against the attempt, and rechecks all local assignment and canonical Team compare-and-set facts before writing. Coordinator or other network I/O never occurs inside the write transaction.

If the fingerprint changed, confirmation stops and the UI says:

> This Team’s devices changed. Review the updates before finishing.

Behavior:

- new devices appear unresolved;
- removed or disabled devices are marked for review; confirming the update retires their Team-specific decisions;
- changed identity or key evidence creates a blocking conflict;
- existing canonical assignments are never overwritten silently;
- saved decisions for unchanged devices remain intact.

Assignment conflicts use a compare-and-set boundary. The API returns `team_setup_assignment_changed`; the UI says:

> This device was assigned while you were setting up the Team. Review who uses it before continuing.

Completed setup issues clear automatically only after a successful fresh-roster check no longer reproduces them. Users cannot dismiss an active conflict.

## Components

### Core

- Discover configured groups requiring setup.
- Build sanitized, deterministic Team candidates.
- Compute and validate roster fingerprints.
- Validate draft completeness and evidence.
- Atomically activate a completed draft.
- Apply Team-device exclusions during recipient-to-device expansion.

### Viewer API

Provide bounded endpoints to:

- list Team setup status;
- read one candidate and its device decisions;
- save an assignment confirmation;
- save or remove a Team-specific exclusion;
- refresh a candidate roster;
- finish Team setup.

Responses use display labels and opaque candidate references. They do not expose coordinator secrets, raw URLs, response bodies, public keys, or raw internal database errors.

Stable finish errors are:

- `team_setup_incomplete` — one or more active devices lack a decision;
- `team_setup_roster_changed` — the fresh roster fingerprint differs;
- `team_setup_assignment_changed` — a canonical global assignment changed;
- `team_setup_roster_unavailable` — a fresh roster could not be validated;
- `team_setup_conflict` — canonical Team state conflicts with the draft;
- `team_setup_confirmation_stale` — the submitted attempt, finish, or access-delta confirmation no longer matches the current detail response;
- `team_setup_failed` — bounded fallback for unexpected local failure.

`team_setup_confirmation_stale` returns HTTP 409 and instructs the client to refetch the candidate detail before asking for confirmation again. When no exact completion record exists, finish checks fresh roster state and assignment compare-and-set evidence before confirmation tokens, so the more specific `team_setup_roster_changed` or `team_setup_assignment_changed` error takes precedence over confirmation staleness.

Finish uses a deterministic idempotency key. If a client loses the response after activation commits, an exact retry returns the immutable stored completion result rather than reapplying writes, reconstructing a response from current Team state, or reporting a conflict. Later setup attempts retain their own completion records and never replace an earlier retry result.

Finish validates the opaque candidate route reference and required confirmation fields, then checks for that completion before activation. If no completion matches, it fetches and validates the fresh coordinator roster before acquiring the SQLite write lock. After acquiring `BEGIN IMMEDIATE`, it repeats the completion lookup, verifies the fetched roster fingerprint against the attempt, and rechecks local compare-and-set facts before any canonical write. Every replay lookup requires both the completion's immutable candidate reference and stored confirmed access-delta digest to match the route and submitted request. Concurrent identical requests therefore serialize onto one immutable record: the first request writes it, while the second replays the exact stored response before validating changed canonical state. If the roster fetch fails after the optimistic miss, finish briefly acquires `BEGIN IMMEDIATE` without network I/O and performs the same exact lookup, replaying an overlapping winner or otherwise returning `team_setup_roster_unavailable`. If insertion encounters a completion-key uniqueness race, the loser loads and returns the committed winner only after verifying the same candidate and confirmation binding. Completion tokens submitted through another candidate route or without the exact confirmed representation never replay success.

The finish key is `(attempt_id, finish_digest)`. The immutable completion also retains the attempt's candidate reference and confirmed access-delta digest, and replay lookup uses `(candidate_ref, attempt_id, finish_digest, confirmed_access_delta_digest)` so route and confirmation validation do not depend on trusting digest contents alone. The digest covers the attempt ID, candidate reference, fresh roster fingerprint, normalized decisions and assignments, expected assignment versions, the complete validated canonical Team snapshot, and the confirmed complete access-delta digest. Therefore a later setup attempt cannot collide with an earlier completion even when its visible roster and decisions are identical, another candidate route cannot replay the stored result, and a request that did not echo the exact confirmed representation is not an exact retry.

The detail response includes Project/device access additions and removals caused by assignments, Team-mode conversion, membership reconciliation, final decisions, and preserved recipient edges. The shape and entry count are bounded at the request boundary, but the accepted response is never truncated, paginated, or sampled: the displayed entries exactly match the entries covered by `access_delta_digest`. It also includes an opaque `attempt_id` and current `finish_digest`. Finish must echo the attempt ID and finish digest and submit `confirmed_access_delta_digest`. Missing or mismatched values return `team_setup_confirmation_stale` and cause no writes. The UI never derives or confirms access changes independently.

For changed assignments, the transaction writes the canonical assignment first, reads its incremented `assignment_version`, and writes that post-change version on the final Team decision. An included decision never stores the draft's pre-change expected version.

Historical versions could materialize the deterministic Team and Project recipient edges through `choose_recipients` before guided review. The same candidate-derived Team ID may be reused by matching saved resolutions for multiple Projects. Guided setup may adopt only the exact row whose deterministic identity, `reviewed_team_candidate` provenance, source fingerprint, and memberships validate, and whose complete recipient-edge set equals the union justified by every matching saved resolution across Projects. It preserves that aggregate edge set and reviews its effective access before converting the Team to `reviewed_allowlist`; any unexplained, missing, or mismatched state fails with `team_setup_conflict`.

### UI

- Sharing overview notice and Teams status labels.
- Three-step guided setup.
- Evidence-backed suggestion copy.
- Autosaved progress.
- Clear stale-roster and conflict recovery.
- Review summary before activation.

## User-facing Terminology

Use:

- “Finish setting up this Team”
- “Who uses each device?”
- “Which devices belong to this Team?”
- “Not part of this Team”
- “This Team’s devices changed”

Do not use:

- “reconciliation”
- “legacy access”
- “migration”
- “policy Team”
- raw group, scope, coordinator, or database identifiers

## Validation

### Core tests

- incomplete drafts cannot activate;
- activation is atomic and idempotent;
- global assignments reuse across Teams;
- conflicting assignments fail closed;
- exclusions affect only one Team;
- recipient expansion includes only explicitly reviewed Team devices;
- an active device assigned to a Team member but absent from that Team’s reviewed roster remains ineligible;
- invitation-created `person_all_devices` Teams retain normal person-level expansion;
- an empty `reviewed_allowlist` Team expands to no devices and never falls back to normal Team behavior;
- stale roster fingerprints block activation;
- unchanged decisions survive roster refresh;
- reassignment immediately invalidates prior inclusion until the roster device is reviewed again;
- suggestions require strong evidence and explicit confirmation.

### API tests

- endpoints validate candidate and device references;
- stale writes receive a bounded conflict response;
- responses and errors contain no secrets, URLs, key material, or paths;
- exact completed retries return their original immutable setup result after later setup attempts or Team changes;
- concurrent identical finish requests return the same immutable result and never degrade into a canonical-state conflict;
- candidate A's valid completion tokens submitted through candidate B's finish route never return candidate A's immutable result;
- coordinator roster fetching completes before `BEGIN IMMEDIATE`; after a failed fetch, a lock-scoped exact completion recheck replays an overlapping winner or returns availability failure without writes;
- completed requests replay only when the submitted `confirmed_access_delta_digest` matches the immutable stored confirmation;
- identical visible inputs in separate setup attempts cannot collide because attempt identity is part of the completion key;
- access-delta responses and finish requests use matching server-derived confirmation digests;
- compatible `choose_recipients` Teams selected for one or more Projects are adopted against the aggregate matching saved resolutions without dropping justified recipient edges, while mismatched legacy rows fail closed;
- obsolete setup-managed memberships are revoked when their identity has no final included device, while explicit invitation memberships remain;
- newly assigned included devices are immediately eligible because decisions carry post-write assignment versions;
- assignment compare-and-set conflicts return `team_setup_assignment_changed` without overwriting canonical state;

### UI tests

- all three steps support keyboard and screen-reader navigation;
- progress resumes after reload;
- the primary action remains disabled while unresolved devices exist;
- suggestions are visually distinct from confirmed assignments;
- copy contains no internal migration terminology or identifiers.

### End-to-end test

Exercise two overlapping legacy groups:

1. assign a shared device once;
2. reuse that assignment in both Teams;
3. exclude another device from only one Team;
4. finish both Teams;
5. verify memberships and per-Team device eligibility;
6. add another active device for an included person outside one Team’s reviewed roster and verify it remains ineligible;
7. verify current sharing is unchanged before confirmation;
8. add a roster device mid-draft and verify stale confirmation is blocked;
9. simulate a lost finish response and verify retry returns the completed result.

## Rollout

Ship candidate discovery and setup behind the existing local viewer surface. Do not auto-activate candidates. Existing coordinator enrollment and sharing remain authoritative until the user finishes setup. Diagnostics report aggregate setup state and safe error codes only.

The feature is ready when users can complete both overlapping Teams without consulting internal documentation, while authorization tests prove that no device receives broader access than the confirmed assignments and Team-specific exclusions allow.
