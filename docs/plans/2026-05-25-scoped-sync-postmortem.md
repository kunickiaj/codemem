# Scoped sync regression postmortem

Status: postmortem
Owner: kunickiaj
Bead: codemem-ruu6.9
Related: codemem-ov4g, codemem-ov4g.4, docs/plans/2026-05-25-scoped-sync-protocol.md

## TL;DR

The 0.32.x line shipped Sharing Domains / Spaces and advertised them as the data-access boundary for sync, but the wire protocol never actually replicated scoped Space data. A brand-new node paired with a multi-Space source received only the legacy `local-default` corpus (~295 rows on a 24k-row dogfood DB) while `codemem sync status` reported `last_sync=ok`. The codemem-ov4g epic was closed despite this gap because no integration test exercised a fresh-peer multi-Space bootstrap end to end. codemem-ruu6 fixes the regression and adds the missing coverage.

## What happened

On a dogfood pair where the source DB held:

- `memory_items` total: 24,378 (18,216 active)
- Scoped rows in non-default Spaces: `oss=15,803 active`, `personal=1,978 active`, `legacy-shared-review=1,005 inactive`, several smaller scopes
- `import_key` rows in `local-default`: 787
- Default-scope rows passing `syncVisibilityAllowed`: **295**

A freshly paired Docker peer ended with:

- `memory_items` total: 295 / 204 active

The match was exact. Sync status on both sides reported `ok`. No log line, no UI affordance, no `sync_attempts` row hinted that 18k+ rows had been silently filtered out of replication.

## Root cause

The wire protocol path that would have moved scoped data was gated off in source:

1. `packages/core/src/sync-scope-protocol.ts` `parseSyncScopeRequest` returned `unsupported_scope` for every explicit `scope_id` request, with a comment indicating per-scope cursors would land in later ov4g.4 slices.
2. `packages/viewer-server/src/routes/sync.ts` `/v1/status` advertised a single default-scope `sync_reset` boundary; there was no `authorized_scopes` enumeration.
3. `packages/core/src/sync-pass.ts` `syncOnce` issued one snapshot/incremental request per peer with no `scope_id`, which the server normalized to `local-default` via `loadMemorySnapshotPageForPeer` / `loadReplicationOpsForPeer`.

The codemem-ov4g.4.2 schema work was already in place: `replication_cursors_v2`, `sync_reset_state_v2`, `sync_retention_state_v2` were keyed by `scope_id`, and `getReplicationCursor` / `setReplicationCursor` / `getSyncResetState` / `setSyncResetState` already accepted scope arguments. The wire protocol that would consume them was never plumbed through, so the per-scope storage stayed empty in practice.

## Why this passed review

Several factors combined to mask the regression:

- **The mixed-scope test exercised filtering, not transport.** `packages/core/src/sync-mixed-scope.test.ts` covered the inbound `apply` path with mixed scoped ops, the outbound `filter` path, and the inbound rejection path. It never exercised a fresh-peer bootstrap that needed to actually pull scoped data through `/v1/snapshot` or `/v1/ops`.
- **Per-scope helpers were unit-tested in isolation.** `replicationCursorsV2` had its own DB-level tests and the scope helpers had cursor-isolation tests, but no test plugged them into `syncOnce` and checked that the wire path carried `scope_id`.
- **`parseSyncScopeRequest` had a test for `unsupported_scope`.** The very behavior that broke the regression was asserted as the correct behavior, because the test was written when the comment "per-scope cursors land in later ov4g.4 slices" was current. The "later slice" never landed but the test was never revisited.
- **`codemem sync status` had no per-Space surface.** The aggregate `last_sync=ok` per peer was indistinguishable from "all Spaces synced," so neither dogfood operators nor automated checks could tell the difference between "295 of 295 default rows synced" and "295 of 18,511 expected rows synced."
- **Health stats counted only visible rows.** The 295 active number on the Docker peer matched the receiver's visible rows exactly, which looked plausible because the user had no expectation of a specific count. The number was correct by its own definition while still being deeply wrong relative to the source's corpus.
- **codemem-ov4g was closed without an end-to-end verification by the bead owner (@kunickiaj).** Child beads ov4g.4.1 through ov4g.4.9 each landed with their own unit tests green, and the epic was signed off on that basis. There was no "drive `syncOnce` against a real multi-Space source, confirm the receiver gets the data" check on the way to close. The cultural pattern — assume the epic is correct because the children are green — is structurally fragile when a child explicitly leaves wire functionality unimplemented behind a comment.

