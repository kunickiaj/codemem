# Coordinator-backed discovery

Use coordinator-backed discovery when peers are usually reachable but their addresses change often or mDNS does not cross
the network boundary you care about (for example VPNs).

## What it does

- gives devices a stable discovery/presence plane through a self-hosted coordinator
- lets devices publish current dialable addresses
- lets peers look up fresh addresses before direct sync
- keeps direct peer-to-peer sync as the data path

## What it does not do

- it does not relay memory payloads
- it does not queue offline sync data
- it does not replace local SQLite as the source of truth
- it is not a codemem-hosted public service

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

The preferred self-hosted deployment path is a first-party `codemem` coordinator service.

Basic flow:

```fish
codemem sync coordinator group-create team-alpha --db-path ~/.codemem/coordinator.sqlite
codemem sync coordinator enroll-device team-alpha <device-id> --fingerprint <fingerprint> --public-key-file ~/.codemem/keys/id_ed25519.pub --db-path ~/.codemem/coordinator.sqlite
codemem sync coordinator list-devices team-alpha --db-path ~/.codemem/coordinator.sqlite
codemem sync coordinator rename-device team-alpha <device-id> --name "work-laptop" --db-path ~/.codemem/coordinator.sqlite
codemem sync coordinator disable-device team-alpha <device-id> --db-path ~/.codemem/coordinator.sqlite
codemem sync coordinator remove-device team-alpha <device-id> --db-path ~/.codemem/coordinator.sqlite
codemem sync coordinator serve --db-path ~/.codemem/coordinator.sqlite --host 0.0.0.0 --port 7347
```

This keeps the primary deployment path inside the main `codemem` artifact and reuses the existing signature
verification code directly.

These management commands operate on the built-in local coordinator store only. Remote coordinator admin flows require a
separate access-control model before they should be exposed over HTTP.

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

For remote coordinators, the first admin model uses a separate operator-managed admin secret. Remote management commands
reuse the same `codemem sync coordinator ...` verbs, but target a remote coordinator when you pass `--remote-url` and
an admin secret (or configure `sync_coordinator_admin_secret`).

Examples:

```fish
codemem sync coordinator list-devices nerdworld --remote-url "https://coord.codemem.sh"
codemem sync coordinator enroll-device nerdworld <device-id> --fingerprint <fingerprint> --public-key-file ~/.codemem/keys/device.key.pub --remote-url "https://coord.codemem.sh"
codemem sync coordinator rename-device nerdworld <device-id> --name "work-laptop" --remote-url "https://coord.codemem.sh"
```

Device participation auth still uses the enrolled device keypair for `presence` and `peers` endpoints; the admin secret
is only for remote mutation/listing endpoints.

## Canonical deployment target

The built-in coordinator (`codemem sync coordinator serve`) is the canonical deployment target for ongoing
product development and dogfooding.

Recommended deployment patterns:

- **Native**: run `codemem sync coordinator serve` on a reachable machine (VPS, homelab, always-on workstation)
- **Container**: run via Docker/Podman with the coordinator SQLite volume mounted
- **Exposure**: use Tailscale Funnel or Cloudflare Tunnel to make the coordinator reachable from outside a local network

This keeps the deployment path inside the main `codemem` artifact and ensures new coordinator features (invites, join
requests, admin flows) are immediately available.

## Cloudflare Worker reference deployment

A Cloudflare Worker reference implementation exists in `examples/cloudflare-coordinator/`. It implements the same HTTP
contract against D1, but is secondary to the built-in coordinator for ongoing feature development.

Use the Cloudflare Worker path when you specifically want a serverless/edge deployment and are comfortable with the
feature lag — new coordinator capabilities (invite/join flows, admin endpoints) land in the built-in coordinator first
and may not be ported to the Worker immediately.

## Current limitations

- no relay/proxy transport yet
- no offline buffered delivery yet
- no central search or server-side memory store
- no richer enrollment UX beyond explicit operator setup

Those are deliberate non-goals for the coordinator MVP.
