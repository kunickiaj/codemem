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
- it does not turn discovery-group membership into project access
- joining a coordinator group does not, by itself, create an active sync relationship
- joining a coordinator group does not, by itself, grant access to any Sharing domain

The normal viewer flow can still use the coordinator to complete a Team, direct-Project, or add-device invitation. Those flows create explicit identity, trust, and Project-access records; discovery-group membership alone does not.

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
codemem coordinator list-scopes team-alpha --db-path ~/.codemem/coordinator.sqlite
codemem coordinator create-scope team-alpha acme-work --label "Acme Work" --db-path ~/.codemem/coordinator.sqlite
codemem coordinator update-scope team-alpha acme-work --label "Acme Work" --db-path ~/.codemem/coordinator.sqlite
codemem coordinator list-scope-members team-alpha acme-work --db-path ~/.codemem/coordinator.sqlite
codemem coordinator grant-scope-member team-alpha acme-work <device-id> --effect-id <effect-id> --db-path ~/.codemem/coordinator.sqlite
codemem coordinator revoke-scope-member team-alpha acme-work <device-id> --effect-id <effect-id> --db-path ~/.codemem/coordinator.sqlite
codemem coordinator rename-device team-alpha <device-id> --name "work-laptop" --db-path ~/.codemem/coordinator.sqlite
codemem coordinator disable-device team-alpha <device-id> --db-path ~/.codemem/coordinator.sqlite
codemem coordinator remove-device team-alpha <device-id> --db-path ~/.codemem/coordinator.sqlite
codemem coordinator list-bootstrap-grants team-alpha --db-path ~/.codemem/coordinator.sqlite
codemem coordinator revoke-bootstrap-grant <grant-id> --db-path ~/.codemem/coordinator.sqlite
codemem coordinator serve --db-path ~/.codemem/coordinator.sqlite --coordinator-host 0.0.0.0 --coordinator-port 7347
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

## Optional account linking

The account-link command and optional app integration are implemented, but
browser checks and live Google setup remain required before a dogfood pilot. Default
coordinators return `404` for these routes; this command does not enable them or
configure Google. The coordinator must already have reviewed ownership for this
enrolled device's exact key and existing Identity.

Run it from a terminal on the device being linked:

```fish
codemem coordinator link-account team-alpha --coordinator "https://coord.example.com"
codemem coordinator link-account team-alpha --coordinator "https://coord.example.com" --loopback-host "::1"
```

`--config` can select the saved coordinator configuration. Here, `--db-path`
selects the **device's memory database**, not the coordinator database used by
admin commands. `CODEMEM_KEYS_DIR` selects existing device keys when configured;
the command never creates keys, enrolls a device, adopts another Identity, or
changes Project access. Remote coordinators require HTTPS; literal HTTP loopback
origins are allowed only for local development.

Open the private link printed to terminal stderr, review the account, Identity,
and device in the browser, then return to the coordinator tab to finish. Do not
share or log the link. JSON and nonterminal execution are rejected before an
attempt starts so the private URL cannot enter structured output.

The command holds an exact IPv4 or IPv6 loopback listener before creating the
attempt, signs its requests with the existing device key, and waits at most ten
minutes. Interrupting it attempts to cancel only its own request. If cancellation
or the final reply cannot be confirmed, the command reports that uncertainty
instead of claiming a rollback; an already completed link may still exist.

## Discovery groups vs sync peers

Coordinator group membership and sync peer relationships are not the same thing.

- **Coordinator group membership** means a device is enrolled and can participate in coordinator-backed discovery.
- **Sync peer** means a local device has an explicit `sync_peers` relationship it will use for direct replication.
- **Sharing-domain membership** means a device is explicitly granted access to a `scope_id` such as `acme-work`.

Today, coordinator-backed discovery refreshes dialable addresses for sync, but it does not automatically create, repair,
or remove local `sync_peers` entries. That means a same-group device can be enrolled and discoverable without becoming
an active sync peer.

The same separation applies to Sharing domains: being in `team-alpha` does not
authorize a device to receive `acme-work`, `personal:<actor_id>`, or any other
domain. The coordinator group is the administrative container. The Sharing
domain grant is the data-access decision.

In the normal viewer vocabulary, people join **Teams**, share exact **Projects**, and review inherited Projects when adding a **device**. **Spaces** are the user-facing access boundaries. Advanced coordinator commands expose the underlying group, Sharing-domain, grant, and `scope_id` records used to enforce those choices.

## Project-first sharing and advanced administration

For an ongoing group, use two separate steps:

1. Assign exact **Projects** to a **Team**.
2. Send **Invite Team member**.

That onboarding invitation does not create Project-to-Team assignments. It links the Identity and device, then inherits every current and future Project already assigned to the Team. Review those Projects before sending or accepting the invitation.

For a direct share:

1. Choose **Share exact Projects** and select one Identity and the exact Projects.
2. Review existing-memory counts and future sharing, then send the expiring invitation.
3. The recipient reviews and accepts it before initial sync starts.

When an existing Identity adds another device, create an add-device invitation and review the exact Projects inherited from that Identity's direct and Team access. Acceptance cannot add unrelated Projects or remove existing exclusions.

The coordinator remains the authority for the invite and access steps, but its groups, devices, Spaces, grants, and project mappings are advanced administration—not normal teammate setup. Legacy coordinator invites and manual pairing remain compatible, but do not grant project access by themselves.

## Sharing-domain membership and revocation

Use coordinator Sharing-domain commands when a group needs explicit access
boundaries inside the same discovery/admin group. A common setup is one group
for `team-alpha`, with separate domains such as `acme-work`, `oss-codemem`, and
possibly one personal domain per actor-owned device set.

Minimal flow:

