# Remote Workspace Connectivity Evidence Report

**Date:** 2026-08-09
**Status:** Completed — fix prerequisites first
**Bead:** `codemem-zjvr.1.6`
**Experiment:** `codemem-zjvr.1.9`
**Related:** `2026-08-09-remote-workspace-connectivity-evidence-design.md`, `2026-08-08-relay-assisted-sync-design.md`

## Executive conclusion

Direct signed HTTP synchronization works on the tested ephemeral private route. Signed scoped exchange succeeded in both directions, repeated application remained idempotent, listener stop/restart behavior was classified correctly, and a replacement listener remained reachable after workspace recreation.

The experiment does **not** justify relay implementation:

- no required peer network in the single tested deployment lacked a direct route;
- no simultaneous-online route-unavailable case was observed;
- stable private exposure was not tested; and
- two prerequisite cases were blocked by bootstrap behavior and incomplete peer-identity persistence in the disposable harness.

The approved outcome is **fix prerequisites first**. Relay implementation remains unauthorized. Direct signed HTTP remains canonical for the tested deployment shape.

## Bounded results

| Case | Result | Path/result class | Evidence |
| --- | --- | --- | --- |
| 1a. Signed bidirectional exchange and idempotency | `pass` | `ephemeral_direct` / `http_reached` | Signed scoped synchronization passed in both directions. Daemon-driven initial synchronization populated the receiver, and repeated application preserved canonical counts. |
| 1b. Explicit multi-page snapshot bootstrap | `blocked` | `ephemeral_direct` / `precondition_violated` | Explicit bootstrap ran after daemon-driven synchronization had populated the receiver, violating the required no-records/no-cursor precondition. It applied zero records, so the experiment cannot distinguish correct idempotent behavior from a pagination or application defect. |
| 2. Listener lifecycle | `pass` | `ephemeral_direct` / `listener_stopped`, then `http_reached` | Stopping the daemon changed the same route from HTTP-reachable to listener refusal. Restart restored signed reachability without corrupting canonical state. |
| 3. Address churn | `blocked` | `ephemeral_direct` / `precondition_violated` | Normal recreation changed the candidate. The replacement listener was reachable, but coordinator cache refresh for the prior identity could not be tested because its external signing key was not restored with the copied database. This case ran before case 1b completed; that ordering deviation did not cause the independent missing-key blocker. |
| 4. Stable direct endpoint | `not_applicable` | `none` | No Service, Ingress, mesh route, or other stable endpoint mutation was authorized. |
| 5. Route-unavailable peer | `not_applicable` | `none` | Not run: no qualifying peer network was available. The tested peer network could route directly to the listener, so the route-unavailable case remains untested rather than disproven. |

## Interpretation

### Direct transport and signed protocol

The experiment separates transport reachability from authentication and replication correctness:

- an HTTP response proved the tested route reached Codemem;
- signed peer authentication and scoped authorization succeeded;
- operations traveled in both directions; and
- repeated synchronization remained idempotent.

The earlier listener refusal was correctly classified as daemon lifecycle, not missing network routing. It must not be reused as relay evidence.

### Multi-page bootstrap prerequisite

Normal daemon-driven synchronization populated the receiver before explicit bootstrap ran. The receiver was therefore no longer in the no-records/no-cursor state required by the experiment design. Explicit bootstrap then applied zero records while the synthetic source exceeded one snapshot page. That result is consistent with either correct idempotent behavior or an undiscovered pagination/application defect; this experiment cannot distinguish them and did not prove explicit paginated bootstrap across at least two pages.

`codemem-hdah` owns a controlled rerun that enforces an empty receiver and absent cursor before explicit bootstrap. Only if that rerun still applies zero records should it be classified as a replication/bootstrap defect. Either outcome is unrelated to transport selection.

### Complete identity persistence prerequisite

Workspace recreation changed the ephemeral candidate and the replacement listener was reachable. Database-only restoration did not preserve the signing material needed to authenticate as the prior peer identity and refresh coordinator presence. The old cached candidate therefore could not be evaluated under a valid restored identity.

`codemem-q71r` owns the backup/restore contract for database state plus external signing-key material. This is an identity-persistence and test-harness prerequisite, not a routing failure.

### Relay decision

The continue-relay-review outcome required at least one authorized, simultaneously online peer network that could not route to any stable direct candidate while both peers could establish outbound WebSocket connections. The experiment did not contain such a network. Case 5 was `not_applicable` because no qualifying network was available; it remains untested rather than disproven, and the experiment supplies no affirmative relay-need evidence.

This conclusion is intentionally narrow. An outbound live relay may still be valuable for other networks or deployment policies, but that claim requires evidence from a real route-unavailable case and remains gated by the architecture and security prerequisites in `2026-08-08-relay-assisted-sync-design.md`.

## Recommendation

1. Rerun explicit multi-page scoped bootstrap with its precondition enforced under `codemem-hdah`.
2. Define and validate complete peer-identity persistence under `codemem-q71r`.
3. Rerun cases 1b and 3 under `codemem-9dnf` after both prerequisites close.
4. Test a stable private endpoint only with separate operator approval.
5. Run case 5 only when a required peer network genuinely lacks direct routing.
6. Do not implement relay from the current evidence.

## Limitations

- This was one disposable deployment and one directly routed private peer network.
- No stable direct endpoint was created or tested.
- No required route-unavailable peer network participated.
- Address-cache replacement after recreation was not observed under a restored identity.
- Case 3 ran before the case 1b bootstrap proof completed, deviating from the planned order; its missing-key blocker was independent of that order.
- Explicit multi-page bootstrap remained blocked.
- Synthetic data exercised synchronization behavior; no production corpus or payload was inspected.
- Results do not generalize to networks, cluster policies, or deployment environments that were not tested.

## Privacy and cleanup

The public report contains no environment-specific names, hostnames, addresses, organization identifiers, device identifiers, credentials, project/scope labels, memory/operation identifiers, raw errors, or payload content. Disposable workspaces, daemons, coordinator state, databases, and temporary artifacts were removed after the experiment.
