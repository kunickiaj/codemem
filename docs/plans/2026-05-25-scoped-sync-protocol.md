# Scoped sync protocol: per-Space replication for paired peers

Status: draft
Owner: kunickiaj
Bead: codemem-ruu6 (parent), codemem-ruu6.1 (this doc)
Related: docs/plans/2026-04-30-sharing-domain-scope-design.md, docs/plans/2026-04-30-seed-and-mesh-architecture-converged.md, codemem-ov4g

## TL;DR

Today every paired peer syncs only the `local-default` scope, regardless of how many Spaces both devices belong to. The schema and helper layer for per-scope sync already shipped under codemem-ov4g.4, but the wire protocol still rejects every explicit `scope_id` request and never enumerates per-peer authorized scopes. This document specifies the wire protocol and client/server behavior needed to replicate all Spaces both peers are active members of, end to end.

## Problem

A brand-new node paired against a source DB with ~24,000 scoped memories receives ~295 rows: the legacy/default scope, and nothing else. The default scope match is exact:

- Source `memory_items` with `import_key` in `scope_id IS NULL OR scope_id = 'local-default'`: 787 rows
- Source default scope passing `syncVisibilityAllowed`: 295 rows
- Receiver `memory_items`: 295 rows

Root causes in current code:

1. `packages/core/src/sync-scope-protocol.ts` `parseSyncScopeRequest` returns `unsupported_scope` for every explicit `scope_id` query, with a comment claiming per-scope cursors land in later ov4g.4 slices (closed).
2. `packages/core/src/sync-pass.ts` `syncOnce` initial-bootstrap path issues exactly one `/v1/snapshot` request with no `scope_id`. The boundary returned by `/v1/status` advertises `scope_id: null`.
3. `packages/core/src/sync-replication.ts` `loadMemorySnapshotPageForPeer` and `loadReplicationOpsForPeer` normalize a missing scope to `local-default` and emit only rows in that scope.
4. There is no peer-scope-enumeration endpoint and no per-Space loop in the client.

Symptoms in the UI:

- `codemem sync status` reports `ok` even when 99%+ of the corpus is silently missing.
- The "no longer has two-way trust" toast fires from `peer status failed (401: unauthorized)` and `peer ops push failed (403: scope_rejected:stale_epoch)` alike, so users have no signal that scoped Spaces did not replicate.

## What already exists (do not rebuild)

These pieces shipped under codemem-ov4g and remain in main:

- Schema:
  - `replication_cursors_v2` keyed by `(peer_device_id, scope_id)`
  - `sync_reset_state_v2` keyed by `scope_id`
  - `sync_retention_state_v2` keyed by `scope_id`
  - `replication_scopes`, `scope_memberships`, `project_scope_mappings`
- Helpers in `packages/core/src/sync-replication.ts`:
  - `getSyncResetState(db, scopeId?)`
  - `setSyncResetState(db, values, scopeId?)`
  - `getReplicationCursor(db, peerDeviceId, scopeId?)`
  - `setReplicationCursor(db, peerDeviceId, values, scopeId?)`
  - `loadReplicationOpsForPeer({ scopeId, ... })`
  - `loadMemorySnapshotPageForPeer({ scopeId, ... })`
- Authorization in `packages/core/src/scope-membership-cache.ts`:
  - `getCachedScopeAuthorization(db, { deviceId, scopeId })` returns `{ authorized, scope, epoch, freshness, ... }`
- Outbound/inbound filtering in `packages/core/src/sync-replication.ts`:
  - `outboundScopeAllowed` (requires both local and peer to be active non-local-authority members)
  - `replicationOpRequiresPersonalScopeAuthorization`, `peerCanSyncPrivateOpByPersonalScopeGrant`
  - `applyReplicationOps({ inboundScopeValidation })`
