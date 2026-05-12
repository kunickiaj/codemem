# Sharing-domain guided setup flow

**Date:** 2026-05-08  
**Status:** design for `codemem-vsn0.1`; amended with Projects management slice  
**Related:** `2026-05-06-sharing-domain-release-readiness-ux-design.md`, `2026-04-30-sharing-domain-scope-design.md`, `../anchor-peer-deployment.md`, `../coordinator-discovery.md`

## Decision

0.31 should include both a first-class Projects management surface and a guided setup flow that helps users choose device intent and Sharing-domain membership without making project paths or coordinator groups look like security boundaries.

The setup guide is a product layer over existing Sharing-domain primitives. It must preserve these invariants:

- Sharing domain (`scope_id`) is the data boundary.
- Project, folder, git remote, and workspace signals can suggest mappings only after user confirmation.
- Coordinator groups can help discover peers and suggest defaults; they do not grant memory access.
- Anchor peers are ordinary paired peers with high uptime.
- Revocation stops future sync; it does not erase already-copied data.
- Skipping setup leaves unknown projects local-only.

The Projects screen is the primary recurring management surface. The guide can link to it, but day-to-day correction of wrong project/worktree assignments should not require rerunning setup.

## Goals

- Let a user set up personal, work, OSS/dev, and always-on-peer scenarios without reading the scope design doc.
- Let a user find all known projects/worktrees and correct Sharing-domain assignments without opening the Settings modal.
- Make the user explicitly choose which domains a device participates in.
- Preview both what will sync and what will not sync before saving.
- Make safe fallback behavior obvious when setup is skipped or incomplete.
- Define the UI/API data needed before implementation starts.

## Non-goals

- No encrypted relay, ciphertext storage, or zero-trust coordinator design.
- No automatic grants from coordinator group membership.
- No automatic project-to-domain authorization from folders, basenames, or git remotes.
- No destructive cleanup or erasure of already-replicated data.
- No special backend role for anchor peers.
- No full legacy reassignment workflow; that remains `codemem-vsn0.3`.

## Entry points

The guide should be reachable from existing surfaces rather than hidden behind a one-time-only modal:

1. **First sync setup** — user pairs a device or joins coordinator discovery and has no configured non-local Sharing domains.
2. **Settings > Sharing domains** — explicit “Guide me through setup” action.
3. **Projects screen** — explicit “Review Sharing domains” and “Guide me through setup” actions.
4. **Sync panel** — callout when peers exist but no domain grants are configured.
5. **Upgrade review** — callout when `legacy-shared-review` exists, linking to Projects and later to the dedicated review workflow.

Skipping the guide is allowed. The skip state must say: “Unknown projects stay local-only until you map them to a Sharing domain.”

## Projects management surface

The first-class Projects screen should be implemented before or alongside the legacy review workflow. It is not a replacement for the guided setup flow; it is the durable place for recurring project/worktree inventory and correction.

### User jobs

- Find projects or worktrees that are missing from the Settings panel today.
- See why a project resolves to its current Sharing domain.
- Identify local-only, unmapped, suggested, explicitly mapped, legacy-review, and collision/risk states.
- Correct a project or worktree that landed in the wrong Sharing domain.
- Understand that changing a project mapping affects future writes and does not recall data already copied under an old domain.

### Layout

Use a searchable list/table plus a row detail panel.

List columns or primary row fields:

- project/worktree display name;
- current resolved Sharing domain;
- resolution reason;
- latest activity;
- status badge (`local-only`, `unmapped`, `suggested`, `mapped`, `legacy review`, `needs attention`);
- strongest identity signal, such as git remote or cwd.

Detail panel fields:

- canonical workspace identity;
- project name;
- cwd;
- git remote;
- git branch;
- identity source;
- current resolved domain and mapping reason;
- suggested domain and suggestion reason, when present;
- guardrail warnings;
- memory/session counts when cheap, otherwise “count unavailable”.

Actions:

- confirm suggested mapping;
- change Sharing domain;
- keep local-only;
- remove explicit mapping;
- open legacy review for historical data when relevant.

The Sharing-domain chooser inside an action panel can remain a Radix Select. A more visibly themed Select is a polish task; it does not solve project discovery or correction by itself.

### Inventory API requirements

The Projects screen needs a read model that is not limited to a recent-session candidate list selected before deduplication.

Required API behavior:

- search by project name, cwd, git remote, branch, and workspace identity;
- filter by resolved domain, status, identity source, and warning state;
- stable pagination after deduplication by canonical workspace identity;
- expose latest activity and cheap counts where available;
- include all explicitly mapped projects even when they have no recent sessions;
- include older known projects/worktrees, not just the most recent 250 session rows.

Until that read model exists, the Settings panel can remain a compact fallback but should not be treated as the complete management experience.

## Setup flow

### Step 1: Choose this device's role

Ask what kind of device this is. Multiple selections are allowed because mixed machines are normal.

| Choice | Product meaning | Default suggestion |
|---|---|---|
| Personal laptop | User-owned interactive machine | Create or use `Personal`; keep private memories local/personal only |
| Work laptop | Employer/client machine | Create or join a work/client domain; do not include personal paths |
| OSS/dev machine | Open-source or public collaboration workspace | Create or use an OSS domain separate from personal/work |
| Always-on peer | Server, desktop, Pi, or VPS that stays online | Pair as normal peer, then choose explicit domains it may carry |

Copy guardrail:

> A device can participate in more than one Sharing domain, but each domain grant is explicit. Coordinator discovery and project folders do not grant access by themselves.

### Step 2: Select or create Sharing domains

Show existing domains grouped by kind:

- Local only
- Personal
- Work/team/client
- OSS/community
- Legacy review

For each selected domain, show:

- label;
- authority type (`local`, coordinator-managed, signed manifest when available);
- current member devices;
- whether this device is already a member;
- warning state if membership is missing, stale, or informational-only.

The user can create a local domain or select a coordinator-suggested domain, but saving still requires an explicit grant action where the current product supports it.

### Step 3: Confirm project mappings

Show project suggestions from strongest to weakest signals:

1. git remote;
2. git remote + branch, only for opt-in branch-level mappings;
3. normalized absolute cwd;
4. workspace id;
5. unmapped fallback identifier.

Each suggestion must explain why it appeared:

> `git@github.com:acme/api.git` looks like Acme Work based on git remote. Confirm before mapping.

Required states:

- **Confirm** — save mapping to the selected Sharing domain.
- **Change domain** — select a different domain.
- **Keep local-only** — leave the project unmapped or mapped to local-only.
- **Ignore suggestion** — hide this suggestion without granting anything.

Collision guardrail:

> Two projects named `codemem` have different git remotes. Review each one separately; basename is display-only.

Broad-pattern guardrail:

> This pattern may match many projects. Work and client domains should not use home-directory or `*` mappings unless you understand the leak risk.

### Step 4: Choose peer/domain grants

For each paired or discovered peer, show a matrix:

| Peer | Coordinator/group context | Explicit domain grants | Project filters | Result |
|---|---|---|---|---|
| Work laptop | `acme-eng` discovery | `Acme Work` | include `*` | Receives only Acme Work; filter can narrow only |
| Personal desktop | none | `Personal` | none | Receives Personal only |
| OSS peer | `oss-codemem` discovery | `OSS codemem` | include `oss/*` | Receives OSS codemem only |
| Anchor peer | paired peer | user-selected domains | optional narrowing | Carries only selected domains |

The screen must visibly separate coordinator/group context from explicit Sharing-domain grants.

Required copy:

> Project filters only narrow what an already-authorized peer receives. They cannot grant a peer access to another Sharing domain.

### Step 5: Preview what will and will not sync

Before save, show a review screen with counts where available.

Minimum useful preview:

- domains this device belongs to;
- projects mapped to each domain;
- peers that can receive each domain;
- peers that cannot receive each domain;
- local-only or unmapped projects;
- legacy-review data that still needs separate review.

Example copy:

> Work peer will receive Acme Work memories only. It will not receive Personal, OSS codemem, Local only, or legacy-review data.

If exact counts are expensive or unavailable, show “count unavailable” rather than blocking the guide.

### Step 6: Save and explain next state

After save, show:

- domains created or selected;
- mappings confirmed;
- peer grants changed;
- projects left local-only;
- recommended next action, such as pairing a peer, reviewing legacy data, or checking sync status.

Success copy should be concrete:

> Setup saved. Unknown projects will stay local-only. You can review or change Sharing domains from Settings at any time.

## Always-on peer path

The always-on path reuses the same flow with server-focused copy:

