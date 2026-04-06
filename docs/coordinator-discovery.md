# Coordinator-backed discovery

Use coordinator-backed discovery when peers are usually reachable but their addresses change often or mDNS does not cross
the network boundary you care about (for example VPNs).

## What it does

- gives devices a stable discovery/presence plane through a self-hosted coordinator
- lets devices publish current dialable addresses
- lets peers look up fresh addresses before direct sync
- keeps direct peer-to-peer sync as the data path
- can make same-group devices visible for operator review and future onboarding flows

## What it does not do

- it does not relay memory payloads
- it does not queue offline sync data
- it does not replace local SQLite as the source of truth
- it is not a codemem-hosted public service
- it does not automatically create or repair `sync_peers`
- joining a coordinator group does not, by itself, create an active sync relationship

## Config

Set these to enable coordinator-backed discovery:

- `sync_coordinator_url`
- either `sync_coordinator_group` or `sync_coordinator_groups`

Optional knobs:

- `sync_coordinator_timeout_s` - request timeout for coordinator calls (default: `3`)
- `sync_coordinator_presence_ttl_s` - advertised presence TTL in seconds (default: `180`)
- `sync_mdns` - keep LAN mDNS discovery enabled or disable it independently
- `sync_advertise` - controls which local addresses are published to peers and the coordinator

Environment variable equivalents:

- `CODEMEM_SYNC_COORDINATOR_URL`
- `CODEMEM_SYNC_COORDINATOR_GROUP`
- `CODEMEM_SYNC_COORDINATOR_GROUPS`
- `CODEMEM_SYNC_COORDINATOR_TIMEOUT_S`
- `CODEMEM_SYNC_COORDINATOR_PRESENCE_TTL_S`

Example config:

```json
{
  "sync_enabled": true,
  "sync_coordinator_url": "https://coord.example.com",
  "sync_coordinator_group": "team-alpha",
  "sync_coordinator_timeout_s": 3,
  "sync_coordinator_presence_ttl_s": 180,
  "sync_advertise": "tailscale"
}
```

Multi-group config is also supported:

```json
{
  "sync_coordinator_url": "https://coord.example.com",
  "sync_coordinator_groups": ["team-alpha", "lab"]
}
```

Backward compatibility:

- `sync_coordinator_group` still works
- when only the legacy single-group field is set, codemem treats it as a one-item `sync_coordinator_groups`
- when `sync_coordinator_groups` is set, the first entry becomes the legacy single-group value for compatibility with
  older surfaces

## Built-in coordinator service

The preferred self-hosted deployment path is the first-party TypeScript coordinator service shipped in the main
`codemem` CLI. Its HTTP surface is implemented with Hono and exposed through `codemem coordinator serve`.

`coordinator` is now a **top-level command** (`codemem coordinator ...`). The legacy path `codemem sync coordinator ...`
still works as a compatibility alias but is hidden from help and shell completion.

Current shipped local coordinator CLI surface:

```fish
codemem coordinator group-create team-alpha --db-path ~/.codemem/coordinator.sqlite
codemem coordinator list-groups --db-path ~/.codemem/coordinator.sqlite
codemem coordinator enroll-device team-alpha <device-id> --fingerprint <fingerprint> --public-key-file ~/.codemem/keys/device.key.pub --db-path ~/.codemem/coordinator.sqlite
codemem coordinator list-devices team-alpha --db-path ~/.codemem/coordinator.sqlite
codemem coordinator rename-device team-alpha <device-id> --name "work-laptop" --db-path ~/.codemem/coordinator.sqlite
codemem coordinator disable-device team-alpha <device-id> --db-path ~/.codemem/coordinator.sqlite
codemem coordinator remove-device team-alpha <device-id> --db-path ~/.codemem/coordinator.sqlite
codemem coordinator list-bootstrap-grants team-alpha --db-path ~/.codemem/coordinator.sqlite
codemem coordinator revoke-bootstrap-grant <grant-id> --db-path ~/.codemem/coordinator.sqlite
codemem coordinator serve --db-path ~/.codemem/coordinator.sqlite --host 0.0.0.0 --port 7347
codemem coordinator create-invite team-alpha --db-path ~/.codemem/coordinator.sqlite
codemem coordinator import-invite <invite>
codemem coordinator list-join-requests team-alpha --db-path ~/.codemem/coordinator.sqlite
codemem coordinator approve-join-request <request-id> --db-path ~/.codemem/coordinator.sqlite
codemem coordinator deny-join-request <request-id> --db-path ~/.codemem/coordinator.sqlite
```

