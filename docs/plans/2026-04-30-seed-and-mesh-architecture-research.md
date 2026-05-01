# Seed Peer & Mesh Architecture Research

**Date:** 2026-04-30
**Status:** historical / option survey only
**Superseded by:** `2026-04-30-seed-and-mesh-architecture-converged.md` (architecture) and `2026-04-30-sharing-domain-scope-design.md` (boundary semantics)

> **Read this for context, not direction.** The Dynamo/Cassandra-style two-tier mesh, coordinator-as-gateway, quorum writes, and "stateless app pod" framings here have been rejected. The codemem direction is Syncthing-shaped peer-to-peer with sharing domain (`scope_id`) as the hard boundary. Preserve this doc for the option survey it contains, but do not implement from it. Where it conflicts with the converged or scope-design docs, those win.

## Why this exists

We want a notion of a **seed (or central) peer** in codemem that fits the existing distributed model without forcing adoption of a centralized SQL database (Postgres-class). Target deployment is Kubernetes with a strong preference for stateless, horizontally scaled application pods. Self-hosted only — managed third-party stores like Cloudflare D1 are out of scope as a long-term default.

This document captures the architecture options surveyed, the decision frame, and the recommended direction.

## Existing model — what we have to build on

Established by inspecting `packages/core/src/store.ts`, `packages/core/src/schema.ts`, `packages/core/src/sync-pass.ts`, and `packages/cloudflare-coordinator-worker/`:

- **Storage backend:** better-sqlite3 (single-file, synchronous), schema in Drizzle. Auto-bootstraps on first construct. Multi-writer aware via `device_id` / `origin_device_id`.
- **Memory shape:** mutable records with `deleted_at` tombstones and `rev` counter. Identity via `entity_id` (would be the global key under replication).
- **Sync protocol:** pull→apply→push of an append-only `replication_ops` log via HTTP (`/v1/ops`, `/v1/snapshot`). Lamport scalar clock (`clock_rev` + `clock_device_id`). Idempotent on apply by `op_id` (UUID).
- **Snapshot bootstrap:** paginated `/v1/snapshot` for cold-start; falls back to this on cursor drift or generation mismatch.
- **Coordinator:** registry + presence + bootstrap-grant authorization only. **Not** a sync relay or data plane. D1-backed in the Cloudflare worker variant; Hono-on-SQLite when self-hosted.
- **Bootstrap grants:** the schema already models a `seed_device_id` → `worker_device_id` relation as a one-time authorization for snapshot pull. The "seed peer" concept exists in nascent form.

**Key insight:** the op log + scalar Lamport clock + tombstone LWW is essentially a half-CRDT. It is already idempotent, mergeable, and source-agnostic. That makes most of the candidate architectures *additive* rather than *transformative* — we'd be choosing where the durable log lives, not redesigning sync.

## Option survey

Four architectures were evaluated.

### Option A — Single-pod seed + Litestream → object storage

One `replicas: 1` Deployment with `strategy: Recreate`, SQLite on PVC, Litestream sidecar continuously streaming WAL to MinIO/S3.

| Pros | Cons |
|---|---|
| Smallest leap from current state | Single writer; no horizontal write scale |
| Restore on pod loss is automatic | Failover takes seconds; RPO ≈ Litestream interval |
| Closest match to existing `seed_device_id` design | Couples runtime to object store |
| Workers stay stateless | Doesn't unlock partial replication for joiner peers |

### Option B — Managed Postgres (RDS-class) backend

Replace the seed pod's SQLite with managed Postgres. Drizzle already supports the dialect.

| Pros | Cons |
|---|---|
| Boring, shippable in days | Tension with "no managed third-party store" preference |
| Genuinely stateless seed pods | Bad fit for OSS users who don't want to run Postgres |
| Multi-writer free, read replicas free | Forces dual-backend storage layer (SQLite default + Postgres opt-in) — maintenance tax forever |
| Org-aligned where Postgres is the paved road | Doesn't help joiner peers (they still need local store) |
| Backups/PITR/failover are platform's problem | New SPOF: seed pod is dead if it can't reach DB |
| Debuggable by anyone | Doesn't unlock any new product capability |

### Option C — Append-only durable log (NATS JetStream) + materialized SQLite views

Pods are stateless workers. Source of truth is a JetStream stream of replication ops. Each pod has an ephemeral SQLite materialized from the stream.

| Pros | Cons |
|---|---|
| Op log model maps directly onto JetStream | Adds NATS as an operational dependency |
| Stateless workers, durable backbone | Stream schema evolution requires care |
| Self-hostable, K8s-native via official Helm chart | Materialization startup latency |
| Naturally supports multi-region via JetStream mirroring | More moving parts than necessary today |

### Option D — Pure mesh (Cassandra/Dynamo-style with scope-based partial replication)

Stateless Deployment of backbone pods with `emptyDir` SQLite. Pods discover each other via the coordinator, replicate at quorum, and rebuild from peers on pod loss. Joiner peers (humans on laptops) subscribe to the subset of scopes they're entitled to.

| Pros | Cons |
|---|---|
| No external storage dependency | Real distributed-systems work — months not weeks |
| K8s pods are true cattle (`emptyDir` is fine) | Hard problems: quorum-write, hinted handoff, cold-boot herd, scope rebalancing |
| Survives any minority pod loss | Operational maturity has to be earned |
| Unlocks partial replication for joiner peers | Failure modes are richer (partial partitions, divergence) |
| Aligned with codemem's distributed character | Requires investment in anti-entropy tooling |
| Horizontal write scale via scope sharding | Higher debugging complexity |

## Comparison

