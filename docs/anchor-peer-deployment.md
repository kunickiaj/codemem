# Anchor-peer deployment with Sharing domains

An **anchor peer** is a normal codemem peer that happens to have high uptime. It
is useful as a stable sync backstop for laptops, but it is not a coordinator,
gateway, quorum node, backbone tier, or special protocol role.

The rules are the same as for every other peer:

- The peer has its own device key and local SQLite database.
- It only receives memories for Sharing domains where it has explicit scope
  membership.
- Project include/exclude filters can narrow what it receives, but they cannot
  grant access.
- The coordinator can help devices discover the anchor peer, but memory payloads
  still move directly peer-to-peer.
- If the anchor peer is revoked from a Sharing domain, it stops receiving future
  sync for that domain. Already-copied data on its disk is not erased.

## Deployment shapes

### Solo local use

No anchor peer is needed. One device writes to its local SQLite database. Keep
unknown projects local-only until you intentionally map them to a Sharing domain.

### Personal multi-device sync

Use a personal Sharing domain, for example `personal:adam`, and grant only your
own devices to it. A home server, Pi, or small VPS can join that personal domain
as an anchor peer if you want memories available when laptops sleep.

Recommended shape:

- laptop: member of `personal:adam`
- desktop: member of `personal:adam`
- home/Pi anchor peer: member of `personal:adam`
- coordinator: optional discovery plane, not a data path

### Small team VPS

For a small team, run one always-on peer on a VPS and grant it only to the team
domains it should hold, such as `acme-work`. Do not grant it to personal or
client domains unless it intentionally needs those memories.

Recommended shape:

- teammates' laptops: members of `acme-work`
- VPS anchor peer: member of `acme-work`
- optional OSS domain: separate `oss-codemem` membership if the VPS should hold
  OSS memories too
- coordinator: can run on the same VPS for discovery/admin, but it remains
  separate from the anchor peer's local memory database

### Organization with three always-on peers

For higher availability, run three always-on peers. They are still three normal
peers, not a quorum cluster. Each peer has a local SQLite database and syncs via
the same peer protocol as laptops.

Recommended shape:

- three k8s pods or VMs running codemem as regular peers
- each peer has explicit membership in the org/team Sharing domains it should
  hold
- each peer has durable local storage if you want it to survive restarts without
  a full re-bootstrap
- laptops sync with whichever peer is reachable; the always-on peers converge
  with each other through normal peer sync

If one always-on peer dies, the remaining peers continue holding their local
copies. A replacement peer should be enrolled, granted the intended Sharing
domains, and bootstrapped from existing peers.

## Storage and backups

Anchor peers are local-first peers, so their SQLite database matters. For VPS or
k8s deployments:

- Use a persistent disk or PVC for the codemem runtime directory.
- Back up the SQLite database and device key material together.
- Treat the device key as sensitive: a peer with the key can authenticate as that
  anchor peer.
- Prefer filesystem or volume snapshots taken while the process is stopped, or
  use SQLite-safe backup tooling.
- Test restore by starting a replacement peer from the backup and verifying it
  still has the expected device identity and Sharing-domain membership.

If you use ephemeral storage, the peer can still be useful as a cache/backstop
while it is running, but it must re-bootstrap after restart.

## Granting scopes intentionally

Coordinator group enrollment is not enough. Grant the anchor peer to each
Sharing domain explicitly:

```fish
codemem coordinator grant-scope-member team-alpha acme-work <anchor-device-id> --db-path ~/.codemem/coordinator.sqlite
codemem coordinator grant-scope-member team-alpha oss-codemem <anchor-device-id> --db-path ~/.codemem/coordinator.sqlite
```

Review grants regularly:

```fish
codemem coordinator list-scope-members team-alpha acme-work --db-path ~/.codemem/coordinator.sqlite
```

Revoke a domain when the anchor peer should stop receiving future data for it:

```fish
codemem coordinator revoke-scope-member team-alpha acme-work <anchor-device-id> --db-path ~/.codemem/coordinator.sqlite
```

Revocation is forward-looking. Rotate or destroy the anchor peer's local storage
if you need to remove data already copied there.

## What not to build around

- Do not assume an anchor peer is authoritative for a Sharing domain.
- Do not require a quorum of anchor peers for writes.
- Do not route memory payloads through the coordinator.
- Do not use project filters as a substitute for Sharing-domain grants.
- Do not put personal and work data on the same anchor peer unless both domains
  are intentionally granted to that peer.

The mental model is Syncthing-shaped: durable always-on devices improve
availability because they are online often, not because the protocol gives them
special powers.
