# Sharing-domain release-readiness UX plan

**Date:** 2026-05-06  
**Status:** scoped for implementation  
**Related:** `2026-04-30-sharing-domain-scope-design.md`, `2026-05-06-sharing-domain-boundary-checkpoint.md`, `../anchor-peer-deployment.md`, `../coordinator-discovery.md`

## Decision

Split Sharing-domain UX polish into two phases:

1. **0.30 release-readiness UX**: make the existing safe model understandable and dogfoodable without adding a large new setup wizard.
2. **0.31+ guided setup and upgrade review**: design and build a guided journey for fresh setup, always-on peers, and legacy review.

The 0.30 phase must not weaken the OV4G invariants:

- Sharing domain (`scope_id`) is the hard data boundary.
- Project/folder mappings are setup aids and narrowing rules; they never grant access.
- Coordinator group membership is discovery/admin context, not data access.
- Anchor peers are ordinary peers with high uptime, not special protocol roles.
- Revocation prevents future sync; it does not erase data already copied to a peer.

End-to-end ciphertext storage is out of scope for this release. It may be useful later for zero-trust relay peers that store or forward opaque payloads for domains they cannot read, but it is not part of the trusted-anchor 0.30 release path because it would reduce local FTS, semantic indexing, diagnostics, and repair value.

## Phase 1: 0.30 release-readiness UX

Phase 1 uses the current Sync, Settings, coordinator-admin, and docs surfaces. It should be small enough to land safely before the real 0.30 release.

### 1. Anchor-peer setup clarity

Users need an in-product path from “I want an always-on peer” to the right mental model.

The UI should explain that an anchor peer is a normal paired device that happens to stay online. It should receive only the Sharing domains explicitly granted to it. Coordinator discovery can help devices find the peer, but memory payloads still sync peer-to-peer.

The surface can be a Sync or Settings panel card with a short checklist and links to `docs/anchor-peer-deployment.md`. It should include copyable or clearly referenced next steps where practical, but it does not need to automate the full setup.

### 2. Peer Sharing-domain clarity

Users should be able to inspect a peer row and answer:

> Which Sharing domains can this peer receive, and what only narrows that set?

Peer cards/details should clearly show authorized domains, the “none granted” state, and project include/exclude filters as narrowing rules only. Copy should avoid implying that coordinator group membership or project filters grant access.

### 3. Upgrade review affordance

Upgraded databases can contain `legacy-shared-review` data. That bucket is intentionally conservative: ambiguous historical shared data should be reviewed before it is promoted to a work, client, OSS, or personal domain.

Phase 1 should make this state visible and actionable enough for dogfooding:

- show that legacy review data exists;
- explain why it exists;
- point users to Sharing-domain mappings and docs;
- avoid bulk reassignment unless the existing implementation already supports it safely.

### 4. Maintenance/backfill expectation copy

Scope migration can process many more rows than the visible memory count because it stamps both `memory_items` and historical `replication_ops`. Large databases can be CPU-bound for a while.

Phase 1 should set expectations in the UI/docs:

- scope backfill is expected one-time work after upgrade;
- progress totals may include replication operations, not just memories;
- `codemem maintenance status` is the inspection path;
- successful completion means future startup should be quieter.

### Phase 1 non-goals

- No full first-run wizard.
- No folder/path-based security model.
- No coordinator group auto-grants.
- No automatic promotion out of `legacy-shared-review`.
- No ciphertext or zero-trust relay work.
- No special anchor-peer protocol role.

## Phase 2: 0.31+ guided setup and upgrade review

Phase 2 turns the model into a guided product flow. It can build new UI components and endpoints as needed.

### 1. Fresh setup guide

Guide a user through device type and Sharing-domain intent:

- personal laptop;
- work laptop;
- OSS/dev machine;
- always-on anchor peer.

The flow should ask which domains the device should participate in and preview what will not sync.

### 2. Suggested mappings, not folder security

Folder paths, git remotes, and workspace identities can suggest mappings, but the user must confirm them. The UI should phrase these as suggestions:

> “This looks like Work based on path/git remote. Confirm before mapping.”

The trust boundary remains the confirmed Sharing domain, not the folder pattern.

### 3. Legacy review workflow

Build a richer review workflow for `legacy-shared-review`:

- group by project, cwd, git remote, and source signals;
- suggest destination domains;
- preview memory counts and affected peers;
- warn that already-copied historical data is not erased;
- apply explicit user-approved reassignments only.

### 4. Anchor-peer guided setup

Build a guided flow for always-on peers:

- choose domains the peer should carry;
- show domains it will not carry;
- pair or select discovered peer;
- grant membership explicitly;
- show coordinator discovery separately from data access;
- provide headless/CLI equivalent steps for servers.

### Phase 2 non-goals

- No encrypted-storage redesign unless separately scoped.
- No automatic cross-org federation.
- No automatic deletion from revoked peers.

## Success criteria

For 0.30, a dogfooder should be able to:

1. upgrade with a large existing database and understand why maintenance work is running;
2. identify whether legacy shared data needs review;
3. configure or inspect an always-on peer without believing it is a coordinator or special relay;
4. verify which Sharing domains each peer can receive;
5. avoid relying on folders, coordinator groups, or project filters as security boundaries.

For 0.31+, a new user should be able to complete personal/work/OSS plus optional anchor-peer setup without reading the OV4G design doc.
