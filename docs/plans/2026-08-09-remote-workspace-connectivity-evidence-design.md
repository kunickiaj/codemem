# Remote Workspace Connectivity Evidence Decision

**Date:** 2026-08-09
**Status:** Approved targeted experiment; relay implementation remains unauthorized
**Bead:** `codemem-zjvr.1.8`
**Related:** `2026-08-08-relay-assisted-sync-design.md`, `2026-03-12-coordinator-backed-cross-network-discovery.md`, `2026-03-12-relay-and-buffered-delivery-follow-on.md`

## Decision

Use a bounded connectivity and address-churn experiment instead of adding 21 days of persistent direct-reachability telemetry.

A live Kubernetes-hosted remote workspace was reachable from one private-network peer through its current pod IPv4 address. An unsigned `/v1/status` request returned the expected HTTP 401, proving TCP and Codemem application reachability without proving signed peer authentication. The earlier connection refusal occurred while the Codemem daemon was stopped, not because the tested network path was blocked.

The remaining demonstrated weakness is endpoint durability. The reachable pod address is ephemeral, the automatically advertised IPv6 candidate is link-local, and no stable Kubernetes Service or Ingress endpoint for the Codemem sync listener was verified. Outbound HTTPS and WebSocket upgrade capability were verified from the remote workspace.

These observations justify a targeted experiment, not a claim that all Kubernetes-hosted peers require relay. Stable direct signed HTTP remains preferred when an operator can provide a durable routable endpoint. An outbound live relay remains the strongest general fallback when peers cannot expose or route such an endpoint.

This decision authorizes the experiment only. It does not authorize relay transport, public exposure, persistent telemetry, coordinator payload forwarding, or durable store-and-forward. Any private infrastructure mutation in the optional stable-endpoint case requires separate operator approval and remains outside this public work.

## Why the telemetry proposal was rejected

The proposed persistent measurement contract assumed observability that current sync does not have:

- address-source provenance is merged before dialing;
- retry backoff is peer-level rather than candidate-path-level;
- peers with expired coordinator presence are skipped before path evaluation; and
- a persisted online-overlap timeline would create unnecessary work-hours metadata.

Implementing those assumptions inside a measurement bead would either mislabel evidence or change sync behavior while measuring it. A changing baseline cannot provide a clean relay-need estimate. The concrete remote-workspace question can instead be answered with a small reproducible matrix that stores no new runtime telemetry.

## Existing evidence

The following facts are sufficient to narrow the experiment:

| Question | Current evidence | Interpretation |
| --- | --- | --- |
| Does the current private route reach the pod listener? | Yes; TCP connected and unsigned `/v1/status` returned 401 while the daemon was running. | Routing and application reachability work from the tested peer. |
| Was the earlier refusal a NAT/firewall result? | No; the listener was stopped. | Do not count that refusal as relay evidence. |
| Is signed bidirectional sync proven? | No; the workspace had no paired peer during the probe. | Pairing and signed exchange remain required. |
| Is the advertised endpoint durable? | No verified durable endpoint; the usable pod address is ephemeral. | Recreate/reschedule can invalidate discovery state. |
| Is the IPv6 candidate generally usable? | No; it is link-local. | It must not be treated as a cross-host route without interface scope. |
| Can the remote workspace establish outbound control/data connections? | Outbound HTTPS and WebSocket upgrade succeeded. | An outbound live-relay client is technically plausible. |
| Is a stable Service/Ingress path available? | None was verified for the Codemem sync port. | Direct durability depends on private deployment configuration and policy. |

Environment-specific names, hostnames, addresses, organization identifiers, credentials, and platform details are intentionally excluded from this public decision.

## Target experiment

Run the following tests against synthetic data in disposable databases with two explicitly paired test peers. Do not use copied personal, project, or production memories. Record only bounded pass/fail outcomes and reason classes.

### 1. Signed direct-path baseline

1. Start both sync daemons.
2. Pair the peers using the existing trust flow.
3. Configure the current routable pod address as a direct candidate.
4. Create an authorized synthetic test scope. Seed one peer with more synthetic records than the configured snapshot page limit and leave the receiver without shared records or a cursor for that peer.
5. Complete signed `/v1/status` and a snapshot bootstrap spanning at least two `/v1/snapshot` pages.
6. Create a synthetic operation on the receiver and complete scoped `/v1/ops` exchange in the reverse direction.
7. Reapply an already-seen synthetic operation and confirm idempotent apply does not duplicate or alter canonical state.
8. Confirm scope authorization, cursor advancement, and reset boundaries remain canonical.

Passing proves the current private route supports Codemem sync. Authentication or scope failure after an HTTP response is not a reachability failure. Complete this case before intentionally recreating or rescheduling the remote workspace in case 3. If the address changes during this baseline, record `blocked` and restart case 1 with the fresh candidate; do not record a signed-sync failure.

### 2. Listener lifecycle classification

1. Stop the remote sync daemon without changing networking.
2. Confirm the same candidate changes from HTTP-reachable to connection-refused or equivalent listener failure.
3. Restart the daemon and confirm signed reachability returns.

