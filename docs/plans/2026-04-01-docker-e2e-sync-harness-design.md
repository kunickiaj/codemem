# Local Docker/Compose E2E Sync Harness Design

**Bead:** `codemem-0yoq`  
**Status:** Design  
**Date:** 2026-04-01

## Problem

codemem already has substantial unit and integration coverage around sync, coordinator behavior, and bootstrap logic, plus a manual Linux/Node coordinator runbook. What it does not have is a reproducible, automated, multi-node end-to-end validation path that proves the product works across the real control plane and data plane together.

That gap creates three problems:

1. **Critical workflows are still validated manually**
   - coordinator invite and join flows depend on operator runbooks
   - peer acceptance and direct sync depend on manual setup and eyeballing results
   - bootstrap behavior can regress even if narrower tests stay green

2. **Multi-node environments are expensive to recreate**
   - there is no standard local topology for multiple peers and a coordinator
   - future swarm or fleet-style automation would have to reinvent the setup path
   - debugging cross-node behavior is slower than it should be

3. **Seed data strategy is not yet safe for long-term automation**
   - real local data may be useful for fast initial validation
   - but CI and shared automation cannot depend on personal databases or sensitive local state
   - synthetic fixtures need to become a first-class part of the design

## Goals

- Define a first-version local Docker/Compose-based E2E harness for sync workflows.
- Validate coordinator enrollment, coordinator-backed discovery, direct peer sync, and snapshot/bootstrap flows.
- Prefer black-box validation through supported CLI and HTTP surfaces.
- Create a reusable topology foundation for future multi-peer, swarm, or fleet automation.
- Define a seed-data strategy that supports local-only real-data import now and deterministic synthetic datasets later.
- Leave a clear future path to CI and browser-level automation without requiring either for v1.

## Non-goals

- No requirement to run this in GitHub Actions in the first version.
- No browser automation requirement in the first version.
- No new coordinator deployment target or infrastructure abstraction beyond local Docker/Compose.
- No attempt to replace existing unit/integration coverage with E2E tests.
- No committed real user data, personal databases, or personal memory exports.

## Recommended approach

The recommended v1 architecture is:

- **Docker Compose defines the topology**
- **a host-run orchestration harness drives scenarios**
- **scenarios use public CLI and HTTP interfaces**
- **seed data is an explicit subsystem with multiple modes**

This combines the reproducibility of containerized services with the low-friction ergonomics of a local runner. It also avoids prematurely building a more abstract container orchestration framework before a few real scenarios have proven what abstractions are actually needed.

## Options considered

### Option 1: Compose + black-box runner (recommended)

Compose manages coordinator and peer nodes. A host-run script or Node-based runner drives setup, commands, waits, and assertions.

**Pros:**
- close to real deployment behavior
- easy to scale to more peers later
- low conceptual overhead
- future CI path remains straightforward

**Cons:**
- still requires careful readiness and artifact handling
- container orchestration bugs can become flaky if waits are sloppy

### Option 2: Compose services only + ad hoc shell scripts

Compose brings services up, but test flows are mostly hand-assembled from shell scripts without a proper orchestration layer.

**Pros:**
- fast to start
- low initial code overhead

**Cons:**
- brittle over time
- poor reuse across scenarios
- weak artifact handling and difficult failure diagnosis

### Option 3: Programmatic container orchestration in Vitest/Testcontainers

A TypeScript test suite uses container APIs directly and manages the full topology in code.

**Pros:**
- strong in-code control
- eventual fit with automated CI suites

**Cons:**
- more up-front engineering
- higher abstraction cost before scenario needs are proven
- unnecessary complexity for the first cut

The recommended choice is **Option 1**.

## Topology

### v1 topology

The first version should support this local topology:

- `coordinator`
- `peer-a`
- `peer-b`
- optional `peer-c` for bootstrap and fan-out scenarios
- a host-run `e2e` orchestrator

Each peer should have isolated storage and identity material:

- SQLite database path
- config directory
- keys directory
- stable container hostname
- artifact output directory

### Why this topology is preferred

- It mirrors the real runtime model closely enough to catch integration regressions.
- It gives a stable base for coordinator and direct peer flows.
- It can scale naturally from two peers to multi-peer test matrices.
- It avoids coupling the harness to a browser or internal modules too early.

## Harness architecture

### Core principle

