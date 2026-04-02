# Seed-peer fleet orchestration pilot design

**Date:** 2026-04-02  
**Status:** Design  
**Bead:** `codemem-kp8m`

## Problem

codemem now has a working local E2E harness for coordinator enrollment, direct sync, and bootstrap. That proves the underlying sync model can work across multiple peers, but it does not yet provide a usable operational model for the next phase that matters most:

- running multiple parallel coordinated swarms of ephemeral workers
- attaching codemem to pre-provisioned workspace environments
- validating whether a durable seed peer can support realistic internal adoption before committing to a more centralized backend architecture

The current gap is not primarily about test coverage anymore. It is about orchestration and attachment:

1. **There is no fleet model for seed-peer-based swarms**
   - peers can sync, but there is no declared model for durable anchors, ephemeral workers, swarm groups, and readiness requirements
   - parallel swarm isolation depends on manual topology choices instead of an explicit design

2. **There is no runtime attachment contract for workspace environments**
   - codemem is a plugin or sidecar capability, not the system that provisions or runs AI agents
   - local Docker or Compose is useful as a proving backend, but the more important near-term target is attaching codemem to already-provisioned pod or workspace environments

3. **The backend evolution path is unclear without an operational pilot**
   - a stronger central backend such as Postgres may eventually help with concurrency, administration, or enterprise requirements
   - but introducing it now would be a premature architecture bet without evidence that the cheaper seed-peer model is insufficient

## Goals

- Define a pilot architecture for one durable seed peer serving multiple isolated swarm groups.
- Keep the initial path cheap to try and credible for internal adoption.
- Preserve codemem's peer-first model while allowing future backend evolution if scale demands it.
- Define a single fleet spec that can drive both local proving and pre-provisioned workspace attachment.
- Define stable and ephemeral identity policies, including coordinator-managed cleanup for ephemeral workers.
- Define readiness as join + bootstrap + verified sync, not just successful startup.
- Leave room for later browser coverage, broader orchestration, or stronger central backends without forcing them into the pilot.

## Non-goals

- No requirement to design a universal compute orchestrator.
- No requirement to provision infrastructure from scratch.
- No requirement to adopt Postgres or another central backend in the pilot.
- No requirement to add browser automation in this design.
- No embedding of private company terminology or internal environment names in the public design.

## Recommended approach

The recommended pilot architecture is:

- **one durable seed peer by default**
- **multiple isolated swarm groups**
- **one coordinator group per swarm**
- **local Compose as the proving backend**
- **a pre-provisioned workspace attachment adapter for real pilot usage**
- **stable seed identity, configurable worker identity policy, and coordinator-managed lifecycle cleanup**

This is deliberately a cheap proving step. It tests whether a durable seed peer backed by SQLite and durable storage can support realistic swarm-style usage before any larger backend migration is justified.

## Options considered

### Option 1: central backend first

Introduce a stronger central store and use it as the default shared-memory source for workers.

**Pros:**
- easier central administration and concurrency handling
- easier enterprise-oriented story for reporting, backup, and policy later

**Cons:**
- premature architecture bet
- weakens the immediate peer-first product story before the cheaper model has been proven inadequate
- increases pilot scope substantially

### Option 2: pure peer mesh with no durable seed peer

Treat all peers as equivalent and let workers bootstrap opportunistically from each other.

**Pros:**
- maximally peer-first
- minimal central role concentration

**Cons:**
- weak operational predictability for ephemeral swarms
- harder to reason about bootstrap reliability and readiness
- poor fit for a cheap, internally sellable pilot

### Option 3: durable seed peer plus isolated swarms (recommended)

Use one durable seed peer as the default memory anchor, let each swarm have its own coordinator group, and attach codemem onto either local Compose nodes or pre-provisioned workspace nodes.

**Pros:**
- cheap to pilot
- operationally understandable
- preserves peer-first roots
- leaves room for later backend evolution

**Cons:**
- the seed peer becomes a practical availability and throughput concentration point
- may eventually expose SQLite or single-node scaling limits

The recommended choice is **Option 3**.

## Roles and responsibilities

### Seed peer

The seed peer is the durable memory anchor for the pilot.

Responsibilities:
- holds the durable shared memory base
- serves as the bootstrap source for new workers
- remains stable across swarm runs
- uses stable identity and durable storage

Non-responsibilities:
- provisioning compute
- scheduling agents
- acting as the primary lifecycle manager for dead workers

### Coordinator

