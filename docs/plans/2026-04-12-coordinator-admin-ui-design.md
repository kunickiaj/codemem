# Coordinator Admin UI in Viewer

**Status:** Design  
**Date:** 2026-04-12

## Problem

Coordinator-backed discovery now has working building blocks for invites, join review, and device administration, but the operator experience is still split awkwardly across CLI, setup docs, and overloaded Sync UI.

Today:

- the Sync tab already carries too much cognitive load
- the common `Invite teammate` action is convenient there, but advanced coordinator administration does not belong in the same surface
- remote/Cloudflare coordinator admin requires an explicit admin secret, which makes “just click the invite button” unreliable unless configuration is complete
- the current product model needs to preserve a clear distinction between coordinator-backed discovery and actual direct sync relationships

The result is a product surface that technically works but does not communicate the boundary between:

- everyday sync and peer management
- operator-only remote coordinator administration

## Goal

Design a viewer-hosted **Coordinator Admin** experience that:

- keeps the browser away from the raw admin secret
- keeps Sync focused on peer/discovery/sync status
- preserves `Invite teammate` as a convenient common action in Sync
- makes advanced coordinator administration available in a dedicated top-level tab
- supports a first useful slice now, while leaving room for richer groups/teams management later

## Product framing

The coordinator remains:

- a discovery/admin service
- not the direct memory transport path

Direct peer sync remains separate and continues to work for:

- manually paired peers
- uncoordinated peers
- coordinator-discovered peers that are later accepted for direct sync

Coordinator membership should **not** mean “start syncing with everyone in the group.”

## Key decisions

### 1. New top-level tab

Add a new top-level viewer tab named **Coordinator Admin**.

Reasoning:

- Sync is already overloaded
- operator/admin concepts deserve a separate mental model
- a dedicated tab scales better to groups/teams and multi-coordinator futures

### 2. Keep invite affordance in Sync

Keep `Invite teammate` in Sync because it is a common action and is useful close to everyday collaboration surfaces.

If admin configuration is missing:

- the action remains visible
- it is disabled
- it shows a short setup explanation

### 3. Viewer-server owns the admin secret boundary

The browser must not call the remote coordinator with the admin secret directly.

Instead:

- browser calls viewer-server
- viewer-server reads local coordinator URL/admin-secret config
- viewer-server proxies remote admin actions to the coordinator

### 4. New route namespace

Use a dedicated route namespace:

- `/api/coordinator/admin/...`

Reasoning:

- clear boundary between coordinator admin and other viewer APIs
- leaves room for future non-admin coordinator routes
- avoids turning `/api/admin` into a vague dumping ground

### 5. New surfaces use Radix UI

All new UI in the Coordinator Admin tab should use Radix UI-based primitives and existing project patterns.

## Information architecture

### Sync tab

Sync continues to own:

- direct peer status
- coordinator-backed discovery visibility
- suggested peers
- actual sync relationship state
- `Invite teammate` as the common action

Sync does **not** become the home for advanced remote coordinator administration.

### Coordinator Admin tab

The new top-level tab becomes the operator console for the currently configured coordinator target.

#### v1 sections

1. **Overview / setup state**
   - configured coordinator URL
   - configured group/team context
   - admin capability present/missing
   - setup guidance when not ready

2. **Invites**
   - create invite
   - choose join policy (`auto_admit` / `approval_required`)
   - show invite payload and warnings

3. **Join requests**
   - list pending join requests
   - approve / deny
   - show inline action feedback

4. **Enrolled devices**
   - list devices
   - rename
   - disable
   - remove

#### Later sections

5. **Groups / teams browser**
   - browse groups
   - switch active group context
   - eventually create/manage groups if the product model settles there

6. **Coordinator diagnostics**
   - remote admin readiness
   - invite/join/admin failure details
   - future bootstrap grant or diagnostics views

## Security and config boundary

### Required local configuration for admin mode

- `sync_coordinator_url`
- admin secret available to viewer-server (for example via env/config)

### UI readiness states

1. **Not configured**
   - no coordinator target
   - show setup guidance only

2. **Partial**
   - coordinator target exists
   - admin secret missing
   - allow read-only setup messaging, disable admin mutations