The harness should be an **orchestrator**, not a vague test framework.

Each scenario should follow the same shape:

1. arrange topology and seed mode
2. execute supported CLI or HTTP actions
3. wait for observable state transitions
4. assert visible outcomes
5. collect logs and state on failure

### Proposed file layout

```text
docker-compose.e2e.yml
e2e/
  bin/
    run-local.ts
  lib/
    artifacts.ts
    assert.ts
    compose.ts
    exec.ts
    scenario-context.ts
    wait.ts
  scenarios/
    smoke.ts
    coordinator-invite.ts
    coordinator-approval.ts
    direct-sync.ts
    bootstrap-empty-peer.ts
    bootstrap-dirty-refusal.ts
  seeds/
    generate-fixture.ts
    load-seed.ts
    profiles/
      small.ts
      large.ts
    README.md
  artifacts/
    .gitkeep
e2e/images/
  peer.Dockerfile
```

### Responsibilities

The runner should support:

- bringing the stack up and down
- resetting state between scenarios
- running commands inside named containers
- waiting for service readiness and sync convergence
- collecting logs, status snapshots, and copied DBs on failure
- filtering by scenario name or suite
- selecting seed mode per scenario

### Public entrypoints to prefer

The E2E harness should prefer these validation paths:

- `codemem` CLI commands
- coordinator HTTP behavior where relevant
- viewer or sync HTTP status endpoints where useful
- final SQLite data state for truth checks

It should avoid depending on internal implementation details unless deterministic setup or verification requires them.

## Seed data strategy

Seed data should be a first-class subsystem, because both direct sync and bootstrap coverage depend on it.

### Supported seed modes

The harness should support four seed modes:

- `empty`
- `fixture-small`
- `fixture-large`
- `local-import`

### `empty`

Used for coordinator enrollment and basic smoke scenarios where data content is not the focus.

### `fixture-small`

Used for direct sync scenarios.

This dataset should include:

- multiple actors
- a mix of `private` and `shared` memories
- multiple projects or workspaces
- multiple memory kinds
- timestamps spread across time
- a few sentinel records with known identifiers for strong assertions

### `fixture-large`

Used for bootstrap scenarios.

This dataset should be large enough to exercise:

- snapshot pagination
- initial bootstrap flow
- convergence timing expectations
- data integrity under higher volume

The first useful target is not exact performance benchmarking, but a meaningful scale that can reveal pagination and replication regressions.

### `local-import`

This is a local-only developer convenience path.

It may use a real local database or sanitized export for fast validation, but it must be treated as unsafe for shared automation.

Guardrails:

- local-only opt-in
- ignored paths only
- never committed
- never required for a passing suite
- never uploaded into shared artifacts by default

### Long-term synthetic data direction

Synthetic data should optimize for **both realism and scale**, but start with scale-heavy usefulness and layer realism in over time.

The generator should mimic usage shape rather than personal content:

- realistic visibility mixes
- uneven timestamps
- multiple actors and peer relationships
- multiple projects with overlapping terminology
- large enough shared datasets to stress bootstrap

The generator should be deterministic from a seed value so failures are reproducible.

## Scenario matrix

### Tier 1: coordinator enrollment and discovery

These scenarios automate the existing manual coordinator runbook shape.

#### Scenario: invite happy path

- start clean coordinator state
- create coordinator group
- create invite from admin peer
- import invite on teammate peer
- approve join request when required
- assert enrollment succeeded
- assert both peers appear in coordinator discovery surfaces

#### Scenario: auto-admit invite

- create auto-admit invite
- import on teammate peer
- assert no manual approval is required
- assert discovery converges

#### Scenario: approval-required invite

- import invite
- assert pending state before approval
- approve request
- assert enrolled and discovered state afterward

### Tier 2: accepted peer and direct sync

#### Scenario: discovered peer becomes active sync peer

- enroll peers through coordinator flow
- accept discovered peer from the initiating node
- verify `sync_peers` state exists
- trigger direct sync
- assert expected shared data replicates to the receiving peer

#### Scenario: scope review flow

- accept discovered peer
- confirm scope review behavior is present
- save or reset scope
- trigger sync
- assert only expected shared data replicates

### Tier 3: snapshot/bootstrap

#### Scenario: empty peer initial bootstrap

