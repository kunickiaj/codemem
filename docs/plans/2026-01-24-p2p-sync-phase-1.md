# P2P Sync (Phase 1) Plan: LAN + Tailscale

This plan describes Phase 1 of syncing the codemem database across multiple computers owned by the same person, without a centralized store.

The target experience is opt-in sync that is easy to set up, works on LAN and/or over Tailscale, and converges deterministically.

## Status (Jan 2026)

- Phase 1 is implemented (daemon, pairing, mDNS discovery, ops/cursors, CLI).
- Viewer sync UI work (originally Phase 2) landed early: the viewer shows sync status/peers and supports "sync now".
- The viewer UI is now served as packaged static assets (to avoid regressions from embedding HTML/JS inside Python).

## Goals

- Sync codemem data between a user's devices via peer-to-peer.
- No centralized datastore.
- Deterministic merge behavior with tombstones.
- Minimal setup: enable on both machines, pair once, then it keeps working.
- macOS + Linux support.

## Non-Goals (Phase 1)

- Multi-user/team shared memories.
- Internet/NAT traversal without VPN/port-forwarding.
- Web UI changes (status/peers/settings) (Phase 2; some pieces shipped early, see Status).
- OS keychain integration for keys (Phase 2; Phase 1 uses file-based key storage).
- Text CRDT merging inside memory bodies.

## Key Decisions

- Replication unit is an append-only ops log + per-peer cursors.
- Deletions are represented as tombstones (no hard deletes during normal operation).
- Transport is "boring": LAN/Tailscale connectivity is assumed; no libp2p.
- Discovery is hybrid:
  - LAN uses mDNS/Bonjour.
  - Tailscale uses stored addresses (MagicDNS hostname and/or 100.x IP).

## Data Model (SQLite)

Note: private keys are not stored in SQLite in Phase 1.

### 1) Tombstones

Add `deleted_at` to replicated entities (at minimum):

- memories
- observations

If there are join/association tables that affect "what exists" (e.g., memory <-> observation links), add tombstone semantics there too, or replicate those links via ops.

### 2) Ops Log

Create `replication_ops` (append-only):

- `op_id` (uuid, primary key)
- `entity_type` (text)
- `entity_id` (text/uuid)
- `op_type` (text: upsert|delete)
- `payload_json` (text/json) for upsert (canonical replicated fields)
- `clock` (text or int fields; see "Clock" below)
- `device_id` (text)
- `created_at` (timestamp)

Canonical payload fields should include enough to rebuild the row (excluding local-only columns).

### 3) Per-Peer Cursors

Create `replication_cursors`:

- `peer_device_id` (text, primary key)
- `last_applied_cursor` (text)
- `last_acked_cursor` (text, optional)
- `updated_at` (timestamp)

Cursor can be `created_at+op_id` ordering, an integer sequence, or another monotonic ordering derived from the ops table.

### 4) Peers

Create `sync_peers`:

- `peer_device_id` (text, primary key)
- `name` (text)
- `pinned_pubkey` or `pinned_fingerprint` (text)
- `addresses_json` (text/json array)
- `created_at` (timestamp)
- `last_seen_at` (timestamp)
- `last_sync_at` (timestamp)
- `last_error` (text)

### 5) Sync Attempts (small log)

Create `sync_attempts`:

- `id` (integer pk)
- `peer_device_id` (text)
- `started_at` (timestamp)
- `finished_at` (timestamp)
- `ok` (boolean)
- `ops_in` (int)
- `ops_out` (int)
- `error` (text)

Keep this bounded (e.g., delete older rows beyond N per peer).

## Clock / Conflict Policy

Phase 1 should be deterministic and easy to reason about.

Recommended clock:

- Per-record `rev` integer incremented on each local mutation (upsert/delete).
- Tie-breaker tuple `(rev, updated_at, device_id)` for LWW ordering.

Apply rules:

- Ops are idempotent via `op_id` de-dupe.
- For a given entity, apply ops in stable order.
- Tombstone wins over older updates.
- A later update with a strictly newer clock can "revive".

Conflict handling:

- Default: LWW; no deep merge.
- Optional if needed: create a conflict copy when two concurrent upserts with different payloads have indistinguishable clocks. (Prefer to avoid this by making the clock total-orderable.)

## Keys / Identity (Phase 1)

- Generate a stable local `device_id` (uuid) on `sync enable`.
- Generate a keypair for auth.
- Store the private key on disk with strict permissions:
  - `~/.config/codemem/keys/device.key` (0600)
  - store public key/fingerprint in SQLite.

Phase 2: store private key in OS keychain (macOS Keychain, Linux Secret Service) with file fallback.

## Sync Protocol (Application Layer)

Expose a small HTTP API from the sync daemon.

