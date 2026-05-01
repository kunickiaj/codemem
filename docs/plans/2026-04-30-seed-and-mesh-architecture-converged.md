# Seed Peer & Mesh Architecture — Converged Position

**Date:** 2026-04-30
**Status:** accepted architecture direction
**Boundary semantics:** see `2026-04-30-sharing-domain-scope-design.md` for the sharing-domain (`scope_id`) model that this architecture rests on
**Historical option survey:** `2026-04-30-seed-and-mesh-architecture-research.md` (preserved for context; superseded where it conflicts with this doc or the scope design)

## Authoritative invariants

These invariants apply to all sharing/sync work in codemem and supersede any conflicting framing in older docs:

1. **Sharing domain (`scope_id`) is the hard data boundary in Phase 2.** Once a deployment is in Phase 2, a memory may only replicate to a peer if (a) the memory has a non-null `scope_id` recognized by both sides, AND (b) the peer is currently authorized for that `scope_id` at the latest known membership epoch. Memories with no `scope_id` MUST NOT replicate in Phase 2 except via an explicitly configured per-peer legacy compatibility scope, which is a documented, audited exception to this invariant — not an exemption from it.
2. **Project include/exclude only narrows.** Per-peer project filters can subtract from what a peer would otherwise receive. They never grant access to a scope the peer is not authorized for. Basename-style project matches are display-only and MUST NOT be used for any scope authorization decision.
3. **Coordinator group is a discovery, admin, and membership container.** Group membership is not data access. Scope grants are an explicit, separate, audited admin action whose record is independent of group membership changes. There is no auto-grant from group enrollment.
4. **Coordinator is never a data path.** It does not store, proxy, or relay memory payloads, and it is not a gateway in front of a backend.
5. **Seed/anchor peers are deployment artifacts.** A peer with high uptime is still a peer. There is no special protocol role for "backbone" or "seed" devices.
6. **Visibility gates eligibility, not authorization.** `visibility=shared` makes a memory eligible to leave the device; scope membership decides where it may go.
7. **Revocation prevents future sync only and is enforced per op batch.** Already-replicated data on a revoked device is not magically erased. Outbound sync MUST re-validate scope membership against the local membership cache before each op batch is sent. Cache TTL for scope membership is at most 60 seconds; longer TTLs are a documented operator exception with a stated revocation-lag SLA.
8. **Local-first.** Writes are durable locally before any replication; quorum writes are not a primitive.
9. **`sync_peers.claimed_local_actor` is retracted in Phase 2.** Same-actor private sync is expressed exclusively as membership in a `personal:<actor_id>` scope whose membership manifest is signed by an actor-controlled key. The legacy boolean MUST NOT bypass scope or visibility checks once a deployment is in Phase 2; Phase 1→2 promotion fails closed if any `sync_peer` still asserts `claimed_local_actor=1` without a corresponding `personal:` scope grant.
10. **Local-only scopes never escape the device that minted them.** Scopes with `authority_type='local'` (including all migration-created `local-default`, `legacy-shared-review`, and similar scopes) are not eligible for outbound replication in any phase. Their memories are local artifacts until an admin explicitly reassigns them to an authoritative scope.
11. **Inbound `scope_id` is taken from the op row, not re-resolved.** The receiver does not re-run project→scope resolution on incoming ops. The sender's resolution at minting time is binding for that op's `scope_id`. The receiver's job is to verify sender authorization, receiver authorization, and scope/payload consistency at the latest known epoch.

If a future change conflicts with one of these invariants, it must explicitly supersede the relevant invariant in a dated decision doc, not silently widen behavior.

## Purpose of this document

This doc captures the position the codemem team converged on after iterating through several architectural framings (centralized SQL, durable log, two-tier mesh with quorum). It is written to be self-contained so that an external reviewer (human or AI) can engage with it without reading the prior research doc — though that earlier doc records the alternatives we considered and rejected.

Read this doc with a critical eye. The author intentionally wants pushback on the assumptions, the protocol surface, the implementation budget, and the framing. Productive disagreement is the point.

## TL;DR

codemem should be **Syncthing-shaped, with structured op-logs instead of file blocks and explicit multi-user/group membership instead of Syncthing's single-user-multi-device default**.

The "central seed peer" we considered is reframed as a **deployment property, not a protocol primitive** — it is just an always-on peer in the swarm, exactly the way a BitTorrent seed is just a peer that holds the complete file. The protocol does not know that any peer is special.