| Axis | A: single-pod + Litestream | B: managed Postgres | C: JetStream log | D: pure mesh |
|---|---|---|---|---|
| Time to ship | days | days | weeks | months |
| Stateless seed pods | seed no, workers yes | yes | yes | yes |
| New ops dep | object store | RDS-class DB | NATS cluster | none |
| Self-hostable cleanly | yes | awkward | yes | yes |
| Aligns with stated preferences | yes | partial | yes | yes |
| Solves partial replication for joiners | no | no | partial | yes |
| Survives arbitrary pod loss | yes (restore) | yes (managed HA) | yes (Raft) | yes (replication) |
| Unlocks new capabilities | no | no | streaming consumers | partial replication, true horizontal scale |

## Architectural insights that emerged

These apply regardless of which backend wins; they are the load-bearing design ideas.

### Coordinator-as-gateway is the seam

The current coordinator is a registry only. Upgrading it to a **gateway** that proxies joiner traffic to the data plane lets the data plane evolve without breaking joiner clients:

- Single auth/entitlement boundary
- Topology hiding — joiners only know the coordinator URL
- Backbone stays cluster-internal (no external exposure)
- Backend swap is a server-side change, transparent to joiners
- The gateway is itself stateless and horizontally scalable

This is the abstraction that makes "ship the simple version now, swap to the ambitious version later" actually work.

### Scope as a first-class replication unit

Today every peer holds every memory. For mesh and for partial joiner replication, **scope** (likely `workspace_id`, possibly group/team) needs to be first-class:

- Every op carries its scope
- Pods advertise which scopes they host
- Joiners subscribe to the scopes they're entitled to
- New pod boots → coordinator assigns scopes → it pulls them from peers
- Pod loss → coordinator reassigns → other pods backfill

This is an additive schema/ergonomic change with high leverage. It is also a precondition for any of the more ambitious options actually being useful.

### Two-tier mesh: backbone vs joiners

Backbone pods (in-cluster, k8s deployment, `emptyDir`) do quorum writes and host scopes per a hash ring. Joiner peers (laptops, ephemeral agents) are read-mostly observers with cursors; their writes get forwarded into the backbone for durability. Joiners don't participate in quorum and don't need to be reachable from inside the cluster.

This separation kills most of the P2P complexity that would otherwise come from treating laptops as full replication participants.

### Building blocks worth stealing

- **libp2p** for transport (discovery, encrypted streams, NAT traversal for joiners, pubsub)
- **`memberlist` / SWIM** for backbone cluster membership
- **Cassandra vnodes** for incremental scope rebalancing
- **Matrix room model** for scope membership/entitlement (cryptographically self-describing groups, fits existing device key + group enrollment)
- **Automerge-Repo's `Repo` + `DocumentId` interface design** as a reference for scope-keyed pluggable network/storage adapters

### Hard problems we will own if we build the mesh

1. **Quorum-on-write.** `emptyDir` + RF≥2 means writes must ack from ≥W pods before client sees success. ~5–10ms LAN latency. Acceptable for codemem workload.
2. **Hinted handoff.** During pod loss, writes go to a non-hosting pod with a "deliver to X when it returns" hint. Without this, write availability tanks during rolling restarts.
3. **Cold-boot thundering herd.** Multiple pods booting empty must coordinate so they don't all try to pull from each other. Need a "boot from one survivor before accepting writes" rule and a readiness gate based on "caught up on assigned scopes".
4. **Scope rebalancing.** Scaling 3→5 pods redistributes scopes. Vnode trick (each pod owns many small ranges) keeps movement incremental.
5. **Anti-entropy granularity.** Merkle ranges per scope. Cheap when most scopes are quiet; scales with active scope count, not total data.

## Decision frame

### Recommended direction

**Long-term:** Option D (full mesh) is the architecture with the most product payoff and the strongest alignment with codemem's distributed character. It is the only option that:

- Removes external state dependencies entirely
- Treats k8s pods as true cattle
- Unlocks scope-based partial replication for joiner peers
- Provides a horizontal write-scale story

It is also the most engineering work. That cost is acknowledged and accepted as the right investment.

**Interim:** make the storage layer pluggable. Default to SQLite. Allow Postgres as an opt-in for environments that prefer managed durability. Keep the sync wire protocol stable across backends so the eventual mesh is a drop-in for the seed today.

**The unifying abstraction is the coordinator-as-gateway.** Whatever backend the seed runs (single-pod + Litestream today, mesh tomorrow), joiners only ever talk to the gateway. That is the layer we should design carefully now even if we don't ship the mesh until later.

### What's explicitly out of scope

- **Cloudflare D1** as a default (managed third-party).
- **Postgres as the only option** — pluggable yes, mandatory no.
- **Pure-mesh joiners** — joiners stay read-mostly observers, not full quorum participants. The complexity of NAT traversal + flaky-laptop quorum is not worth it.

## Decomposition for planning

If we commit to the mesh direction, three concerns should be independently shippable:

1. **Scope as a data-model concept.** Additive schema change adding a `scope_id` to ops and memories. No behavior change. Ships first; unblocks everything else.
2. **Coordinator-as-gateway.** Wraps the existing seed (single pod today). Establishes the joiner-facing API and the backend interface. Lets us validate the abstraction without the mesh existing.
3. **Backbone mesh.** RF, hash ring, quorum-write, hinted handoff, anti-entropy. Hard, bounded in surface area because joiners don't participate.

Doing them in this order means each layer is shippable and useful before the next exists.

## Next steps

- Convert this research into a phased plan (epic + child tasks) for the mesh work.
- Prototype the coordinator-as-gateway shape against the existing single-pod seed to validate the API surface before committing to mesh internals.
- Spike on libp2p as the backbone transport vs. plain HTTP+gossip on top of the existing sync API.
- Draft the `scope_id` schema migration and the entitlement model for joiners.
