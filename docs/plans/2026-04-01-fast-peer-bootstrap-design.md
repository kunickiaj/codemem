# Fast peer bootstrap for new sync nodes

**Date**: 2026-04-01
**Status**: Approved
**Bead**: codemem-lxt4

## Problem

New sync peers currently pull memories incrementally at ~200 ops per sync interval (default 120s).
A source node with 23,700+ memories takes roughly 4 hours to fully populate a new peer.
This is unacceptable for ephemeral agents, fleet deployments, or any scenario where a new node
needs to be productive quickly.

## Approach

**Auto-detect empty state + elevated bootstrap page size** (Approach 2 from brainstorming).

Reuse the existing snapshot/bootstrap infrastructure in `sync-bootstrap.ts` with two changes:

1. Detect "never synced with this peer" at the start of `syncPass()` and trigger the snapshot
   bootstrap path immediately instead of starting with incremental ops.
2. Use a larger page size (2000 items/page instead of 200) for initial bootstrap fetches so the
   full dataset transfers in ~12 pages instead of ~119.

No new transfer protocols, no new endpoints, no new config surfaces.

## Trigger condition

At the start of `syncPass()`, after resolving a valid peer connection:

- Check `getReplicationCursor()` for the target peer.
- If it returns **null** (no prior successful sync), skip the incremental `/v1/ops` path and go
  directly to `fetchAllSnapshotPages()` → `applyBootstrapSnapshot()`.

The existing `reset_required` detection for stale-cursor / generation-mismatch cases is unchanged.
This new trigger is specifically for **never-synced peers**.

## Bootstrap page size

- **Initial bootstrap** (empty local state): 2000 items per page.
- **Re-bootstrap** (generation mismatch): keeps existing 200 default.
- The `/v1/snapshot` endpoint already accepts a `limit` parameter and enforces a 100,000 item
  safety cap. No server changes needed.
- Not a user-facing config key. The CLI manual trigger accepts `--page-size` for overrides.

## Manual CLI trigger

```
codemem sync bootstrap --peer <device-id>
```

Flags:
- `--peer <id>` — required; which peer to bootstrap from
- `--page-size <n>` — optional; override default 2000
- `--db-path <path>` — optional; database path
- `--json` — optional; machine-readable output
- `--force` — optional; skip dirty-local-state safety check

Exit codes:
- `0` — bootstrap succeeded
- `1` — bootstrap failed

The command resolves the peer, checks for dirty local state (refuses if unsynced shared changes
exist unless `--force`), fetches all snapshot pages, and applies the bootstrap in a single
transaction.

## Files changed

### Modified
- `packages/core/src/sync-pass.ts` — add early null-cursor + empty-shared-state check to branch
  into bootstrap path with elevated page size
- `packages/core/src/sync-replication.ts` — raise server-side snapshot page cap from 1000 → 5000
  and fix `scanBatchSize` to scale with the requested limit
- `packages/core/src/types.ts` — add `"initial_bootstrap"` to `SyncResetRequired.reason` union
- `packages/viewer-server/src/routes/sync.ts` — raise `/v1/snapshot` endpoint page cap from
  1000 → 5000
- `packages/cli/src/commands/sync.ts` — add `codemem sync bootstrap` subcommand

### New tests
- `packages/core/src/sync-pass.test.ts` — null-cursor triggers bootstrap; existing cursor uses
  incremental
- `packages/cli/src/commands/sync.test.ts` — bootstrap subcommand exists and accepts flags

### Not changed
- `packages/core/src/sync-bootstrap.ts` — already supports configurable page size
- `sync-daemon.ts` — inherits new behavior through `syncPass()`
- Config — no new user-facing keys

## Safety

Same dirty-local-state checks as existing bootstrap:
- If local node has unsynced shared memory changes, bootstrap is refused with a clear error.
- CLI `--force` flag overrides this for automation cases where local state is disposable.
- Snapshot fetch failure mid-stream does not partially apply (existing transactional behavior).

## Future work (not in scope)

- Compound `codemem fleet join` command for single-step coordinator enrollment + bootstrap.
- Automated invite acceptance / join-request approval for fleet orchestration.
- Multi-team / multi-coordinator support.
- Configurable ongoing sync batch size (separate from bootstrap page size).