The coordinator is the control-plane service for group admission and peer lifecycle.

Responsibilities:
- invite, join, approval, and discovery
- one coordinator group per swarm
- stale and expired peer lifecycle tracking
- scheduled cleanup for ephemeral workers

Non-responsibilities:
- acting as the authoritative memory corpus
- replacing the seed peer as the bootstrap source in the pilot

### Ephemeral workers

Ephemeral workers are disposable swarm participants.

Responsibilities:
- join the correct coordinator group
- bootstrap from the seed peer
- complete at least one verified sync step
- age off cleanly after the swarm run or inactivity window

### Durable workers

Durable workers are optional long-lived peers such as user workspaces or long-running VMs.

Responsibilities:
- participate in the same join, bootstrap, and sync model
- preserve stable identity across sessions
- avoid accidental cleanup automation intended for ephemeral workers

### Runtime attachment adapters

codemem is not the compute orchestrator. The pilot therefore uses runtime attachment adapters rather than general infrastructure executors.

#### Compose proving backend
- creates and manages local peer containers
- wires config, keys, and data paths
- validates topology and lifecycle logic cheaply

#### Pre-provisioned workspace adapter
- assumes worker environments already exist
- installs and configures codemem in those environments
- joins them to swarms, bootstraps them, verifies readiness, and captures artifacts

This split keeps the pilot grounded in the real deployment story: local proving plus real runtime attachment.

## Fleet spec shape

The pilot needs one fleet spec that describes codemem topology and lifecycle independently of the attachment backend.

The spec should define:
- fleet metadata
- seed peer role
- coordinator policy
- swarm definitions
- worker role policy
- runtime attachment metadata
- readiness and success criteria

### Illustrative shape

```yaml
fleet:
  name: agent-memory-pilot
  mode: seed-peer-swarms

seed_peer:
  id: seed-main
  runtime: compose | workspace
  identity: stable
  storage:
    kind: sqlite
    persistence: durable

coordinator:
  mode: shared
  cleanup:
    stale_after_minutes: 30
    expire_after_minutes: 120

swarms:
  - id: swarm-a
    coordinator_group: swarm-a
    seed_peer: seed-main
    workers:
      count: 8
      runtime: compose | workspace
      identity: ephemeral

  - id: swarm-b
    coordinator_group: swarm-b
    seed_peer: seed-main
    workers:
      count: 8
      runtime: compose | workspace
      identity: ephemeral
```

The exact serialization format is not the important part in this design. The important part is the model.

### Runtime detail level

The spec should include **moderate runtime detail**:
- runtime type
- target identifiers or selectors
- config, key, and DB path expectations
- bootstrap hook names or commands
- storage durability hints
- readiness checks

It should not try to become a full platform deployment schema, Helm replacement, or infrastructure DSL.

## Runtime attachment model

### Compose proving backend

Purpose:
- prove the model locally
- reproduce topology and lifecycle behavior cheaply
- validate failure modes before touching shared environments

Responsibilities:
- create and manage local seed, coordinator, and worker peers
- attach config, keys, and storage
- run join, bootstrap, and sync verification steps
- collect local artifacts

The Compose backend is the lab bench, not the production runtime.

### Pre-provisioned workspace adapter

Purpose:
- attach codemem onto already-existing workspace environments
- support a cheap internal pilot in real pod-based development environments

Responsibilities:
- target selected workspaces
- install codemem or plugin components
- set up config, DB, and keys paths
- join the correct coordinator group
- bootstrap from the seed peer
- verify worker readiness
- optionally tear down or age off ephemeral workers cleanly

This is intentionally an attachment model, not a compute provisioner.

## Identity lifecycle policy

### Stable identities

Used for:
- seed peer
- durable user or workspace peers
- long-lived anchors

Behavior:
- persistent keys
- persistent DB and config paths
- never auto-cleaned by default
- manual retirement only

### Ephemeral identities

Used for:
- swarm workers
- disposable agent peers
- burst fan-out participants

Behavior:
- disposable by design
- safe to recreate
- eligible for staleness tracking, expiry, and cleanup

### Policy recommendation

The pilot should support a **configurable identity policy by role and runtime**:
- stable for the seed peer and durable peers
- ephemeral for swarm workers by default

## Coordinator cleanup policy

The coordinator should manage swarm membership hygiene.

### Recommended model

