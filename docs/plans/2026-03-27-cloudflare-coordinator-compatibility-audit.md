# Cloudflare Coordinator Compatibility Audit

**Bead:** `codemem-h21j`  
**Status:** Audit  
**Date:** 2026-03-27

## Question

Can the current built-in TypeScript coordinator be deployed directly to Cloudflare Workers, or does it still depend on
Node/Linux assumptions that require an adaptation layer or separate implementation?

## Short answer

**Not directly.**

The current coordinator contract is a good fit for Cloudflare in principle, but the built-in runtime is still tightly
bound to:

- Node process APIs
- local SQLite via `better-sqlite3`
- filesystem-backed configuration and key material
- a long-running server model

That means the current built-in coordinator is still best treated as the canonical **Linux/Node runtime**, while
Cloudflare remains an **adaptation target** built from the same HTTP contract rather than a drop-in deployment of the
existing `codemem sync coordinator serve` implementation.

## What already ports cleanly

### 1. The HTTP contract

The coordinator API itself is already close to Cloudflare-friendly:

- Hono-based request handlers in `packages/core/src/coordinator-api.ts`
- small JSON request/response bodies
- explicit admin/device auth boundaries
- no relay or streaming transport
- no server-side memory store

This is good news. The contract is not the blocker.

### 2. The protocol boundaries

The current discovery-only shape also ports well conceptually:

- `POST /v1/presence`
- `GET /v1/peers`
- admin invite / enrollment endpoints
- signed request verification
- nonce replay protection

Cloudflare Workers can handle this class of stateless HTTP traffic just fine.

### 3. The product cut

The current coordinator deliberately avoids the parts that would be much harder to move to Workers right now:

- no relay/proxy transport
- no offline queue
- no central memory storage
- no search workload

That means the remaining problems are runtime/storage adaptation problems, not protocol-shape problems.

## What does not port directly

### 1. CoordinatorStore is Node + `better-sqlite3`

`packages/core/src/coordinator-store.ts` is the biggest direct blocker.

It currently depends on:

- `better-sqlite3`
- `node:fs`
- `node:os`
- `node:path`
- a file path (`DEFAULT_COORDINATOR_DB_PATH`)
- WAL-mode local SQLite connection setup

Cloudflare Workers do not run `better-sqlite3` and do not expose a local filesystem. So the existing store cannot be
reused in Workers as-is.

### 2. The built-in serve path is Node-server specific

`codemem sync coordinator serve` in `packages/cli/src/commands/sync.ts` depends on the Node runtime and process model.

Even though the coordinator handlers use Hono, the built-in deployment path is still:

- CLI entrypoint
- Node server adapter
- local DB path and local secret env
- long-running process on a host machine

That is a deployment model mismatch with Workers.

### 3. Coordinator runtime helpers still assume Node/device-local environment

`packages/core/src/coordinator-runtime.ts` includes Node-specific assumptions such as:

- `networkInterfaces()` from `node:os`
- environment-variable access for key paths and config
- local device identity from SQLite + local key files
- `Buffer`-based request-signing helpers

Some of those are client/runtime concerns rather than server concerns, but they matter if the Cloudflare target is meant
to reuse more of the built-in coordinator stack wholesale.

### 4. General DB layer is still local-SQLite shaped

`packages/core/src/db.ts` and adjacent store code are built around:

- local DB files
- filesystem migration/backup logic
- `better-sqlite3`
- process-local connection lifecycle

That reinforces the same conclusion: the current core runtime was built for Node/Linux first.

## What the existing Worker reference proves

The Worker reference in `examples/cloudflare-coordinator/` proves three important things:

1. the coordinator contract can be implemented on Workers
2. device-key request verification can be done with Web Crypto / Worker APIs
3. D1 is a plausible persistence layer for the narrow coordinator metadata model

That reference is useful, but it is still a **parallel implementation**, not a deployment of the built-in coordinator.

It also still has obvious drift:

- Python bootstrap/smoke helpers in a TS-first repo
- operator-managed SQL enrollment
- no assumption of full parity with the built-in coordinator runtime

So the Worker reference proves viability of the contract, not readiness of a direct TS runtime lift-and-shift.

## Main compatibility blockers

### Blocker A — storage abstraction

The built-in coordinator code mixes HTTP handling with a concrete local SQLite store.

To make the TS coordinator genuinely portable, the next real technical step is not “just deploy it to Workers.” It is:

- separate the coordinator service logic from the local SQLite implementation
- introduce a narrow store interface the coordinator app can depend on
- provide:
  - Node/Linux implementation backed by `CoordinatorStore`
  - Worker/D1 implementation backed by D1 queries

Without that split, Cloudflare remains a separate implementation path.

### Blocker B — admin secret + runtime config shape

The current admin/device config assumptions are simple for Linux/Node, but Cloudflare needs a clear mapping for:

- admin secret storage
- D1 binding names
- Worker environment configuration
- deployment-time schema creation/migration

These are solvable, but they need an explicit adapter plan.

### Blocker C — no parity guarantee between built-in and Worker codepaths

Right now, features land in the built-in coordinator first and the Worker path can lag behind.

That is acceptable for a reference implementation, but not for “Cloudflare deployment of the TS coordinator” as a first-
class target.

## Recommended deployment strategy

### Stage 1 — keep Linux/Node canonical

Continue treating:

- `codemem sync coordinator serve`
- local SQLite coordinator DB
- Linux/Node deployment

as the canonical runtime for product validation and E2E.

This is already the documented path and should remain so until the storage/runtime split exists.

### Stage 2 — formalize a coordinator store boundary

Before trying to claim Cloudflare support for the TS coordinator, extract a service boundary like:

- coordinator app / handlers
- coordinator store interface
- Node store adapter
- Worker/D1 store adapter

This is the real unlock.

### Stage 3 — adapt/package for Workers

Once the store boundary exists:

- reuse the Hono contract
- provide Worker bindings + D1-backed store
- keep the same admin/device auth semantics
- compare built-in and Worker behavior with shared tests where possible

### Stage 4 — only then treat Cloudflare as a supported TS deployment target

Until then, the honest wording remains:

- built-in TS coordinator on Linux/Node is canonical
- Cloudflare Worker is a reference/experimental path

## Recommended first implementation slice after this audit

If the goal is serious Cloudflare deployment of the TS coordinator, the next engineering slice should be:

### `PR 470+1` — coordinator storage/runtime split design

Document or implement the smallest interface needed for:

- groups
- enrolled devices
- presence
- invites
- join requests
- nonce replay records

That gives the project one real coordinator implementation model with two storage/runtime adapters instead of two drifting
codepaths.

## Bottom line

The current TS coordinator is **protocol-compatible** with Cloudflare but **runtime-incompatible** as a direct deployment.

That means:

- the existing Hono contract is a good foundation
- the built-in Node/Linux coordinator remains the source of truth
- Cloudflare support should be pursued via a store/runtime adapter split, not by pretending `codemem sync coordinator
  serve` is already Worker-ready