This keeps the primary deployment path inside the main `codemem` artifact and reuses the current TypeScript sync
auth/signature verification code directly.

These group/device management commands operate on the built-in local coordinator store only in the current TS CLI.
Remote coordinator admin for invites and join-request review exists separately; remote device-admin parity remains a
follow-up.

## Discovery groups vs sync peers

Coordinator group membership and sync peer relationships are not the same thing.

- **Coordinator group membership** means a device is enrolled and can participate in coordinator-backed discovery.
- **Sync peer** means a local device has an explicit `sync_peers` relationship it will use for direct replication.

Today, coordinator-backed discovery refreshes dialable addresses for sync, but it does not automatically create, repair,
or remove local `sync_peers` entries. That means a same-group device can be enrolled and discoverable without becoming
an active sync peer.

## How discovery works

With coordinator-backed discovery enabled, codemem uses three sources of peer addresses:

1. fresh coordinator presence records
2. locally cached peer addresses in `sync_peers.addresses_json`
3. mDNS-discovered addresses on LANs where mDNS works

Dial preference is intentionally conservative:

1. coordinator responses refresh the stored peer-address cache
2. if mDNS returns addresses on the current LAN, codemem still tries those first
3. otherwise codemem uses the stored address cache, which may have been refreshed by the coordinator

If the coordinator is unavailable, codemem falls back to cached addresses and mDNS.

Address storage is normalized to explicit base URLs (for example `http://host:7337`) so equivalent discovery results do
not accumulate as mixed `host:port` and `http://host:port` variants in local peer caches.

## Auth model

- the coordinator is self-hosted/operator-run
- devices authenticate with their existing sync keypair
- enrollment is explicit per device/group
- there is no username/password or codemem-operated account layer in this model

## Remote admin flow

Built-in local coordinator management commands operate directly on the local SQLite store.

For remote coordinators, the first admin model uses a separate operator-managed admin secret. The currently shipped TS
CLI uses that remote admin path for invite creation and join-request review; remote device-admin parity is deferred.

Device participation auth still uses the enrolled device keypair for `presence` and `peers` endpoints; the admin secret
is only for remote mutation/listing endpoints.

## Canonical deployment target

The built-in coordinator (`codemem coordinator serve`) is the canonical deployment target for ongoing product
development, E2E validation, and dogfooding.

Recommended deployment patterns:

- **Native**: run `codemem coordinator serve` on a reachable machine (VPS, homelab, always-on workstation)
- **Container**: run via Docker/Podman with the coordinator SQLite volume mounted
- **Exposure**: use Tailscale Funnel or Cloudflare Tunnel to make the coordinator reachable from outside a local network

This keeps the deployment path inside the main `codemem` artifact and ensures new coordinator features (invites, join
requests, admin flows) are immediately available. It is also the fastest path to validate coordinator behavior before
introducing Cloudflare-specific runtime/storage constraints.

## Cloudflare Worker reference deployment

A Cloudflare Worker deployment path exists for the coordinator contract. The current Worker implementation source lives in
`packages/cloudflare-coordinator-worker/`, while `examples/cloudflare-coordinator/` provides helper tooling around that
package worker.

If you are deploying on Cloudflare Workers + D1, use `docs/cloudflare-coordinator-deployment.md` as the canonical
runbook.

It remains useful for experimentation, but it is not the canonical runtime for current product development.

The long-term Cloudflare direction should build from the TypeScript coordinator contract rather than from the old Python
era deployment story. Today, the practical sequence is:

1. validate the built-in TS coordinator on Node/Linux with `codemem coordinator serve`
2. adapt/package that validated coordinator surface for Cloudflare

Use the Worker reference path only when you specifically want a serverless/edge experiment and are comfortable with
feature lag — new coordinator capabilities may land in the built-in coordinator first and may not be ported to the
reference Worker immediately. When you do choose it, follow the dedicated Cloudflare runbook instead of relying on the
older scattered example notes.

## Current limitations

- no relay/proxy transport yet
- no offline buffered delivery yet
- no central search or server-side memory store
- no richer enrollment UX beyond explicit operator setup

Those are deliberate non-goals for the coordinator MVP.