- **scheduled cleanup plus manual override**
- stale ephemeral peers become expired after a configurable TTL
- cleanup removes or archives ephemeral membership and discovery state
- stable peers are never auto-cleaned
- the seed peer is explicitly protected from cleanup automation

### Why this matters

Without lifecycle cleanup:
- repeated swarm runs pollute discovery state
- dead workers pile up
- operators lose trust in the topology

With lifecycle cleanup:
- swarms stay repeatable
- coordinator state stays legible
- the pilot looks operationally credible

## Readiness model

A worker is only considered **ready** when all three of the following are true:

1. **Join complete**
   - the worker has a valid identity
   - it has been admitted to the correct coordinator group
   - it appears in discovery state as expected

2. **Bootstrap complete**
   - it has loaded the expected baseline from the seed peer
   - local data is present and queryable

3. **Verified sync complete**
   - it has completed at least one sync step after bootstrap
   - a minimal data-plane assertion confirms the node is actually usable

Anything less is not real readiness.

### Suggested readiness states

- `pending`
- `joining`
- `joined`
- `bootstrapping`
- `bootstrapped`
- `sync_verifying`
- `ready`
- `stale`
- `expired`
- `failed`

## Shared seed peer versus cohort-specific seed peers

### Default mode

The pilot should use a **shared seed peer by default**.

Why:
- simpler to operate
- cheaper to validate
- stronger signal about whether a single durable seed peer is viable for internal use

### Advanced mode

The design should still allow **cohort-specific seed peers** as an explicit advanced option.

This matters for later scenarios such as:
- stricter swarm isolation
- workload-specific seed data
- higher fan-out loads
- future partial centralization or sharding strategies

The recommendation is therefore:
- shared seed peer by default
- cohort-specific seed peers as an advanced mode

## Validation model

For the pilot, validation should remain straightforward and black-box-oriented.

Each worker should prove:
- it joined the expected coordinator group
- it bootstrapped from the expected seed peer
- it completed at least one verified sync step
- expected shared data is present
- expected private data did not leak

This validation model should work in both:
- local Compose proving
- pre-provisioned workspace attachment

## Scale-trigger signals for backend evolution

The purpose of the pilot is not to preemptively adopt a stronger central backend. It is to gather evidence about whether the cheaper seed-peer model holds up well enough.

### Signals the seed-peer model is still sufficient

- bootstrap latency remains acceptable for 20–50 workers
- parallel swarm startup remains operationally manageable
- the seed peer does not become an obvious throughput bottleneck
- lifecycle cleanup stays understandable
- operators can reason about failures and recovery without heroic effort

### Signals that stronger backend work may be justified later

- the seed peer becomes a persistent throughput or availability bottleneck
- SQLite durability or administrative ergonomics become painful in practice
- large-scale reporting, audit, or policy requirements exceed the current peer-first model
- the internal pilot demands stronger centralized operational controls than the seed-peer model can comfortably support

At that point, re-evaluating a stronger backend or coordinator storage adapter becomes reasonable. Before that, it is premature.

## Recommended pilot phases

### Phase 1: local Compose proving

- finalize the fleet spec
- validate one seed peer plus multiple swarm groups locally
- exercise join, bootstrap, sync verification, and cleanup policy cheaply

### Phase 2: workspace attachment pilot

- define the workspace bootstrap contract
- attach codemem to pre-provisioned workspace environments
- validate readiness and cleanup behavior in a real pod-based runtime

### Phase 3: repeated swarm operation

- run multiple swarms repeatedly
- validate aging-off behavior and manual cleanup override
- measure bootstrap and sync bottlenecks under realistic pilot load

### Phase 4: backend pressure review

- assess whether the seed-peer model remains acceptable
- decide whether a stronger backend is justified by real adoption pressure rather than speculation

## Recommended next steps

1. Write the fleet spec and adapter contract in concrete terms.
2. Implement the local Compose proving path for one seed peer and multiple swarm groups.
3. Define the workspace bootstrap script contract for attaching codemem to pre-provisioned workspaces.
4. Add lifecycle cleanup commands or scheduled cleanup logic for ephemeral peers.
5. Measure bootstrap and sync readiness for 20–50 worker targets before making any backend escalation decision.

## Final recommendation

The pilot should proceed with a **shared durable seed peer, isolated coordinator groups per swarm, local Compose proving, and a pre-provisioned workspace attachment path**.

This is the cheapest credible path to proving codemem as a real foundation for internal swarm-style workflows while preserving a clear option to scale later if adoption and operational pain justify a stronger backend.