- Capability negotiation in `packages/core/src/sync-capability.ts` (`SYNC_CAPABILITY_HEADER`, `LOCAL_SYNC_CAPABILITY`, `negotiateSyncCapability`).
- Bootstrap snapshot fetch already passes `scope_id` when present: `fetchAllSnapshotPages` in `packages/core/src/sync-bootstrap.ts`.
- `applyBootstrapSnapshot` already accepts a scope-aware `resetInfo` and clears/writes per scope.

The missing piece is the wire protocol: discovery of per-peer authorized scopes, acceptance of signed `scope_id` requests, and a client bootstrap loop that iterates them.

## Protocol changes

### Capability bump

Add `scoped_sync_v1` to the sync capability negotiation set. `LOCAL_SYNC_CAPABILITY` already advertises a string (today: `supported` / `unsupported`); we extend the wire format to a comma-separated list so both old and new capabilities coexist.

- Server adds `scoped_sync_v1` to its advertised capability list.
- Client treats a peer that advertises `scoped_sync_v1` as scoped-capable and only then sends `scope_id` parameters.
- Negotiation rule: scoped paths run only when both peers advertise `scoped_sync_v1`. Otherwise, both fall back to the legacy default-scope path. No silent downgrade for one-sided scoped peers.

### `/v1/status` extension

Response gains an optional `authorized_scopes` array, emitted only when the caller advertises `scoped_sync_v1`:

```json
{
  "device_id": "...",
  "protocol_version": "2",
  "fingerprint": "...",
  "sync_reset": { "scope_id": null, "generation": 1, "snapshot_id": "...", "baseline_cursor": null, "retained_floor_cursor": null },
  "sync_capability": "supported,scoped_sync_v1",
  "authorized_scopes": [
    {
      "scope_id": "oss",
      "label": "OSS",
      "authority_type": "coordinator",
      "membership_epoch": 5,
      "sync_reset": {
        "scope_id": "oss",
        "generation": 1,
        "snapshot_id": "snap-oss-1",
        "baseline_cursor": null,
        "retained_floor_cursor": null
      }
    },
    {
      "scope_id": "personal:actor-abc",
      "label": "Personal",
      "authority_type": "local",
      "membership_epoch": 1,
      "sync_reset": { ... }
    }
  ]
}
```

Server population rule:

- Enumerate `replication_scopes` where:
  - The local device has an active membership in the scope (`scope_memberships`).
  - The caller (peer-authenticated device id) has an active membership.
  - `authority_type` is `coordinator`, or the scope is a personal scope explicitly granted to the caller (`personal_scope_grants`).
- Exclude scopes where `authority_type = 'local'` and there is no personal grant. Those are never replicated.
- Include `local-default` only if the caller is in the legacy-default cohort (always-on backward compat).
- Each entry carries the scope's per-scope reset boundary (`sync_reset_state_v2` row for that scope_id).

This is a single round trip. No separate `/v1/scopes` endpoint. A separate endpoint adds an extra signed request without changing behavior; folding the data into `/v1/status` is simpler and matches existing usage.

### `/v1/ops` and `/v1/snapshot`

- Client passes `scope_id` query parameter once it has chosen a scope.
- Server: `parseSyncScopeRequest` no longer hard-rejects scoped requests.
  - If caller is not advertising `scoped_sync_v1`: reject as before (unsupported_scope) so legacy peers cannot accidentally request scoped data without negotiation.
  - If caller is advertising `scoped_sync_v1` but is not an authorized member of `scope_id`: respond 409 reset_required with `reason = "missing_scope"`.
  - If caller is authorized but `membership_epoch` is stale vs `replication_scopes.membership_epoch`: respond 409 reset_required with `reason = "stale_epoch"`.
  - Otherwise: accept and route `scope_id` through to `loadReplicationOpsForPeer` / `loadMemorySnapshotPageForPeer`.
- `/v1/ops` POST body already accepts `scope_id` (`parseSyncScopeRequest(body.scope_id, hasOwn)`). Update its rejection logic identically.

### Signed transport

No new signing mechanism. The existing `buildAuthHeaders` HMAC covers `(method, full_url_including_query, body_bytes)`. `scope_id` in the query string is therefore already cryptographically bound to the signed request. For POST, `scope_id` is in the signed JSON body.