Passing proves diagnostics can distinguish listener lifecycle from missing network routing. This experiment does not authorize changes to daemon lifecycle behavior.

### 3. Address-churn behavior

1. Record that a baseline candidate set exists without storing, hashing, or fingerprinting its values.
2. Recreate or reschedule the disposable remote workspace through its normal private lifecycle.
3. Confirm whether the pod address changes.
4. Record whether coordinator refresh replaces the old set, merges and retains stale candidates, leaves the set unchanged, or cannot be determined.
5. Confirm direct sync either recovers through a new routable candidate or fails with a bounded routing/address reason.

Passing identifies whether current discovery is sufficient for ephemeral endpoints. The public report must not include either address.

### 4. Stable direct endpoint

If private platform policy permits and the operator separately approves the infrastructure change, they may test a private stable Kubernetes Service, internal Ingress, mesh route, or equivalent endpoint outside this public repository:

1. Route the stable endpoint to the Codemem sync listener.
2. Configure Codemem to advertise that endpoint explicitly.
3. Repeat signed bidirectional sync before and after pod recreation.
4. Test from every peer network that the deployment intends to support.

No public exposure is required or authorized. Environment-specific manifests and adapters remain private. If one stable private endpoint survives recreation and is reachable from all required peers, direct signed HTTP solves this deployment shape without relay.

### 5. Route-unavailable peer

From at least one authorized peer network without access to the pod route or stable private endpoint:

1. Refresh coordinator discovery.
2. Evaluate each currently supported direct candidate once; do not loop or bypass existing rate limits.
3. Confirm failures occur before HTTP response and classify them as DNS, timeout, refused, unreachable, or no candidate.
4. Verify both peers can maintain outbound HTTPS and WebSocket connectivity during the same test interval.

An HTTP 401, 403, 409, 429, or other HTTP response proves reachability. Record 429 as `rate_limited`, not as a routing failure. This is the decisive live-relay case only when authorized peers are simultaneously online, direct signed HTTP cannot establish a route, and both can initiate outbound connections. If no required peer network lacks direct routing, this test is not satisfied and the remote-workspace deployment does not independently justify relay.

## Bounded result record

The experiment report may record only:

- test case identifier from the five cases above;
- UTC date, not exact user activity timestamps;
- `pass`, `fail`, `blocked`, or `not_applicable`;
- bounded path class: `ephemeral_direct`, `stable_private_direct`, `outbound_websocket`, or `none`;
- bounded result class: `http_reached`, `auth_failed`, `scope_failed`, `rate_limited`, `listener_stopped`, `dns_failed`, `connection_refused`, `connect_timeout`, `network_unreachable`, `no_candidate`, or `unknown`;
- whether the candidate set changed after normal recreation;
- candidate-cache result after refresh: `replaced`, `merged_stale_retained`, `unchanged`, or `unknown`;
- outbound overlap: `observed`, `inferred`, or `not_confirmed`; and
- redacted limitations and follow-up.

The report must not contain memory or operation payloads, memory/operation IDs, project or scope labels, raw device IDs, public keys, fingerprints, addresses, hostnames, workspace names, organization identifiers, exact online timelines, credentials, or raw error strings. It remains local until manually reduced to generic architecture facts suitable for this public plan.

`unknown` never supports a relay conclusion. An `unknown` result in case 5 makes that case `blocked` until a bounded classification is available. `inferred` outbound overlap is a limitation; only `observed` overlap satisfies the continue-relay-review outcome.

## Decision outcomes

### Prefer stable direct sync for the tested deployment

Choose this result when:

- signed bidirectional sync passes;
- a stable private endpoint survives normal recreation; and
- every required peer network can route to it.

Relay may still be valuable for other deployment shapes, but this experiment does not supply that evidence.

### Continue live-relay architecture review

Choose this result when:

- signed sync works over a reachable direct candidate, proving protocol/auth correctness;
- at least one required peer network cannot route to any stable direct candidate;
- both authorized peers have `observed` outbound overlap and can initiate outbound WebSocket connections; and
- operator-managed tunnels or public exposure are not acceptable product requirements.

This outcome permits continued protocol, threat-model, and implementation-planning review. It does not authorize relay code and does not bypass `codemem-zjvr.1.5` or the recipient-bound-signature prerequisite `codemem-zjvr.1.10`.

### Fix direct-sync or deployment prerequisites first

Choose this result when signed sync fails despite an HTTP-reachable listener, the daemon is not reliably running, stale candidate replacement is broken, or a permitted stable endpoint has not yet been tested. These failures must not be used to justify relay.

## Follow-on ownership

- `codemem-zjvr.1.9` runs and records the targeted experiment without adding persistent telemetry or changing sync behavior.
- `codemem-zjvr.1.6` evaluates the bounded report and recommends stable-direct, continue-relay-review, or fix-prerequisites-first. Its recommendation must state the single-deployment scope, untested networks and policies, blocked/unknown cases, and limits on generalization.
- Private deployment adapters own environment-specific Service/Ingress or mesh configuration.
- Relay implementation remains blocked on the existing architecture and security gates.