3. **Ready**
   - coordinator target + admin secret available
   - full admin UI enabled

## API boundary sketch

### Read routes

- `GET /api/coordinator/admin/status`
- `GET /api/coordinator/admin/join-requests`
- `GET /api/coordinator/admin/devices`
- later: `GET /api/coordinator/admin/groups`

### Mutation routes

- `POST /api/coordinator/admin/invites`
- `POST /api/coordinator/admin/join-requests/:id/approve`
- `POST /api/coordinator/admin/join-requests/:id/deny`
- `POST /api/coordinator/admin/devices/:id/rename`
- `POST /api/coordinator/admin/devices/:id/disable`
- `POST /api/coordinator/admin/devices/:id/remove`

These should reuse existing coordinator action helpers wherever possible rather than inventing a parallel coordinator client.

## Error handling

The UI must distinguish between:

- missing local setup
- missing admin secret
- remote admin auth failure
- remote worker unreachable
- malformed or stale invite/join/device state
- success with warnings

This design explicitly avoids “button did nothing” failure modes.

## Implementation slices

### Slice 0 — boundary + status plumbing

Build the viewer-server coordinator admin proxy surface and normalized readiness/status payloads.

Deliverables:

- `/api/coordinator/admin/...` route shell
- readiness state payload
- normalized remote admin errors

### Slice 1 — Coordinator Admin tab shell

Build the new top-level tab and setup/empty-state experience.

Deliverables:

- tab in the viewer nav
- Radix-based shell and sections
- setup/readiness state rendering

### Slice 1a — Sync invite gating cleanup

Keep `Invite teammate` in Sync, but make it honest.

Deliverables:

- visible but disabled invite affordance when admin config is missing
- short setup explanation
- clear handoff to Coordinator Admin

### Slice 2 — useful v1 admin surface

Build the first actually useful admin operations.

Deliverables:

- invite creation panel
- pending join request review panel
- enrolled devices management panel

This is the planned first release-quality slice.

### Slice 3 — groups/teams browser

Add group browsing and deeper coordinator management only after the shell and v1 admin actions are stable.

### Slice 4 — multi-coordinator / multi-team future

Support multiple coordinators or team contexts only after the product model is clearer.

This should build on, not block, slices 0–3.

## Bead graph

### Epic

- **Coordinator Admin UI in Viewer**

### Child beads

1. **viewer-server coordinator admin proxy routes**  
   Blocks all later slices.

2. **Coordinator Admin tab shell and readiness states**  
   Depends on proxy routes.

3. **Sync invite gating and handoff cleanup**  
   Depends on proxy/status readiness; can land in parallel with the tab shell.

4. **Coordinator Admin invites panel**  
   Depends on tab shell.

5. **Coordinator Admin join request review panel**  
   Depends on tab shell.

6. **Coordinator Admin enrolled devices panel**  
   Depends on tab shell.

7. **Coordinator Admin groups/teams browser**  
   Depends on invites + join requests + devices panel.

8. **Multi-coordinator / multi-team follow-on**  
   Depends on groups/teams browser and product-model clarification work.

## Relationship to existing coordinator work

This design does not replace the existing product-model questions tracked in:

- `codemem-cbfk` — clarify coordinator groups vs manual peer pairing
- `codemem-low6` — auto-peer devices discovered in coordinator groups

Instead, it creates an operator-facing admin surface that can ship independently of those deeper model decisions.

## Non-goals for first implementation

- no admin UI hosted inside the coordinator Worker itself
- no browser-side storage or direct use of the admin secret
- no relay/proxy transport through the coordinator
- no automatic “join group means start syncing” behavior
- no required multi-coordinator support in v1

## Success criteria

This design is successful when:

1. Sync stays focused on everyday peer/discovery/sync workflows.
2. Advanced coordinator operations move into a dedicated top-level tab.
3. The browser never needs the raw admin secret.
4. The common invite action remains convenient but no longer fails opaquely.
5. We can stop after the v1/B slice and still have a coherent product surface.
6. The architecture still leaves room for groups/teams and multi-coordinator futures.
