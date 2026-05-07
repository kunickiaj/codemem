# Sharing-domain 0.30 release-readiness checklist

**Date:** 2026-05-06  
**Status:** open  
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

- [ ] Sync or Settings includes a compact explanation/checklist for always-on peers.
- [ ] Copy says an anchor peer is a normal high-uptime peer.
- [ ] Copy says explicit Sharing-domain grants decide what the peer receives.
- [ ] Copy says coordinator discovery is not data access.
- [ ] Copy says project filters only narrow.
- [ ] Surface links to `docs/anchor-peer-deployment.md`.

### Peer Sharing-domain grant visibility (`codemem-p6kx.2`)

- [ ] Peer rows/details show authorized Sharing domains clearly.
- [ ] The empty state says no Sharing-domain grants exist yet.
- [ ] Project include/exclude filters are labeled as narrowing only.
- [ ] Coordinator group/discovery indicators are visually or textually separate from domain grants.
- [ ] No copy implies coordinator group membership or project filters grant data access.

### Legacy review upgrade state (`codemem-p6kx.3`)

- [ ] Users can see when `legacy-shared-review` data exists.
- [ ] Copy explains that 0.30 placed ambiguous historical shared data there conservatively.
- [ ] Users are pointed to Sharing-domain mappings or docs for review.
- [ ] No automatic reassignment or promotion is performed.
- [ ] Copy warns that already-copied historical data is not erased by remapping or revocation.

### Scope backfill and maintenance expectations (`codemem-p6kx.4`)

- [ ] Upgrade/maintenance copy explains that scope backfill may process memories and replication ops.
- [ ] Copy explains that progress totals can exceed the visible memory count.
- [ ] Copy sets expectation that large databases can be CPU-bound during one-time work.
- [ ] `codemem maintenance status` is documented as the inspection command.
- [ ] Completed jobs remain understandable after fast or long runs.

## Validation path

Before cutting the final 0.30 release:

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