### Per-scope boundary

`sync_reset_state_v2` is already keyed by `scope_id`. No schema change. `getSyncResetState(db, scope_id)` returns the per-scope row, or a synthesized default if missing.

### Personal scopes

Existing semantics:

- `personalScopeAuthorizationRequirement` flags a memory's `personal:<actor>` scope.
- `peerCanSyncPrivateOpByPersonalScopeGrant` looks up `personal_scope_grants(actor_id, peer_device_id)`.

Under scoped sync:

- `/v1/status` advertises `personal:<actor>` scopes the caller has been explicitly granted.
- Bootstrap and incremental sync route through the same per-scope code paths as coordinator scopes.

### Local-default scope

`local-default` is the implicit "everyone" bucket for unscoped memories that predate Spaces. Under scoped sync:

- `/v1/status` always lists `local-default` in `authorized_scopes` if both peers are sync-paired.
- Bootstrap for `local-default` uses the existing default-scope query path (`scope_id IS NULL OR scope_id = 'local-default'`).
- This preserves backward-compat behavior for the 295 default-scope rows in current dogfood DBs.

## Client behavior

`syncOnce` in `packages/core/src/sync-pass.ts` changes shape:

1. `/v1/status` — negotiate capability. If peer advertises `scoped_sync_v1`, expect `authorized_scopes`.
2. If legacy peer (no `scoped_sync_v1`):
   - Same path as today: single default-scope bootstrap or incremental, no scope_id.
3. If scoped peer:
   - For each scope in `authorized_scopes`:
     - Look up local `(peer_device_id, scope_id)` cursor in `replication_cursors_v2`.
     - If no cursor and no local scoped rows: bootstrap that scope via `/v1/snapshot?scope_id=X`.
     - Else: incremental `/v1/ops?scope_id=X&since=<cursor>&generation=G&snapshot_id=S&baseline_cursor=C`.
     - On 409 reset_required: re-bootstrap that scope only.
     - On other failure: log per-scope failure, continue to next scope.
   - After per-scope pulls, push local outbound ops grouped by `scope_id`. `filterReplicationOpsForSyncWithStatus` already gates this; we'll group its output by `op.scope_id` and call `pushOps` once per scope with the per-scope POST body `{ ops, scope_id, sync_capability }`.
4. Build `SyncResult` with `per_scope: [{ scope_id, ops_in, ops_out, ok, error? }]`.
5. Top-level `ok` is true only if every scope completed (`ok` or `unsupported`). Trust/connectivity failures stop scope iteration immediately because they are pre-request failures.

## Failure modes

| Class | Wire signal | Client behavior | UI |
|---|---|---|---|
| Connectivity | TCP/network error | Cycle to next address; retry next interval | "Offline" |
| Trust | 401 unauthorized on `/v1/status` | Stop. Surface "trust" message. | "Needs repair" + repair UI |
| Scope membership | 403 scope_rejected or 409 missing_scope / stale_epoch per scope | Mark that scope failed; continue other scopes | Per-scope row shows "Membership review needed" linking to Teams |
| Generation/boundary | 409 boundary_mismatch / stale_cursor per scope | Re-bootstrap that scope | Per-scope row shows "Bootstrapping" with progress |
| Default-scope only peer | No `scoped_sync_v1` | Legacy bootstrap, single scope | Single legacy summary line, plus advisory that scoped sync is unavailable on this peer |

Toast classification (codemem-ruu6.6) keys off these classes, not on aggregate sync result.

## Migration

Two upgrade paths:

1. **Fresh node**: pairs against an upgraded source. Sees `authorized_scopes` on first `/v1/status`. Bootstraps every scope on first sync pass. Per-scope cursor table starts populating from baseline.
2. **Existing default-scope-synced node**: cursor table already has a `(peer, local-default)` row; other scopes have no cursor. First scoped sync pass picks up `authorized_scopes`, finds no cursor for the other scopes, and bootstraps them additively without re-fetching `local-default`.