```fish
codemem coordinator create-scope team-alpha acme-work --label "Acme Work" --db-path ~/.codemem/coordinator.sqlite
codemem coordinator grant-scope-member team-alpha acme-work <device-id> --effect-id <effect-id> --db-path ~/.codemem/coordinator.sqlite
codemem coordinator list-scope-members team-alpha acme-work --db-path ~/.codemem/coordinator.sqlite
```

Operational rules:

- Effect ids make membership mutations deterministic and idempotent; use a stable unique value for each intended mutation.
- Grants and revocations are explicit per `(group, scope_id, device_id)`.
- Membership epochs make cached grants stale after revocation or replacement.
- Revocation stops future sync after peers refresh membership. It does not erase
  memories already copied to a revoked device.
- Disabling a device enrollment revokes future delivery only for that coordinator group; merely being offline does not. The global identity device can remain active and retain access through other groups.
- Re-enabling that group enrollment clears the disabled state. The next owner reconciliation pass restores only the Projects currently authorized through direct shares and Team policies for the group; unrelated Projects stay absent. A global identity-device revocation is separate and is not restored by re-enabling a group enrollment.
- Project include/exclude filters can only narrow data after the Sharing-domain
  membership check passes.
- Local-only domains and migration review domains are not valid broad sharing
  targets.

If the coordinator is unavailable, peers can still attempt direct sync using
cached peer addresses and cached membership state. They must not treat a
coordinator outage as permission to widen access. When membership cannot be
verified for a scoped operation, fail closed or keep data local until the cache
is refreshed.

### Compatibility and reassignment

Project-first sharing may move selected project history into a managed boundary. For history that could already have replicated, participating owner devices must negotiate support for `reassign_scope`. If a required device lacks that capability, setup fails closed before any partial migration; update that device and retry the sharing operation.

Older invitations and pairing payloads continue to parse through their legacy enrollment paths. They remain valid for compatibility, but are clearly separate from a project-scoped invite and cannot silently acquire its access.

## How discovery works

With coordinator-backed discovery enabled, codemem uses three sources of peer addresses:

1. fresh coordinator presence records
2. locally cached peer addresses in `sync_peers.addresses_json`
3. mDNS-discovered addresses on LANs where mDNS works

Dial preference is intentionally conservative:

1. coordinator responses refresh the stored peer-address cache
2. if mDNS returns addresses on the current LAN, codemem still tries those first
3. otherwise codemem uses the stored address cache, which may have been refreshed by the coordinator

Codemem keeps at most eight normalized addresses per peer in the active cache and during direct dialing. Fresh coordinator
candidates come first, with up to six slots reserved when enough candidates exist, even if paired addresses fill the cache.
Coordinator IPv6 link-local candidates come after other fresh candidates; order within each group stays unchanged. This
keeps link-local interface addresses from crowding out candidates usable across network boundaries, without guessing which
IPv4 address or network will work. Link-local addresses remain eligible, including manually paired and successful fallbacks.

When six fresh candidates occupy the active cache, up to two protected fallbacks remain, with the last successful address
first, followed by manually paired addresses. Fewer fresh candidates leave more room for fallbacks. Explicitly paired
addresses retain their separate stored copy across refreshes. Verified re-pairing preserves the supplied address order and
reserves enough slots for those addresses (up to eight), even when that leaves less room for fallbacks.

For older peers whose addresses predate source tracking, codemem retains the original list separately and includes the
first and last two as fallback candidates when it compacts the active cache; available fallback slots determine how many
remain active. This preserves the original data without allowing thousands of obsolete Docker, VPN, DHCP, or temporary
IPv6 addresses to consume a daemon tick in serial attempts.

If the coordinator is unavailable, codemem falls back to cached addresses and mDNS.

Address storage is normalized to explicit base URLs (for example `http://host:7337`) so equivalent discovery results do
not accumulate as mixed `host:port` and `http://host:port` variants in local peer caches.

## Auth model

- the coordinator is self-hosted/operator-run
- devices authenticate with their existing sync keypair
- enrollment is explicit per device/group
- there is no username/password or codemem-operated account layer in this model

Direct sync authentication failures always return a generic `401 unauthorized` response. Recipient mismatches and
signature downgrades are recorded only in server-side diagnostics so publicly reachable listeners do not disclose peer
enrollment or signature-validation details.

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
`packages/cloudflare-coordinator-worker/`, while `examples/cloudflare-coordinator/` now only provides a Wrangler config
wrapper around that package worker.

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

## Direct peer HTTP connections

Recipient-bound direct peer requests close their HTTP connection after each response, including status and snapshot reads. Sync preparation can block the sender's event loop long enough for an earlier connection to exceed the peer's idle timeout; reusing that connection can then fail before a write receives an HTTP response.

This connection policy does not change signatures, device trust, sharing grants, request bodies, or cursor acknowledgements. It does not retry failed writes automatically. Coordinator and administrator requests keep their existing connection policy. The tradeoff is an extra connection handshake for each direct peer request.

## Peer-memory cleanup

Peer-memory cleanup resolves authorization once per scope within each cleanup transaction, rather than repeating the same database queries for every memory. Each new cleanup transaction starts with fresh lookups, so membership, revocation, and policy changes are not hidden by a cache shared across sync passes.

## Always-on peers

If you need a high-uptime sync backstop, deploy an anchor peer separately from
the coordinator. The anchor peer is a normal codemem peer with explicit
Sharing-domain grants and its own local SQLite database. See
[`docs/anchor-peer-deployment.md`](anchor-peer-deployment.md).

## Current limitations

- no relay/proxy transport yet
- no offline buffered delivery yet
- no central search or server-side memory store
- no richer enrollment UX beyond explicit operator setup

Those are deliberate non-goals for the coordinator MVP.
