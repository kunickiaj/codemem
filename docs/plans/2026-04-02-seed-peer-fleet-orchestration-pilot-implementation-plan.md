# Seed-peer fleet orchestration pilot implementation plan

**Date:** 2026-04-02  
**Status:** Draft plan  
**Design:** `docs/plans/2026-04-02-seed-peer-fleet-orchestration-pilot-design.md`  
**Epic:** `codemem-5gz6`

## Objective

Implement the seed-peer fleet orchestration pilot in thin, verifiable slices that prove the model cheaply before expanding into broader workspace attachment or backend evolution work.

The implementation should preserve three principles:

1. **Cheap to try**
   - reuse the existing sync and E2E foundations
   - avoid new infrastructure bets
   - avoid speculative backend work

2. **Credible to scale later**
   - use an explicit fleet spec
   - keep runtime attachment concerns separate from topology intent
   - preserve room for later workspace and backend adaptation

3. **Operationally honest**
   - readiness must mean join + bootstrap + verified sync
   - ephemeral peers must not accumulate forever
   - artifacts and status must make failures diagnosable

## Implementation slices

### Slice 1: fleet spec and local Compose proving path

Deliver:
- an executable fleet spec format for the pilot
- a checked-in Compose-backed example spec with one durable seed peer and two isolated swarm groups
- a fleet-smoke scenario that loads the spec, resolves topology, starts the required services, and proves basic codemem attachment on the declared nodes

Success criteria:
- one command runs a spec-backed fleet smoke scenario locally
- the runner produces artifacts describing the resolved topology
- the first slice stays narrow and does not yet attempt full swarm lifecycle automation

### Slice 2: shared-seed coordinator group materialization

Deliver:
- compose fleet flow for creating multiple coordinator groups from the spec
- group-scoped attachment for workers defined in the fleet spec
- evidence that swarm groups are isolated even when sharing the same durable seed peer

Success criteria:
- two swarm groups can be materialized from one spec without manual command choreography
- artifacts show which peer belongs to which group

### Slice 3: seed-peer bootstrap and readiness workflow

Deliver:
- fleet-driven join and bootstrap choreography for compose-backed workers
- readiness state transitions driven by join + bootstrap + verified sync
- spec-aware assertions that workers are actually ready, not merely started

Success criteria:
- a worker defined in the fleet spec can reach `ready`
- readiness failures produce useful artifacts and explicit state

### Slice 4: pre-provisioned workspace attachment contract

Deliver:
- a documented workspace bootstrap contract for attaching codemem to already-existing environments
- required inputs, outputs, hooks, and readiness checks
- a script/template boundary that can later be adapted to real workspace runtimes

Success criteria:
- the contract is explicit enough to implement against a real workspace environment without redesigning the fleet model

### Slice 5: lifecycle cleanup and operator workflows

Deliver:
- cleanup commands or lifecycle helpers for ephemeral peers
- stale and expired peer policy aligned with the fleet design
- operator-facing workflow notes for swarm teardown and cleanup

Success criteria:
- ephemeral peers do not accumulate indefinitely
- cleanup can be scheduled or manually triggered without risking stable peers or the seed peer

## First slice recommendation

The first slice should be intentionally narrow:

1. add a fleet spec type and validator
2. check in a Compose-backed sample spec
3. add a `fleetSmoke` scenario that loads the spec and brings up the declared services
4. verify codemem CLI reachability on the seed peer and worker peers
5. write a topology artifact showing swarm groups, roles, and resolved runtime targets

This proves that the pilot has a real attachment model without prematurely implementing every lifecycle step.

## File plan

### First slice

- `e2e/fleet/spec.ts`
- `e2e/fleet/examples/compose-shared-seed.json`
- `e2e/scenarios/fleet-smoke.ts`
- `e2e/bin/run-local.ts`
- `e2e/README.md`
- `package.json`

### Likely later slices

- `e2e/fleet/compose.ts`
- `e2e/fleet/workspace-contract.md` or equivalent public-safe contract doc
- `e2e/scripts/*` helpers for group materialization and readiness probes
- coordinator cleanup or lifecycle helpers if pilot work exposes missing surfaces

## Validation strategy

### First slice validation

- `pnpm exec tsx e2e/bin/run-local.ts list`
- `pnpm run e2e -- fleetSmoke`

### Broader regression after slice 1 if touched paths warrant it

- `pnpm run e2e:smoke`

## Risks and mitigations

### Risk: spec gets too abstract too early

**Mitigation:** keep the first spec executable and concrete, with explicit nodes for the Compose example.

### Risk: runtime attachment and topology intent get mixed together

**Mitigation:** keep moderate runtime detail in the spec and move backend-specific behavior into adapter helpers later.

### Risk: the first slice pretends readiness is solved

**Mitigation:** keep slice 1 explicitly scoped to topology materialization and CLI attachment, not full readiness.

### Risk: internal workspace terminology leaks into OSS surfaces

**Mitigation:** keep public-safe naming such as `workspace runtime` and `pre-provisioned workspace adapter`.

## Recommendation

Implement the pilot in thin vertical slices starting with a **fleet spec plus Compose-backed fleet smoke scenario**.

That gives codemem a concrete first implementation step toward swarm-style orchestration without locking the project into a premature backend or runtime-specific architecture.
