# P2P Sync (Phase 2) Plan: Close Gaps + UI + Strong Auth

Phase 2 extends the Phase 1 LAN/Tailscale peer-to-peer sync implementation by:

- closing Phase 1 gaps that were deferred (auth enforcement, mDNS wired into daemon, QR pairing)
- adding viewer UI + settings support for sync status and peer management
- adding service-management helpers and (optionally) keychain integration

This plan is intentionally ordered so we do not ship a "quietly insecure" always-on sync.

## Phase 1 Delivered (baseline)

- SQLite schema for tombstones + replication state (`replication_ops`, `replication_cursors`, `sync_peers`, `sync_attempts`, `sync_device`).
- Replication engine using LWW clock `(rev, updated_at, device_id)` + ops log; idempotent apply + cursor paging.
- Device identity + keypair generation; fingerprint stored.
- Sync HTTP API (`/v1/status`, `/v1/ops`) + periodic daemon sync loop.
- Discovery helpers + optional zeroconf-based mDNS (if installed), but not integrated into daemon loop.
- CLI + autostart templates + tests + docs.

## Goals (Phase 2)

- Security correctness: enforce peer pinning and request authentication for all sync traffic.
- Operational usability: daemon auto-discovers peers on LAN and reconnects reliably.
- User experience: viewer shows sync health and supports pairing/peer management.
- Keep setup minimal; no centralized services.

## Non-Goals (Phase 2)

- NAT traversal/relay for arbitrary internet connectivity.
- Team/multi-user shared memories.
- CRDT-style body merges.

## Work Items

### P0 (Must ship): Enforce Auth + Pinning

Problem (from Phase 1 handoff): auth is permissive; peers without pinned fingerprints skip validation.

Deliverable:

- Require all sync requests to be authenticated and mapped to an existing pinned peer.
- Pairing must record peer fingerprint; "unknown" peers are rejected.

Approach (pick one and implement fully):

1) Request signing (recommended for LAN/Tailscale)
   - Each request includes:
     - signer `device_id`
     - timestamp/nonce
     - signature over canonical request bytes
   - Server verifies signature using the pinned peer pubkey (fingerprint match required).
   - Replay protection: time window + nonce cache (small SQLite table or in-memory with TTL).

2) TLS with pinned keys
   - mTLS or server TLS + client signing, but with explicit pinning.

Acceptance criteria:

- Sync requests from unknown/unpinned peers fail.
- Requests with invalid signature fail.
- Requests with valid signature succeed.
- Tests cover accept/reject cases.

### P0 (Must ship): mDNS Wired Into Daemon

Problem: discovery exists as helpers but daemon does not use it.

Deliverable:

- Integrate LAN discovery into the daemon tick so peers can reconnect without manual address updates.
- Maintain dial order:
  1) mDNS resolution (LAN)
  2) last-known-good address
  3) stored Tailscale DNS/IP
  4) remaining stored addresses

Implementation notes:

- mDNS remains optional (only active if zeroconf dependency is available).
- Persist last-known-good address on successful connection.

Acceptance criteria:

- On LAN, peer can be discovered and synced without manual address entry.
- If mDNS unavailable/fails, daemon falls back to stored addresses.
- Tests cover dial order + fallback.

### P1: Viewer UI (Status + Peers + Actions)

Deliverable: add sync panels to the viewer to make sync understandable without CLI.

UI components:

- Sync status panel:
  - enabled/disabled
  - local `device_id` + fingerprint (copy)
  - listener binds + port
  - last sync time + last error
  - per-peer state summary (ok/unreachable/auth-failed)
  - daemon health (best-effort)

- Peers list:
  - name, device_id (copy), fingerprint (copy)
  - addresses
  - last_seen, last_sync, last_error
  - actions: sync now, rename, remove
  - action: sync all

API endpoints (viewer server):

- `GET /api/sync/status`
- `GET /api/sync/peers`
- `POST /api/sync/peers/rename`
- `DELETE /api/sync/peers/{peer_device_id}`
- `POST /api/sync/actions/sync-now` (peer or all)
- `GET /api/sync/attempts?limit=N`

Acceptance criteria:

- User can see whether sync is healthy and why it is not.
- User can trigger manual sync from the UI.
- User can manage peers (rename/remove).

### P1: Web UI Pairing (Copy Command)

Decision: QR was removed. On desktop-to-desktop workflows it added friction and (in practice) often triggered `mailto:` handling.

Deliverable:

- Viewer shows a one-line pairing command and a copy button.
- Pairing is completed by running the copied command on the other machine:

  `opencode-mem sync pair --accept '<payload>'`

Notes:

- CLI pairing remains the primary “accept” path.
- UI can add a paste/accept flow later if needed.

Acceptance criteria:

- Pairing can be completed using the viewer copy button + CLI accept.

### P1: Settings Dialog Sync Controls

Deliverable: manage new sync config from the settings dialog.

Settings:

- sync enabled toggle
- bind addresses list (add/remove rows)
- port
- auto sync interval
- LAN discovery toggle (mDNS)

Advanced:

- rotate keys (explicit warning: requires re-pairing)

API endpoints:

- `GET /api/sync/config`
- `PUT /api/sync/config`
- optional: `POST /api/sync/actions/enable` / `disable` (if UI should manage the service lifecycle)

Acceptance criteria:

- User can configure sync without editing JSON.

### P2: Service Management Helpers (CLI + Viewer-friendly)

Problem: Phase 1 has templates/install; lacking stop/restart/status helpers.

Deliverable:

- CLI commands:
  - `opencode-mem sync service status`
  - `opencode-mem sync service start|stop|restart`
  - macOS LaunchAgent + Linux systemd --user

Acceptance criteria:

- Users can confirm daemon is running and restart it without hunting down system-specific commands.

### P2: Keychain Integration (Optional, but planned)

Deliverable:

- macOS Keychain backend for private key storage.
- Linux Secret Service backend when available.
- File-based key storage remains as fallback.

Acceptance criteria:

- Works on macOS without extra setup.
- Linux uses keyring when present; otherwise falls back cleanly.

## Testing

Add or extend tests for:

- auth enforcement (unknown peer rejected; invalid signature rejected; valid accepted)
- replay protection behavior (if signing)
- daemon discovery dial order and fallback
- viewer API endpoints (status/peers/actions)

## Documentation

Keep docs short:

- update `docs/user-guide.md` (or README) with:
  - enable, pair (UI-first), status
  - LAN mDNS vs Tailscale note
  - 3-5 troubleshooting bullets

## Additional Implementation Notes (Post-Plan)

- Automatic convergence/backfill: existing databases now bootstrap legacy rows into the ops log in small batches so paired devices converge without a manual bootstrap command.
- macOS dev mode: launchd is not reliable when running via `uv run` (PATH/environment). Prefer pidfile-managed daemon for development.

## Handoff Prompt (for OpenCoder / GPT-5.2-codex)

Implement Phase 2 per this plan, including leftover Phase 1 gaps (P0 auth enforcement + P0 mDNS integrated into daemon). Keep Phase 2 changes scoped; avoid introducing centralized dependencies.
