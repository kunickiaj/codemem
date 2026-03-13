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

Set both of these to enable coordinator-backed discovery:

- `sync_coordinator_url`
- `sync_coordinator_group`

Optional knobs:

- `sync_coordinator_timeout_s` - request timeout for coordinator calls (default: `3`)
- `sync_coordinator_presence_ttl_s` - advertised presence TTL in seconds (default: `180`)
- `sync_mdns` - keep LAN mDNS discovery enabled or disable it independently
- `sync_advertise` - controls which local addresses are published to peers and the coordinator

Environment variable equivalents:

- `CODEMEM_SYNC_COORDINATOR_URL`
- `CODEMEM_SYNC_COORDINATOR_GROUP`
- `CODEMEM_SYNC_COORDINATOR_TIMEOUT_S`
- `CODEMEM_SYNC_COORDINATOR_PRESENCE_TTL_S`

Example config:

```json
{
  "sync_enabled": true,
  "sync_coordinator_url": "https://coord.example.workers.dev",
  "sync_coordinator_group": "team-alpha",
  "sync_coordinator_timeout_s": 3,
  "sync_coordinator_presence_ttl_s": 180,
  "sync_advertise": "tailscale"
}
```

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

This keeps the primary deployment path inside the main `codemem` artifact and reuses the existing Python signature
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

## Auth model

- the coordinator is self-hosted/operator-run
- devices authenticate with their existing sync keypair
- enrollment is explicit per device/group
- there is no username/password or codemem-operated account layer in this model

## Cloudflare Worker reference deployment

The design targets a runtime-agnostic HTTP contract, but a Cloudflare Worker is the canonical low-cost reference
deployment.

That means the coordinator API should be simple enough to implement anywhere, but the first example deployment is
expected to be a Worker-backed service at a stable address.

The Cloudflare Worker remains an optional alternate reference deployment. Its scaffold lives in a follow-up PR in this
stack, not in this docs-only change.

## Current limitations

- no relay/proxy transport yet
- no offline buffered delivery yet
- no central search or server-side memory store
- no richer enrollment UX beyond explicit operator setup

Those are deliberate non-goals for the coordinator MVP.