A separate "backbone" tier with quorum semantics, distinct from "joiner" peers, is rejected. So is a "coordinator-as-gateway" pattern that proxies data. The coordinator's job is the minimum required to bridge network boundaries: discovery and group membership. mDNS handles the LAN case (already implemented).

The implementation work is intentionally bounded. The patterns we're adopting are well-established (Syncthing's BEP, BitTorrent's swarm model, Cassandra's anti-entropy, Dynamo's hinted handoff) and we are implementing them in TypeScript ourselves rather than depending on external services or new deployable infrastructure.

## Reference architectures

### Syncthing — the closest analogue

Syncthing is a peer-to-peer file synchronization tool. Each device holds full local copies of "folders" it shares with other devices. Discovery is a mix of a global discovery server (HTTPS), local UDP broadcast (mDNS-equivalent), and relay servers for NAT traversal. Authentication is mutual TLS pinned to device IDs derived from public keys.

Mapping codemem onto Syncthing:

| Syncthing | codemem | Status |
|---|---|---|
| Device ID (cert pubkey hash) | Device key | Already exists |
| Folder | Scope | To be added (additive schema) |
| Folder shared with N devices | Scope with N members | To be added |
| Global discovery server | Coordinator | Already exists (simplified role going forward) |
| Local discovery (UDP broadcast) | mDNS | Already exists (`packages/core/src/sync-discovery.ts`) |
| Relay servers | Optional, deferred | Not built |
| Block Exchange Protocol over TLS | HTTP/2 + mTLS over `/v1/ops` and `/v1/snapshot` | Already exists |
| Versioning | Lamport scalar clock + LWW + tombstones | Already exists |

The two material differences from Syncthing:

1. **Structured op-logs, not file blocks.** Sync exchanges discrete `replication_ops` keyed by `op_id` (UUID), not file chunks. Conflict resolution is LWW on Lamport-ordered ops, not Syncthing's file-versioning. The wire transport mechanics are otherwise the same shape.
2. **Multi-user team membership.** Syncthing assumes "your devices, your folders." codemem scopes have multiple humans, each with multiple devices, with cryptographically authorized member lists. The coordinator publishes the authorized device-key set per scope; peers verify membership when serving sync requests. This is a layer above the peer protocol, not a change to it.

### BitTorrent — the swarm intuition

BitTorrent's central insight: **with enough peers in a swarm, data persists as long as somebody is online holding it.** A "seed" in BT terminology is a peer that has the complete file. Other peers ("leechers" while incomplete, "seeds" once they have everything) exchange chunks via direct connections, with trackers (or DHT) helping with discovery.

For codemem this gives us the right mental model for durability:

- Data lives in the swarm. Each peer that's a member of a scope holds that scope's data.
- "Always-on peers" (whether $5 VPS or k8s deployment) are peers that don't go offline when humans close their laptops. They're in the swarm; they're not architecturally above it.
- An organization that wants strong availability deploys "enough always-on peers that the swarm has good connectivity even when humans aren't online." This is a deployment policy. The protocol doesn't care.
- If every always-on peer were to die, data would still exist on the laptops that produced it; the swarm degrades gracefully.

### Why not Dynamo / Cassandra

The earlier framing leaned on Dynamo's lineage (consistent hashing, sloppy quorum, hinted handoff, Merkle anti-entropy). Dynamo's model is a *fixed cluster of always-on nodes serving clients*. It does not fit codemem because:

- codemem's nodes ARE the clients (laptops produce memories)
- Membership is dynamic (humans come and go from teams)
- Peers are intermittently online by design (laptops sleep)
- We don't have a coordinator-elected leader for any partition

Two patterns from the Dynamo lineage do still apply because they generalize:

- **Anti-entropy via Merkle ranges** — the convergence engine when two peers meet
- **Hinted handoff** — store-and-forward when the intended recipient is unreachable

The pieces we explicitly drop: quorum write between peers, consistent-hash placement, SWIM membership protocol, cluster-wide failure detection. None of these fit a Syncthing-shaped peer-to-peer model.

## The codemem architecture, stated plainly

### Peers

Every peer is the same. A peer:

- Has a device key (public/private, already exists)
- Has a local SQLite database (already exists)
- Is a member of zero or more scopes
- Holds full local copies of every scope it is a member of
- Originates writes (memories extracted from coding sessions, observations, etc.)
- Replicates with other reachable members of the same scope, eventually consistent