No data destruction. No forced reset. Existing default-scope replicated rows remain.

## Backward compatibility

- Legacy peer (no `scoped_sync_v1`) talks to upgraded peer: upgraded peer omits `authorized_scopes` and accepts only no-scope-id requests. Behavior identical to today.
- Upgraded peer talks to legacy peer: client sees no `scoped_sync_v1` in capability and routes through legacy path. Behavior identical to today.
- Mixed peers in the same coordinator group: each pair negotiates independently.

## Out of scope for this slice

- Per-scope retention policy customization beyond what `sync_retention_state_v2` already supports.
- Removal of the `local-default` scope. Documented as deprecated path; deletion is a future bead.
- Scope rename / merge / split operations.
- Multi-coordinator authority for the same scope.

## Test plan

Unit:

- `parseSyncScopeRequest` accepts scoped requests when caller advertises `scoped_sync_v1` and the scope_id is authorized; rejects with `missing_scope` when caller is not a member; rejects with `stale_epoch` when membership_epoch is behind.
- `/v1/status` emits `authorized_scopes` only for callers advertising `scoped_sync_v1`; never lists scopes the caller is not authorized for.
- `/v1/ops` and `/v1/snapshot` route `scope_id` into the loaders; existing default-scope tests continue to pass.
- `syncOnce` iterates `authorized_scopes` and bootstraps per scope; legacy fallback unchanged.

Integration (codemem-ruu6.7):

- Source DB with three Spaces (`oss=10000`, `personal=1500`, `local-default=200`); fresh peer member of `oss` + `personal` + `local-default`. After one sync, peer has all 11,700 rows in correct scopes.
- Source DB with one Space (`oss=10000`) the peer is NOT a member of, plus `local-default=200`. After one sync, peer has 200 rows, not 10,200.
- Second sync pass after no-op: no re-bootstrap, no `409 reset_required`.
- Legacy peer (no `scoped_sync_v1`) against upgraded source: 200 rows synced, same as today.

## Open questions

None blocking. Two stylistic choices to confirm during implementation:

1. Should `authorized_scopes` ever include `local-default` explicitly, or is it implicit and never listed? Recommend always listing it explicitly so the client only needs one code path.
2. Should the per-scope POST `/v1/ops` body for scoped peers always include `scope_id`, or omit it when ops carry `scope_id` per row? Recommend always include, server validates batch homogeneity.

## File-by-file impact summary

- `packages/core/src/sync-capability.ts`: extend capability string format and negotiation to support `scoped_sync_v1`.
- `packages/core/src/sync-scope-protocol.ts`: change `parseSyncScopeRequest` to accept scoped requests behind capability; introduce a `validateScopeAuthorization` helper that returns `accepted | missing_scope | stale_epoch`.
- `packages/viewer-server/src/routes/sync.ts`: enumerate `authorized_scopes` on `/v1/status`; route `scope_id` query into `loadReplicationOpsForPeer` and `loadMemorySnapshotPageForPeer` on `/v1/ops` and `/v1/snapshot`; respect `scope_id` in POST `/v1/ops` body.
- `packages/core/src/sync-pass.ts`: refactor `syncOnce` to iterate per scope; emit `per_scope` in `SyncResult`.
- `packages/core/src/sync-bootstrap.ts`: no signature changes; `applyBootstrapSnapshot` already scope-aware.
- `packages/ui/src/tabs/sync/...`: per-Space progress (codemem-ruu6.5), toast classification (codemem-ruu6.6).
- New tests under `packages/core/src/` and `packages/viewer-server/src/` for each protocol surface.

## Acceptance for this design slice

- This doc lands as `docs/plans/2026-05-25-scoped-sync-protocol.md`.
- File-by-file impact summary, failure classes, capability negotiation, and migration paths are explicit.
- No new wire endpoints introduced beyond extending existing `/v1/status`, `/v1/ops`, `/v1/snapshot`.
- Backward-compat behavior with legacy peers is preserved.
