# Relay dogfood review and availability decision

Date: 2026-11-06
Beads: `codemem-zjvr.2.9` (dogfood), `codemem-zjvr.2.10` (review), `codemem-zjvr.2.20` (gates)
Decision: relay ships in 0.48 as the fallback path for devices that cannot reach a peer directly. It is on wherever the coordinator advertises it and a device can turn it off. Coordinator-assisted hole punching stays out of 0.48.

## What was tested

Two real devices on the production Cloudflare coordinator, both members of the `nerdworld` and `sre` groups, sharing three team Spaces (`oss`, `personal`, `household-os`). The Mac sat on a VLAN that can reach out but cannot be reached, so its passes to the work laptop had to use relay while the work laptop could still reach the Mac directly. The trial ran from 2026-11-05 20:00 UTC to 2026-11-06 17:20 UTC, including one unattended night and one VLAN switch back to a two-way network.

Production setup on 2026-11-05: D1 migrations 0041 and 0042, relay admission rows and quota for both realms, a health probe device enrolled in both groups, the service key secret, and Worker versions `9e3abd2f` then `c59fbe04`. Both devices ran `main` builds and updated after each fix below.

## Results

Mac to work laptop, 644 passes over 21 hours: 533 succeeded and sent 2,384 ops. In the four-hour window when direct was unreachable, 112 of 120 passes succeeded over relay and delivered 39 ops. When the VLAN switched back, the next pass after the network settled went direct with no restart. Both realms and the authority row stayed `ready` through the night and through a Worker deploy; readiness revisions advanced every five seconds.

The 111 failures break down as 71 direct-unreachable results that preceded a relay attempt (the expected fallback order), 18 `relay_admission_failed` during one five-minute readiness trip and two viewer restarts, 8 generic exchange failures during restarts, and 14 relay route faults (`relay_expired`, `relay_aborted`, `relay_unavailable`, `relay_rejected`) that the next pass recovered from. No pass lost data: every op the relay delivered was applied once, and the receiver deduplicated the few ops the direct path resent before #2547.

## Defects found and fixed during the trial

| Found | Effect | Fix |
| --- | --- | --- |
| Relay only routed `managed_project` Spaces | Team Spaces never relayed | #2543 |
| Relayed push saved its ACK only after the whole window | A pass that ran out of time resent 500 ops next time | #2544 |
| Relay channel ACK started empty | First relayed push resent the Mac's whole `oss` history, 116k ops | #2545: the peer reports its pull cursor in status |
| Health monitor tripped with no recorded reason | A group went dark for five minutes with nothing to diagnose | #2546: trip reason in the snapshot and Workers Logs |
| Direct sync resent ops relay had delivered | Bandwidth waste on every path switch | #2547 |
| Relay tried 0.47 peers every two minutes | 560 REJECTED answers in one night for two peers | #2557: feature advertisement, stored peer features, back-off |

One trip of the `nerdworld` monitor on 2026-11-05 remains unexplained because it predates #2546. It did not recur in the following 20 hours.

## Gate review

| Gate | Result | Evidence |
| --- | --- | --- |
| Direct first, relay only as fallback | Pass | Every pass tried direct; relay ran only after direct failed; direct resumed on its own after the VLAN switch |
| Scope enforcement | Pass | Only Spaces both devices are authorized for relayed; the relay channel runs the same scope checks as direct (`docs/contracts/peer-http-scoped-dispatch.md`) |
| Encrypted opacity | Pass by construction | Noise channel end to end; the relay sees only frame sizes and session IDs; traffic quota counts bytes (`docs/contracts/relay-protocol.md`) |
| Limits | Pass | Per-realm quota, per-address upgrade fairness (#2523, #2535), 1 MiB page cap (#2520), 8 groups per Worker |
| Observability | Pass with caveat | Readiness rows, `sync_attempts` reason codes, trip reasons in Workers Logs. Caveat: Cloudflare analytics for cost need an API token with analytics read, not yet provisioned |
| Standalone compatibility | Pass | A coordinator without relay answers `401` for `/v1/relay/info`, devices resolve `disabled: info_unavailable`, sync stays direct; 0.47 peers ignore the new sync features |
| No durable queuing | Pass | The relay holds no messages; an offline peer gets REJECTED and the sender waits |
| Device opt-out | Pass | `sync_relay_enabled: false` or `CODEMEM_SYNC_RELAY_ENABLED=0`, documented in `docs/relay.md` |
| User-facing language | Partial | Attempt reason codes distinguish relayed, waiting, and direct. The viewer's Devices tab does not yet say which path a peer last used |
| Hole punching | Not attempted | `codemem-zjvr.2.18` is a research spike with no integrated transport; deferred to a 0.49 go/no-go |

## Unproven

- Cost. The Worker, Durable Object duration, and D1 row numbers for a month of relay were not pulled. The health probe alone makes about 5,760 coordinator requests a day per Worker. Provision an analytics token and read the first month before promoting relay beyond self-hosted operators.
- A third relay-only device. Both trial devices could reach each other in at least one direction. A pair with no direct path in either direction exercised only the acceptance harness, not production.
- `sre` group under load. Only the probe device used the `sre` realm during the trial; the user's `sre` devices were not on a relay build yet.

## Decision

Relay is good enough to ship as the 0.48 fallback. The fixes above are all merged, the remaining unknowns are cost and one unexplained trip that is now diagnosable, and neither blocks devices that today cannot sync at all when they are on different networks. Hole punching would only reduce relay traffic for pairs that can hole-punch and has weeks of engine work left, so it stays out of 0.48.

Follow-ups: `codemem-zjvr.2.30` (closed by #2557), `codemem-zjvr.2.31` (Devices tab transport indicator), `codemem-zjvr.2.32` (first-month cost readout).