There is no role distinction between "backbone," "joiner," "seed," or "coordinator-side." A peer is a peer. Some peers happen to be always-on; that is observable but not protocol-relevant.

### Scopes

A scope is the unit of sharing. Every memory and every replication op carries a `scope_id` (additive schema change). Scopes correspond to projects, teams, or workspaces — the user-facing concept TBD, but the underlying primitive is "set of device keys authorized to read/write this data."

Scope membership is a set of device keys, published and managed via the coordinator (or, in coordinator-less deployments, configured directly between peers). Membership changes are themselves cryptographically signed events; peers cache the latest membership and verify it on incoming sync requests.

### Discovery

Three mechanisms, in priority order:

1. **mDNS** — same-LAN peer discovery. Already implemented at `packages/core/src/sync-discovery.ts`. Gated by config or env var.
2. **Coordinator** — cross-network discovery and group membership directory. Already exists in a richer form than needed; we will pare it back to: groups, members per group, presence (which device key is currently reachable, at what address). The coordinator never sees memory data.
3. **Manual / configured addresses** — works when you know where a peer lives and don't need a discovery service. Already supported via `sync_peers` table.

Future addition (deferred): **relay** for NAT-traversal cases where direct connection fails. Syncthing has a community relay pool; codemem could do the same, or have peers relay through any reachable mutual member.

### Replication semantics

Writes are local-first. A peer writes to its own SQLite immediately. The write is durable from that peer's perspective the moment SQLite returns.

Sharing is best-effort fanout to reachable members of the same scope, with eventual convergence guaranteed by anti-entropy. Specifically:

- After a local write, the peer attempts to push the new ops to currently-reachable members of the scope.
- If a target member is unreachable, the ops are queued for later push (hinted handoff: "deliver this op to device X when X is reachable, OR when any other member of the scope can forward it").
- Periodically, pairs of peers exchange Merkle summaries of their op-log per shared scope. On hash mismatch, they exchange the actual missing ops via the existing `/v1/ops` endpoint.
- On cold start (new device joins a scope, or a peer has been offline for a long time), bootstrap via the existing paginated `/v1/snapshot` endpoint, then tail with cursor-based `/v1/ops`.

There is no quorum requirement at the protocol level. Each peer's local copy is the authoritative version of the world it has seen so far. Convergence between peers is eventual, ordered by Lamport clock with LWW for conflicting writes to the same `entity_id`.

### Coordinator role, minimized

The coordinator is a phone book and a group registry. It does:

- **Group / scope membership management** — which device keys are authorized members of which scopes
- **Presence directory** — which device keys are currently reachable, at what addresses (TTL'd, peers refresh)
- **Bootstrap / invite flow** — how a new device gets enrolled in a group (existing bootstrap-grant pattern, possibly simplified)
- **(Optional, future)** NAT traversal hints (STUN-like: "I see your peer at this public address")
- **(Optional, future)** Relay fallback when direct peer connection fails

The coordinator does NOT:

- Store memories or replication ops
- Proxy data between peers
- Act as an auth boundary in front of a backend
- Make routing decisions about which peer holds which data
- Serve as a single point of failure for data access (peers continue to sync directly with each other if the coordinator is offline, as long as they already know each other's addresses)

The coordinator is treated as a necessary mechanism for crossing network boundaries (where mDNS doesn't reach), not a desirable architectural feature in its own right. In LAN-only deployments mDNS suffices and the coordinator can be skipped.

## Deployment shapes

### Solo

One peer. Local SQLite. No coordinator. No replication. mDNS off. This is codemem today; the new architecture changes nothing for this user.

### Two-laptop personal sync

Two peers. Coordinator (or manual address config) for discovery. mDNS for same-LAN. Each laptop is a member of every scope it cares about. They sync directly via HTTP+mTLS. Anti-entropy converges them when both are online. Effectively Syncthing for memories.

### Small team, single $5 VPS as always-on backstop

N laptops + 1 always-on VPS. The VPS is a regular peer that happens to never sleep. It is a member of the team's shared scopes. Laptops push to it when they have new ops; laptops pull from it when they want to catch up. The VPS is not a server — it is a peer. The coordinator can run on the same VPS or separately.

### Small team, no always-on peer

N laptops only. Sync happens whenever any two members are online simultaneously. Data is preserved as long as at least one member is online holding the latest ops; degrades gracefully if everyone goes offline. Less convenient than having a backstop but works.

### Org-scale (e.g., internal team deployment)

N laptops + a small k8s deployment of, say, 3 always-on codemem instances. The 3 instances are regular peers, members of the team scopes. They participate in the swarm identically to laptops; the only difference is uptime. Each holds full local SQLite (PVC or emptyDir, depending on whether you want them to bootstrap from peers on restart vs. preserve across restarts). Laptops push to whichever of the 3 they reach first; the others pick up the ops via anti-entropy. If one pod dies, the other 2 still have the data; a replacement bootstraps from peers on startup and rejoins.

There is no "internal HA quorum" mode. The 3 instances are 3 peers. The swarm-with-redundancy property comes from running multiple peers, not from a special multi-pod replication protocol.

### Cross-org federation (future)

Two organizations with their own deployed seeds, both holding membership in a shared scope. They replicate via the same protocol as any two laptops. Not a v1 concern; the door is open.

## Implementation work

### What already exists

- SQLite store via better-sqlite3 + Drizzle (`packages/core/src/store.ts`, `schema.ts`)
- Replication ops table with Lamport clock + tombstones + UUIDs (`schema.ts`)
- HTTP sync endpoints: `/v1/ops` (cursor-based) and `/v1/snapshot` (paginated bootstrap)
- Pull→apply→push sync pass (`packages/core/src/sync-pass.ts`)
- mTLS-secured peer transport
- Coordinator service with groups, enrolled devices, presence, bootstrap-grants
- Cloudflare Worker variant of the coordinator (D1-backed)
- mDNS discovery (`packages/core/src/sync-discovery.ts`)
- Device key identity model

### What needs to be added

In rough dependency order:

1. **Scope as first-class** (additive schema)
   - Add `scope_id` to `memory_items` and `replication_ops`
   - Plumb scope through write paths (coding-session observers tag memories with the scope they belong to)
   - Plumb scope through read paths (queries filter by scopes the local user is a member of)
   - Backfill existing memories with a default scope
   - Estimate: significant ergonomic surface but mechanically straightforward

2. **Membership semantics + auth at the wire**
   - Coordinator publishes the authorized device-key set per scope (or scope-membership is signed by a group-admin device)
   - Peers cache membership locally and verify on incoming sync requests (peer X requesting ops for scope Y must have a device key in Y's member set)
   - Estimate: ~300 LOC across coordinator + peer auth check

3. **Anti-entropy via Merkle ranges over the op-log**
   - Compute Merkle summaries per scope over `op_id`-ordered ranges (cached, invalidated on new ops)
   - New endpoint: `GET /v1/scope/{id}/merkle?range=...` returning hash triples
   - Periodic background job: pick a peer, exchange Merkle for shared scopes, fetch missing ops via existing `/v1/ops`
   - Estimate: ~400 LOC, the heaviest single piece

4. **Hinted handoff**
   - New table: `replication_hints` with target device key, scope, op references, expiry
   - Background drainer: when a hint's target becomes reachable, deliver and clear; also try to forward through any reachable mutual scope-member
   - Hint storage cap to prevent unbounded growth on long-offline targets
   - Estimate: ~200 LOC

5. **Coordinator pare-back**
   - Strip bootstrap-grant complexity if it doesn't earn its keep in the simpler model
   - Document the coordinator as "discovery + group membership + presence; never a data path"
   - Estimate: refactor + delete; net code reduction likely

Total budget: roughly 1000-1500 LOC of new TypeScript across `packages/core` and the coordinator, plus the scope-as-first-class ergonomic work which is harder to estimate.

### Patterns we explicitly do not implement

- Quorum write (Dynamo W+R>N) — wrong shape for intermittently-online peers
- Consistent hashing for placement — wrong shape, membership = placement
- SWIM gossip membership — wrong shape, no cluster
- Coordinator-as-gateway — gone, coordinator is not a data path
- libp2p — overkill, HTTP+mTLS is enough (Syncthing's BEP works the same way)
- Internal HA quorum mode for multi-pod seeds — gone, a multi-pod seed is just 3 peers
- New wire protocol — extensions to the existing HTTP API only

## Claims this position is making

For a reviewer to challenge:

1. **Syncthing's model fits codemem's domain.** We are not a database, not a streaming platform, not a pubsub system. We are a peer-replicated structured-data store with team-scoped sharing. Syncthing is the closest existing thing.

2. **Quorum is the wrong primitive for our writes.** Writers (laptops) are intermittently online. Requiring quorum acks before considering a write durable would block laptop writes during their normal operating mode. Local-immediate-durable + eventual-replication is the right semantics.

3. **The coordinator should be minimal.** It exists to bridge network boundaries and provide group identity. Anything more (proxying data, gating reads, routing decisions) is an architectural mistake driven by deployment-shape thinking.

4. **A "backbone" of always-on peers is a deployment artifact.** It does not require any special protocol mode. The codemem protocol treats a k8s pod identically to a laptop. The org-scale deployment property comes from running multiple peers, not from a different protocol.

5. **HTTP+mTLS is sufficient transport.** libp2p, custom protocols, and other peer-to-peer stacks introduce complexity without buying us anything Syncthing doesn't already get from TLS+TCP.

6. **The implementation budget is small (~1000-1500 LOC).** This depends on (4) and (5) being correct. If we needed quorum or libp2p the budget would be much larger.

7. **No new deployable infrastructure is needed.** No NATS, no Postgres, no DHT bootstrap nodes, no relay pools (yet). Everything runs in the existing codemem process plus the existing coordinator.

## Open questions worth challenging

These are places where the position above might be wrong, or where reasonable alternatives exist:

1. **Is membership signing done by the coordinator (centralized authority) or by group-admin device keys (federated authority)?** The latter is more decentralized and more Matrix-like; the former is simpler. Tradeoff: who can revoke a member, and how is revocation propagated?

2. **What happens to a scope whose only member's laptop is permanently lost?** Without an always-on peer, that scope's data dies with the last living member. Is this acceptable, or does the design need to push users toward at least one always-on peer for any "important" scope?

3. **Anti-entropy frequency and target selection.** Random pair selection is simple but inefficient at scale; biased toward "peers we haven't synced with recently" is better but more state to track.

4. **Op-log compaction.** Long-lived scopes accumulate ops indefinitely. Do we periodically compact the op-log into a snapshot baseline, dropping old ops? If so, how do peers that have been offline for years catch up?

5. **Conflict resolution beyond LWW.** LWW with Lamport ordering loses information when two peers concurrently edit the same memory. Is this acceptable for codemem's domain, or do we need richer CRDT semantics for some entity types?

6. **Membership change propagation latency.** A member is revoked from a scope; how quickly does that revocation reach all current member peers, and what happens during the propagation window?

7. **Should joiner UX include explicit "I just produced a write; is it shared yet?" feedback?** With eventual consistency this becomes "shared with these N members so far," which is honest but unfamiliar to users coming from synchronous-write systems.

8. **Deployment ergonomics for "I want my data backed up but don't want to run my own server."** Is the answer "run a $5 VPS yourself," "join a community-run backup pool," "store an encrypted snapshot in object storage as a fallback," or something else?

9. **Performance of Merkle anti-entropy at scale.** How many scopes can a single peer reasonably participate in before the periodic Merkle exchange becomes too costly?

10. **Multi-org federation auth.** When two orgs share a scope, who is the trust root for membership? This is out of v1 scope but worth thinking about now to avoid painting ourselves in.

## Things the prior research doc gets wrong

For an external reviewer reading both docs together: the companion research doc (`2026-04-30-seed-and-mesh-architecture-research.md`) anchors on "two-tier mesh with quorum writes" framed in the Dynamo/Cassandra lineage. That framing was rejected during deliberation. Specifically:

- The companion doc's "two-tier mesh: backbone vs joiner" section is wrong. There is no protocol-level distinction.
- The companion doc's "scope ring + quorum write + hinted handoff + Merkle anti-entropy + SWIM heartbeats" pattern set is over-specified. Of those, only Merkle anti-entropy and hinted handoff survive in the converged design.
- The companion doc's "coordinator-as-gateway" pattern is rejected. The coordinator is a phone book.
- The companion doc's "Dynamo as reference architecture" is wrong; the right references are Syncthing and BitTorrent.

The companion doc is preserved because the option survey (single-pod + Litestream, managed Postgres, JetStream log, mesh) is still useful for understanding what was considered and why each was rejected for the long-term default. But its prescriptive recommendations should be read through this doc.
