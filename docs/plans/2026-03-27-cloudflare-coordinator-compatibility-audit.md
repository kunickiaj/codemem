# Cloudflare Coordinator Compatibility Audit

**Bead:** `codemem-h21j`  
**Status:** Audit  
**Date:** 2026-03-27

## Question

Can the current built-in TypeScript coordinator be deployed directly to Cloudflare Workers, or does it still depend on
Node/Linux assumptions that require an adaptation layer or separate implementation?

## Short answer

**Not directly — but the project is no longer blocked on the original store/runtime split.**

The coordinator contract is a good fit for Cloudflare in principle, and the main architectural split is now materially in
place:

- shared Hono coordinator handlers
- async coordinator store contract
- BetterSQLite runtime/store adapter for Linux/Node
- D1 runtime/store adapter for Workers
- shared coordinator store conformance coverage across adapters

That means Cloudflare is no longer just a hand-wavy future target. It is now a real adapter path. The remaining work is
mostly about tightening the Worker runtime boundary, validating parity, and documenting the supported deployment model.

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

### 1. The built-in serve path is still Node-server specific

`codemem sync coordinator serve` in `packages/cli/src/commands/sync.ts` still depends on the Node runtime and process
model.

Even though the coordinator handlers now support multiple storage/runtime adapters, the built-in deployment path is
still:

- CLI entrypoint
- Node server adapter
- local DB path and local secret env
- long-running process on a host machine

That is still a deployment model mismatch with Workers.

### 2. Client/runtime helpers still assume Node/device-local environment

`packages/core/src/coordinator-runtime.ts` includes Node-specific assumptions such as:

- `networkInterfaces()` from `node:os`
- environment-variable access for key paths and config
- local device identity from SQLite + local key files
- `Buffer`-based request-signing helpers

Some of those are client/runtime concerns rather than server concerns, but they still matter if the Cloudflare target is
meant to feel like a first-class deployment target instead of a one-off worker wrapper.

### 3. General DB layer is still local-SQLite shaped outside the D1 coordinator path

`packages/core/src/db.ts` and adjacent store code are built around:

- local DB files
- filesystem migration/backup logic
- `better-sqlite3`
- process-local connection lifecycle

That reinforces the same conclusion: the broader core runtime was built for Node/Linux first, even though the narrower
coordinator surface now has a real D1 path.

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

### Blocker A — runtime/auth boundary tightening

The original Worker path still leaked Node assumptions through shared auth code (`Buffer`, `process.env`, Node crypto).
That boundary is now being tightened by the current D1/Cloudflare stack:

- runtime-specific request verification
- WebCrypto verifier on the Worker path
- BetterSQLite keeping the Node verifier
- worker-safe request parsing / invite encoding helpers

This is the current real unlock for dropping broad `nodejs_compat` dependence.

### Blocker B — admin secret + runtime config shape

The current admin/device config assumptions are simple for Linux/Node, but Cloudflare needs a clear mapping for:

- admin secret storage
- D1 binding names
- Worker environment configuration
- deployment-time schema creation/migration

These are solvable, but they need an explicit adapter plan.

### Blocker C — parity and operational confidence

Even with the shared contract and D1 adapter in place, Cloudflare remains riskier unless both paths are routinely held to
the same behavior and operator expectations.

That means:

- shared conformance coverage across store adapters
- worker integration coverage for auth/presence/peer lookup flows
- clear deployment docs for Linux-first validation vs Worker deployment

## Recommended deployment strategy

### Stage 1 — keep Linux/Node canonical

Continue treating:

- `codemem sync coordinator serve`
- local SQLite coordinator DB
- Linux/Node deployment

as the canonical runtime for product validation and E2E.

This is already the documented path and should remain so until the Worker runtime path is fully validated and documented.

### Stage 2 — finish the Worker runtime boundary cleanup

Continue tightening the Worker-specific path so it no longer depends on Node-only auth/runtime assumptions.

- injected runtime config
- Worker/WebCrypto request verification
- worker-safe request encoding/parsing helpers
- minimal compatibility flags in tests only

This is the current unlock.

### Stage 3 — validate/package for Workers

Once the runtime boundary is clean:

- reuse the Hono contract
- use the D1-backed store/runtime adapter
- keep the same admin/device auth semantics
- compare built-in and Worker behavior with shared tests where possible

### Stage 4 — only then treat Cloudflare as a supported TS deployment target

Until then, the honest wording remains:

- built-in TS coordinator on Linux/Node is canonical
- Cloudflare Worker is a reference/experimental path

## Current implementation status

What is now materially in place:

- async coordinator store contract
- shared coordinator store conformance harness
- D1 coordinator store/runtime adapter
- worker entrypoint using the shared coordinator app
- active runtime cleanup to remove broad `nodejs_compat` dependence

What still needs to be true before Cloudflare should be described as fully supported:

- runtime/auth cleanup merged and stable
- docs updated to match the new adapter model
- enough parity/integration confidence that Worker behavior won't drift silently

## Bottom line

The current TS coordinator is **protocol-compatible** with Cloudflare and now has a real adapter path, but it is **not
yet a drop-in replacement** for the canonical Linux/Node coordinator deployment.

That means:

- the existing Hono contract is a good foundation
- the built-in Node/Linux coordinator remains the source-of-truth deployment path today
- Cloudflare support should be pursued as a first-class adapter/runtime target with explicit parity coverage, not by
  pretending `codemem sync coordinator serve` itself is already Worker-ready
