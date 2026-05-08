# Sharing-domain 0.30 release-readiness checklist

**Date:** 2026-05-06  
**Status:** satisfied for alpha dogfood; final release still requires dogfood sign-off  
**Related:** `2026-05-06-sharing-domain-release-readiness-ux-design.md`, `2026-05-06-sharing-domain-boundary-checkpoint.md`, `2026-04-30-sharing-domain-scope-design.md`

This checklist gates the remaining 0.30 Sharing-domain UX polish. OV4G enforcement is complete; this gate verifies that dogfooders can understand the new model without weakening it.

## Required invariants

Every 0.30 release-readiness change must preserve these statements:

- Sharing domain (`scope_id`) is the hard data boundary.
- Coordinator groups help with discovery/admin; they do not grant memory access.
- Project, folder, and path mappings are suggestions or narrowing rules; they do not grant access.
- Anchor peers are ordinary paired peers with high uptime; they are not coordinators, relays, quorum members, or special protocol roles.
- Revocation stops future sync for a Sharing domain; it does not erase data already copied to a peer.
- `legacy-shared-review` is conservative upgrade state, not a destination that should be silently promoted.
- Ciphertext storage and zero-trust relay are deferred and must not appear as 0.30 requirements.

## Phase-1 readiness items

### Anchor-peer setup clarity (`codemem-p6kx.1`)

- [x] Sync or Settings includes a compact explanation/checklist for always-on peers.
- [x] Copy says an anchor peer is a normal high-uptime peer.
- [x] Copy says explicit Sharing-domain grants decide what the peer receives.
- [x] Copy says coordinator discovery is not data access.
- [x] Copy says project filters only narrow.
- [x] Surface links to `docs/anchor-peer-deployment.md`.

### Peer Sharing-domain grant visibility (`codemem-p6kx.2`)

- [x] Peer rows/details show authorized Sharing domains clearly.
- [x] The empty state says no Sharing-domain grants exist yet.
- [x] Project include/exclude filters are labeled as narrowing only.
- [x] Coordinator group/discovery indicators are visually or textually separate from domain grants.
- [x] No copy implies coordinator group membership or project filters grant data access.

### Legacy review upgrade state (`codemem-p6kx.3`)

- [x] Users can see when `legacy-shared-review` data exists.
- [x] Copy explains that 0.30 placed ambiguous historical shared data there conservatively.
- [x] Users are pointed to Sharing-domain mappings or docs for review.
- [x] No automatic reassignment or promotion is performed.
- [x] Copy warns that already-copied historical data is not erased by remapping or revocation.

### Scope backfill and maintenance expectations (`codemem-p6kx.4`)

- [x] Upgrade/maintenance copy explains that scope backfill may process memories and replication ops.
- [x] Copy explains that progress totals can exceed the visible memory count.
- [x] Copy sets expectation that large databases can be CPU-bound during one-time work.
- [x] `codemem maintenance status` is documented as the inspection command.
- [x] Completed jobs remain understandable after fast or long runs.

## Validation path

Before cutting the final 0.30 release:

Tracked by `codemem-p6kx.6` for the `v0.30.0-alpha.5` dogfood pass.

1. Run targeted tests for each changed surface.
2. Run the normal TypeScript gate:
   ```fish
   pnpm run tsc
   pnpm run lint
   pnpm run test
   ```
3. Dogfood an upgraded database with existing memories and replication ops.
4. Confirm the maintenance/backfill surface explains expected CPU-bound work.
5. Confirm a mixed personal/work/OSS setup shows peer domain grants and narrowing filters accurately.
6. Confirm the anchor-peer copy never describes a special role or coordinator data path.
7. Confirm release notes/docs do not introduce folder/path security language.

## Deferred to 0.31+

- Guided first-run setup wizard.
- Confirmed project-to-domain suggestions.
- Full `legacy-shared-review` reassignment workflow.
- Guided anchor-peer setup flow.
- Mixed personal/work/OSS guided setup validation.