## Fix shape (codemem-ruu6)

The ruu6 stack restores the missing wire path and the missing coverage:

- **ruu6.1** — Protocol design doc covering capability negotiation (`scoped`), `/v1/status` `authorized_scopes`, scoped `/v1/ops` / `/v1/snapshot`, per-scope cursor reuse, client iteration, failure classes, backward compatibility, and migration.
- **ruu6.2** — Server: `parseSyncScopeRequest` accepts scoped requests when caller is scoped-capable and an authorized active-epoch member. `/v1/status` emits `authorized_scopes`. `/v1/ops` and `/v1/snapshot` thread `scope_id` through to the loaders. `listAuthorizedScopesForPeer` enumerates the intersection of memberships.
- **ruu6.3** — Client: `syncOnce` now iterates `authorized_scopes` after both auto-bootstrap and incremental default-scope success. Per-scope bootstrap and incremental flows reuse existing helpers. Per-scope failures are isolated.
- **ruu6.4** — End-to-end test confirming per-scope cursor advancement does not touch the default-scope cursor.
- **ruu6.5** — CLI `codemem sync status` and `/api/sync/*` payloads now expose `per_scope_sync` per peer with synced/pending state from `replication_cursors_v2`. UI render of the same data deferred to a follow-up bead.
- **ruu6.6** — Sync toast classifies failures into trust / scope / mixed buckets, replacing the always-on "re-pair this device" copy when the failure was actually a Space-access problem.
- **ruu6.7** — Multi-Space scoped sync integration test seeds two Spaces, drives `syncOnce` against a mocked scoped peer, and asserts items land in correct scopes with independent cursors.

## Process changes

To prevent the same shape of regression from recurring on future protocol work:

1. **Epics that touch sync protocol require an explicit end-to-end test before close.** A child bead that only adds storage or only adds filtering does not count. The test must drive `syncOnce` (or the equivalent top-level entry point) and assert that data the user expects to replicate actually replicates on the receiver.
2. **Tests that assert a "not yet implemented" sentinel must carry a reference to the unblocking bead.** The `parseSyncScopeRequest` `unsupported_scope` test should have been a one-line comment pointing at the bead that would flip it. When the bead never lands, the comment is grep-able evidence that something is still gated.
3. **Diagnostics surfaces that summarize sync should expose per-Space breakdowns.** `codemem sync status` and `/api/sync/status` now do this. A peer-level `ok` aggregate is misleading any time a peer has authorized Spaces; ruu6.5 makes that explicit.
4. **Dogfood verification of the user-visible "pair a new device" path is required before promoting a release to stable.** The codemem-ruu6.8 release-gate bead documents the manual >=10k-row scenario; future protocol-touching releases inherit that gate.

## Validation

- 2135 automated tests pass on the ruu6 stack tip, including a "bulk transfer canary" that asserts the receiver actually gets the source's scoped rows. The original regression had a stark fingerprint — source 24,378 / receiver 295 — and this canary catches that shape at small scale before it hits dogfood.
- `codemem sync status` on a scoped peer now lists per-Space progress with synced/pending state. The CLI and `/api/sync/*` payloads share one helper (`listPerPeerScopeSyncState`) so the two surfaces cannot drift apart.
- Manual >=10k-row dogfood verification is a HARD GATE on promoting 0.33 from alpha to stable. The bead codemem-ruu6.8 records that gate; stable does not ship until ruu6.8 reports green with per-scope row counts captured on source and receiver. "Scheduled" is the same hedging that let ov4g close — stable is BLOCKED, not "pending."

## References

- docs/plans/2026-05-25-scoped-sync-protocol.md
- docs/plans/2026-04-30-sharing-domain-scope-design.md
- codemem-ruu6 epic and children
- codemem-ov4g epic (closed in error; scoped sync data path was never wired)
