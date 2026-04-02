# Pre-provisioned workspace runtime attachment contract

**Status:** Draft contract  
**Related design:** `docs/plans/2026-04-02-seed-peer-fleet-orchestration-pilot-design.md`  
**Related epic:** `codemem-5gz6`

## Purpose

This contract defines how codemem attaches to an already-existing workspace runtime for the seed-peer fleet pilot.

It does **not** define how compute is provisioned or how AI agents are scheduled. It only defines the contract for installing, configuring, joining, bootstrapping, validating, and cleaning up codemem in a pre-provisioned workspace environment.

## Scope

The contract applies to workspace-style runtimes where:

- the environment already exists before codemem attachment begins
- codemem behaves as a sidecar, plugin, or bootstrap layer
- the runtime already has its own lifecycle for compute, agent execution, and teardown

This is intentionally public-safe and generic. It should not depend on private product or company terminology.

## Required inputs

Each workspace attachment operation must receive the following inputs.

### Fleet and node identity

- `fleet_name`
- `swarm_id`
- `coordinator_group`
- `node_id`
- `node_role`
  - `seed-peer`
  - `worker-peer`
  - optionally later: durable workspace role variants

### Runtime target information

- `workspace_selector` or equivalent target identifier
- `config_path`
- `db_path`
- `keys_path`
- `bootstrap_hook` or startup script entrypoint

### Sync attachment configuration

- `coordinator_url`
- `coordinator_admin_secret` when required
- `seed_peer_device_id` when the node bootstraps from a seed peer
- `seed_peer_address` or reachable sync endpoint
- identity policy
  - `stable`
  - `ephemeral`

### Policy inputs

- cleanup class
  - `stable`
  - `ephemeral`
- stale and expiry thresholds when the node is ephemeral

## Required environment guarantees

The workspace runtime must provide:

- a writable config location
- a writable DB location
- a writable keys location
- a reachable network path to the coordinator
- a reachable network path to the seed peer when bootstrap is required
- the ability to run codemem CLI commands and helper scripts during bootstrap

For stable peers, the runtime must also provide durable persistence for:

- keys
- DB
- config

For ephemeral peers, persistence may be disposable as long as it survives long enough for the swarm run.

## Attachment phases

### 1. Install

The runtime adapter ensures codemem is available in the workspace.

Expected outcome:
- `codemem` CLI or source-run equivalent is runnable

### 2. Configure

The runtime adapter writes or updates codemem configuration for the node.

Expected configuration includes:
- database path
- keys path
- coordinator URL and group
- sync host and port
- identity policy hints

### 3. Identity initialization

The adapter ensures the node has the correct identity behavior:

- stable peers reuse durable keys
- ephemeral peers create disposable keys

Expected outcome:
- a valid device identity exists before join/bootstrap begins

### 4. Coordinator join

The adapter joins the node to the expected coordinator group.

Expected outcome:
- node is admitted to the intended group
- node appears in coordinator discovery state

### 5. Bootstrap

If the node is not the seed peer, the adapter bootstraps it from the seed peer.

Expected outcome:
- the baseline shared memory corpus is present locally
- the node is no longer in pre-bootstrap state

### 6. Sync verification

The adapter performs at least one sync verification step after bootstrap.

Expected outcome:
- peer communication succeeds
- the node passes a minimal data-plane assertion

### 7. Readiness publication

The adapter records the node's readiness state.

Minimum state model:
- `pending`
- `joining`
- `joined`
- `bootstrapping`
- `bootstrapped`
- `sync_verifying`
- `ready`
- `failed`

## Readiness contract

A workspace node is only considered **ready** when all of the following are true:

1. coordinator join is complete
2. bootstrap is complete when required
3. one verified sync step has completed successfully

Anything less should be reported as a non-ready intermediate state.

## Required outputs

Each attachment run must emit:

- final node state
- device identity summary
- coordinator group
- bootstrap source used
- readiness result
- artifact directory or log location
- failure detail when unsuccessful

## Artifact expectations

The adapter should capture enough information to debug failures without rerunning blind.

Recommended minimum artifacts:
- CLI command transcripts
- config snapshot used for the run
- identity summary
- bootstrap result summary
- sync verification result summary
- failure detail if attachment fails

Sensitive material such as private keys must never be copied into shared artifacts.

## Cleanup contract

### Stable nodes

- never auto-cleaned by the attachment process
- retirement must be explicit

### Ephemeral nodes

- should be eligible for scheduled coordinator cleanup
- may support explicit teardown hooks in the runtime adapter
- should not leave permanent identity clutter in the coordinator when the swarm is over

## Failure modes the adapter must surface clearly

- codemem install not available
- configuration path not writable
- keys path not writable
- coordinator join failure
- bootstrap unreachable or refused
- sync verification failure
- cleanup failure for ephemeral nodes

## Non-goals

- no requirement to provision the workspace itself
- no requirement to define workspace scheduling semantics
- no requirement to define a generic Kubernetes abstraction layer in this contract

## Recommendation

Use this contract as the boundary between the fleet spec and any real workspace runtime integration.

That keeps the pilot architecture public-safe, runtime-agnostic, and cheap to validate while still being concrete enough to implement against a real pre-provisioned workspace environment.