- seed `peer-a` with a large shared dataset
- bring up a clean target peer
- enroll and pair the target
- trigger the first sync/bootstrap path
- assert bootstrap path was taken
- assert target data matches expectations

#### Scenario: bootstrap refusal with dirty local shared state

- seed target with unsynced local shared changes
- attempt bootstrap
- assert refusal unless an explicit force path is used

### Tier 4: resilience and regression traps

These are not mandatory for the first implementation, but the design should leave room for them.

Examples:

- stale or unreachable coordinator URL
- bad invite URL causing join timeout
- discovered peer not yet accepted
- stale conflicting peer state
- generation mismatch triggering re-bootstrap

## Assertions and observability

Each scenario should assert across three layers.

### 1. Control plane

- invite creation
- join request presence
- approval outcome
- coordinator enrollment and discovery state

### 2. Sync plane

- accepted peer state
- scope review behavior
- sync or bootstrap command success
- recent attempt and peer status surfaces where useful

### 3. Data plane

- replicated records exist on the receiving node
- counts or sentinel identifiers match expected values
- filtered or private data does not leak where it should not

The final truth for E2E should be the **data plane**, not a friendly command message.

### Artifact collection

On failure, the harness should capture:

- `docker compose logs`
- per-container command transcripts
- copied DB files or snapshots
- sync status JSON
- scenario step summary for the failure point

This is important because multi-node failures become a debugging clown show if the harness only reports “timeout” and nothing else.

## Phased rollout

### Phase 1: environment and smoke path

Deliver:

- compose topology
- peer image or runtime contract
- reset flow
- artifact collection
- one smoke scenario

### Phase 2: coordinator automation

Deliver:

- invite flow automation
- approval flow automation
- coordinator discovery assertions

### Phase 3: direct sync automation

Deliver:

- `fixture-small` seed mode
- accepted-peer flow
- direct sync scenario
- replicated-data assertions

### Phase 4: bootstrap automation

Deliver:

- `fixture-large` seed mode
- bootstrap scenario
- dirty-local refusal scenario
- data integrity assertions at higher volume

### Phase 5: future-CI hardening

Deliver:

- stable machine-readable output
- deterministic ports and names
- cleaner artifact bundles
- reduced reliance on local-only assumptions

This phase prepares the design for CI later, but should not block v1 local usefulness.

## Recommended first PR sequence

To reduce risk and avoid over-building abstractions before they are earned:

1. **PR 1**
   - compose topology
   - runner skeleton
   - artifact handling
   - smoke scenario

2. **PR 2**
   - `fixture-small` generator
   - coordinator invite and join scenarios

3. **PR 3**
   - direct sync scenario
   - data-plane assertions

4. **PR 4**
   - `fixture-large` generator
   - bootstrap scenario and refusal checks

This sequence keeps the implementation honest and prevents a giant “framework” PR that has not yet proven it can validate one useful real-world flow.

## Risks and mitigations

### Risk: flaky time-based waits

**Mitigation:** prefer state-based readiness and convergence checks over blind sleeps.

### Risk: assertions stop at command success

**Mitigation:** require data-plane verification for sync and bootstrap scenarios.

### Risk: local real-data import leaks into shared automation

**Mitigation:** keep `local-import` opt-in, ignored, and never required.

### Risk: too much abstraction too early

**Mitigation:** build only the runner and helpers required by the first few scenarios.

### Risk: poor failure diagnosis in multi-node scenarios

**Mitigation:** collect logs, copied DBs, and status snapshots automatically.

## Acceptance criteria

This design is successful when:

1. The first implementation can be run locally with one command against a Docker/Compose topology.
2. The first useful automated path validates coordinator enrollment and coordinator-backed discovery.
3. The plan includes a direct sync scenario with real replicated-data assertions.
4. The plan includes a bootstrap scenario for an empty peer seeded from a larger dataset.
5. Seed data is treated as a supported subsystem with `empty`, `fixture-small`, `fixture-large`, and `local-import` modes.
6. The design leaves a clean path to future CI and browser-layer automation without requiring either in v1.

## Final recommendation

Build the first version as a **local Docker/Compose topology plus a host-run orchestration harness**, with seed-data modes designed in from day one.

That gives codemem a practical automated validation path for coordinator, peer sync, and bootstrap behavior now, while also establishing the reusable topology and fixture foundations needed for future multi-node automation.