1. Pair or select the always-on peer.
2. Explain that it is a normal peer expected to stay online.
3. Choose explicit Sharing domains it may carry.
4. Show domains it will not carry.
5. Show coordinator discovery separately from data access.
6. Provide CLI/headless equivalents for server setup.

CLI copy should be command-oriented but not invent unavailable flags. The implementation bead should either wire real commands or link to `docs/anchor-peer-deployment.md` until command support exists.

## Backend/API data needed

The guide should be implemented only after these data needs are available or deliberately stubbed:

### Domain inventory

- `scope_id`
- label
- kind
- authority type
- status
- coordinator/group references, if any
- membership phase/diagnostic state

### Current device membership

- device id / display name
- domains where this device is active, pending, or revoked
- whether scope metadata is informational-only or enforcing

### Peer inventory

- peer id / device id / display name
- pairing status
- coordinator/group discovery context
- explicit Sharing-domain grants
- project include/exclude filters, labeled as narrowing only
- sync capability (`unsupported`, `aware`, `enforcing`) when available

### Project/workspace signals

- display project name
- canonical workspace identity
- signal source (`git_remote`, `cwd`, `workspace_id`, fallback)
- proposed domain, if any
- existing mapping, if any
- collision or broad-pattern warnings

### Project inventory

- canonical workspace identity
- display project/worktree name
- latest session timestamp
- identity source and strongest signal
- current resolved domain and resolution reason
- explicit mapping id, when present
- suggested domain and suggestion reason, when present
- status flags for local-only, unmapped, suggested, mapped, legacy-review, and needs-attention states
- pagination cursor or offset after identity dedupe

### Preview counts

- memory count by domain, when cheap
- legacy-review count, when present
- peers eligible per domain
- peers excluded per domain and reason

## Fallback behavior

If the guide is skipped or cannot finish:

- unknown projects remain local-only;
- no peer receives new domains without an explicit grant;
- coordinator group membership remains discovery/admin context only;
- ambiguous historical shared data remains in `legacy-shared-review`;
- the UI should keep showing a resumable setup callout.

Partial save is allowed only for independently valid operations. For example, confirming a project mapping can succeed even if a later peer grant fails, but the final screen must say which steps saved and which did not.

## Error and warning states

The guide should include product states for:

- no paired peers;
- paired peers with no domain grants;
- coordinator group joined but no explicit domain membership;
- suggested project mapping collision;
- broad project pattern on work/client domain;
- legacy-review data exists;
- legacy peer does not support scope enforcement;
- stale or missing membership manifest;
- save conflict because another device changed memberships.

Errors should preserve safety. Failed or ambiguous setup must under-share, not broaden access.

## Implementation slices

Recommended order after this design:

1. **Guide shell and state model** — route/panel, step state, skip/resume behavior, no writes except local UI state.
2. **Projects inventory read model** — searchable, filterable project/worktree inventory not constrained by recent-session pre-dedupe limits.
3. **Read-only Projects screen** — first-class UI showing all known projects/worktrees, current domains, reasons, suggestions, and status filters.
4. **Project correction actions** — confirm suggestions, change domains, keep local-only, and remove mappings with guardrail confirmations.
5. **Domain and peer inventory read model** — read-only setup summary using existing Settings/Sync data.
6. **Confirmed project mapping suggestions** — keep `codemem-vsn0.2` as the suggestion engine already implemented; surface it in Projects.
7. **Peer grant review UI** — show grant matrix and preview excluded domains before changing grants.
8. **Legacy review workflow link-in** — point legacy state to `codemem-vsn0.3` once reassignment exists.
9. **Anchor-peer guided path** — implement `codemem-vsn0.4`, including docs/CLI equivalents.
10. **Mixed scenario validation** — execute `codemem-vsn0.5` using personal/work/OSS plus one always-on peer.

## Acceptance checklist

- [ ] Personal laptop path can create/select Personal and keep unrelated projects local-only.
- [ ] Work laptop path can create/select a work/client domain without granting personal or OSS data.
- [ ] OSS/dev path can map OSS projects independently of work and personal domains.
- [ ] Always-on peer path treats the peer as ordinary high-uptime infrastructure and requires explicit domain grants.
- [ ] Suggestions explain their signal and require confirmation before saving.
- [ ] Preview shows both sync and non-sync outcomes.
- [ ] Skipping setup leaves unknown projects local-only.
- [ ] Copy never implies folders, coordinator groups, or project filters grant access.
- [ ] Legacy-review state is visible but not automatically promoted.