Endpoints:

- `GET /v1/status`
  - returns `device_id`, protocol version, public key fingerprint
- `GET /v1/ops?since=<cursor>&limit=<N>`
  - returns ops page + `next_cursor`
- `POST /v1/ops`
  - accepts a list of ops
  - idempotent insert (dedupe by `op_id`)

Authentication:

- Phase 1 should authenticate peers using pinned keys from pairing.
- Encryption options:
  - TLS with pinned public keys, OR
  - request signing with the pinned keys (still authenticated) and bind only to LAN/Tailscale addresses.

Pick the simplest secure approach that fits existing repo patterns.

## Discovery and Addressing

### LAN

- Advertise via mDNS/Bonjour: service `_codemem._tcp` with port and device_id.
- Resolve by device_id during dialing.

### Tailscale

- Do not rely on mDNS across tailnet.
- Pairing should record MagicDNS hostname and/or 100.x address if available.

### Dial Order

For each peer, try:

1) mDNS resolution (LAN)
2) last-known-good address (cache after successful sync)
3) stored Tailscale DNS/IP
4) remaining stored addresses

Use short timeouts and backoff.

## Daemon and Autostart

Use a single long-running daemon command:

- `codemem sync daemon`

Responsibilities:

- Start listeners for each configured bind address.
- Run outbound periodic sync loop (`sync.auto.interval`).
- Update `sync_peers` last_seen/last_sync and append `sync_attempts`.

### Config (file)

Update `~/.config/codemem/config.json` with:

- `sync.enabled` (bool)
- `sync.listen.port` (int; default 7337)
- `sync.listen.bind` (array of IPs/hosts)
- `sync.auto.interval` (duration)
- discovery toggles as needed (e.g., `sync.discovery.mdns=true`)

### macOS: LaunchAgent

- Install: `~/Library/LaunchAgents/com.codemem.sync.plist`
- Command: `codemem sync daemon`

### Linux: systemd user service

- Install: `~/.config/systemd/user/codemem-sync.service`
- Enable: `systemctl --user enable --now codemem-sync.service`

Fallback:

- If service install fails, print the manual command to run the daemon.

## CLI Surface (Phase 1)

- `codemem sync enable`
  - generate device_id + keys if missing
  - write config, start user service
  - print pairing instructions and `sync status`
- `codemem sync disable`
  - set `sync.enabled=false`, stop/disable service
  - do not delete keys/peers
- `codemem sync status`
  - show enabled state, device_id, binds/port, peers summary, last errors
- `codemem sync pair`
  - print pairing code (and QR if easy)
- `codemem sync pair --accept <code>`
  - store peer with pinned key + addresses
- `codemem sync peers list|remove|rename`
- `codemem sync once [--peer NAME|--all]`

## Manual Import/Export Alignment

Phase 1 can keep existing memory export/import, but the ops log should become a shared interchange format.

Nice-to-have in Phase 1 (if low effort):

- `codemem export-ops` and `codemem import-ops`

So P2P sync is just streaming the same ops bundles.

## Tests (Phase 1)

- Merge engine unit tests:
  - idempotency (reapply same ops)
  - delete vs update ordering
  - cursor correctness
- Convergence test:
  - two temp DBs, exchange ops A->B then B->A (and different orderings), final state matches
- Protocol tests:
  - in-process server/client; avoid flaky network dependency

Run expectations:

- `uv run pytest`
- `uv run ruff check codemem tests`

## Acceptance Criteria

- Sync is off by default.
- User can enable sync on two machines (macOS or Linux), pair them, and they converge.
- Works on same LAN (mDNS) and over Tailscale (stored DNS/IP).
- Deterministic results (no duplicate ops, stable merge).
- No central service required.

## Phase 2 (UI + Settings)

- Viewer pages/panels:
  - Sync status (enabled, binds, last sync, pending ops, last error)
  - Peers list (last seen, last sync, addresses), actions (sync now, rename/remove)
- Settings dialog additions for sync config.
- Key storage via OS keychain (with fallback).

## Handoff Prompt (for OpenCoder / GPT-5.2-codex)

Implement Phase 1 of this plan in the existing codemem repo.

Constraints:

- Follow repo style and the standards in `/Users/adam/.config/opencode/context/core/standards/code-quality.md` and `/Users/adam/.config/opencode/context/core/standards/test-coverage.md`.
- Keep changes pragmatic and debuggable; avoid new heavy deps unless needed.
- No web UI changes in Phase 1.

Deliverables:

- Schema/migrations + ops log + tombstones.
- Sync daemon + CLI commands listed above.
- LAN mDNS discovery + Tailscale address fallback.
- Tests demonstrating deterministic convergence.
- Minimal docs update describing how to enable/pair/status/troubleshoot.
