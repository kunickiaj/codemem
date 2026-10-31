# Relay operations and safety contract

**Status:** Reviewed v1 operations contract for a coordinator-backed, live-only
relay. `.1.5` approves local disabled-by-default implementation only. Hosted
execution, real-device dogfooding, activation, and deployment remain separate
gates. The operational targets and host guarantees below are still unproved.

**Task:** `codemem-zjvr.1.7`. The targets below are proposed operational
objectives. They are not active or measured service-level objectives.
Related suffixes such as `.1.5` refer to `codemem-zjvr.1.5`.

## Purpose and scope

This contract limits a future relay before it can forward an encrypted peer
stream described by [the relay protocol](relay-protocol.md) and [the encrypted
peer stream contract](relay-encrypted-peer-stream.md). Direct sync retains its
current behavior and does not gain a 24-hour device-permission lease from relay
admission.

The v1 relay is online-only. It excludes portable tickets, offline cached grants,
a new coordinator issuer key, payload queues, and payload retention. The source,
relay, and responder each make their own configured HTTPS coordinator
request. Neither endpoint accepts a coordinator response forwarded by the relay.
The source pre-signs deliberate one-operation credentials for the forwarded
checks and keeps its own `source` packet local.

Current code has no coordinator response-signing key or admission-check
operation. This contract does not imply that either exists or is ready to use.

The companion admission contract defines packet encodings and verification. This
contract defines the operational constraints around those checks. Until both
contracts are approved, a reference may be incomplete.

## Admission and authority window

Each new HTTP exchange has three independently verified source-signed v2 operation
packets with distinct durable nonces: one each for source, relay, and responder.
All packets name the same explicit discovery group under v1 rules and use the
current enabled set and global identity/key revocations. They do not grant a
Project, create a pin, or select a peer key automatically.

Source, relay, and responder each fetch a current decision from their configured
coordinator HTTPS origin. They perform three checks per exchange. Neither the
opposite endpoint nor the relay can approve for an honest endpoint. A
relay-forwarded timestamp has no authority.

| Rule | Requirement |
| --- | --- |
| Source proof | At admission, it is at most 30 seconds old. Its creation time can be up to 5 seconds in the future. |
| Route deadline | `route_not_after = source_created + 55 seconds`. The coordinator rejects a deadline more than 60 seconds beyond its own decision time. |
| Local enforcement | Each verifier maps `remainingMs` from its coordinator response to its own request-start monotonic clock. Reply delay cannot extend authority. |
| Residual relay eligibility | Each coordinator backend must remain within plus or minus 5 seconds of UTC, including clock resolution. The resulting difference between backend decisions is at most 10 seconds, giving a conservative 70-second bound for this enrollment/audience admission. This is not a Project-permission lease. Without those bounds, admission is disabled. |
| Caller deadline | The relay's new 60-second default starts at invocation and can expire before admission or the route deadline. Shorter explicit deadlines still win; direct defaults are unchanged. |

An admitted route uses only its remaining deadline. It cannot be extended. A
learned scope, key, or Identity revocation, or an operator switch, stops new
bytes and closes the affected route immediately. Native transport delivery and
canonical handler work already committed cannot be recalled. Endpoints ignore
late bytes and responses after their own lease or caller deadline. Network bytes
already queued for delivery cannot be recalled.

### Authenticated socket registration

A service proof authenticates the relay to the client. It does not authenticate
a client socket to the relay. Before the relay maps a target socket, the client
must complete authenticated socket registration.

1. The relay issues a fresh challenge for the actual WebSocket.
2. The client signs a normal v2 source packet that binds that challenge.
3. The coordinator checks the current enabled self-enrollment state, global
   revocations, and the packet's durable nonce.
4. The relay verifies its own HTTPS coordinator response and the socket
   challenge before it maps the socket to the device.

Registration and every permitted renewal consume one online coordinator check.
V1 grants exactly 900,000 ms, conservatively anchored to request-start time.
They store bounded metadata for at most 15 minutes and grant no route authority.
Each route still requires three fresh coordinator checks and the common 55-second
signed deadline. The design adds no issuer key, secret handshake, or duplicate
device allowlist.
Enrollment authority remains with the coordinator.

When relay is enabled and peers are configured, the existing 120-second client
reconciliation tick checks registration even if outbound data is idle. It renews
when fewer than 150 seconds remain. A valid same-socket registration cannot renew
successfully more often than once per 12 minutes; expiry or a real reconnect
uses the separately bounded registration path. Every attempt uses a fresh
challenge and nonce. This authorization maintenance is an explicit exception to
idle-only work, not a ping or a timer intended to defeat hibernation. No new
high-frequency keepalive is added.

An expired registration cannot open or receive a new route. Earlier routes keep
their own leases. A missed renewal can leave inbound reachability unavailable
until the next tick, normally up to 120 seconds plus a successful check. Outage,
health pause, quota denial, suspension, or clock failure can extend the gap, so
the contract makes no unconditional reachability guarantee.

When capacity permits, a current-key-authenticated registration can replace the
device's old socket. The relay closes all old routes and transfers no ciphertext
or cipher state. Challenges prevent a packet from being used on another socket.
Quotas count pending and closing physical connections. Capacity is released only
after the connection has closed or the relay has accounted for it. A device has
one active registration per realm, plus a bounded closing replacement.
At most one closing replacement is allowed per device and realm. Pending and
closing connections remain charged to physical-socket ceilings until their
closure is confirmed. Before registration, at most 64 pending sockets exist per
service and 16 per configured realm allocation, each with a 30-second setup
deadline. Their upgrade rate is at most 120 per minute per service, burst 16.
Unknown client identity never creates another per-device quota allowance.

## Hosting and isolation

Cloudflare Durable Objects are the recommended host candidate, pending the
proofs below. A self-hosted Node host is a possible fallback that requires
review. It is not an automatic implementation choice. The relay runs in a
separate Worker/service and Durable
Object namespace, or equivalent isolated host resources, with independently
configured health, configuration, and switches.

The relay has no direct coordinator database credentials. It forwards no frames
through the coordinator or D1, and the planes share no payload or session tables.
Only the configured admission-check API performs the required current enrollment
reads and durable registration/route nonce writes in the coordinator's auth store.
Those checks remain a low-priority control-plane budget. Reserve membership
refresh and revocation capacity before admitting relay work.

Separate namespaces do not prove hard isolation when an account or provider
quota is shared. Activation requires an account and plan headroom review, a load
test, and evidence of independent resource partitioning. If shared limits cannot
protect coordinator work, operators disable relay admission or choose a reviewed
separate account or host allocation.

The root relay switch must not depend only on coordinator health. A healthy
coordinator with relay disabled is distinguishable from an unavailable relay.

## Durable Object lifecycle

Use the hibernatable WebSocket API when the host supports it, including
`state.acceptWebSocket`. Do not assume the standard WebSocket API hibernates.
Connected clients can remain connected while in-memory state is evicted, and a
constructor can run on wake.

Attachments contain only bounded metadata: identity, opaque realm, policy
revision, lease bounds, route identifier, pair, expiry, and counters. Target at
most 8 KiB per attachment and never exceed the documented 16 KiB limit. Durable
metadata storage holds quota reservations, counters, replay state, and switch
policy. Neither location contains ciphertext, Noise private or session keys,
signed credentials, source packets, or pending application queues.

On hibernation recovery, restore socket-registration metadata only when it is
unexpired, verified, and attached to the same healthy WebSocket. Missing state
fails closed. Attachments never contain raw packets, signatures, or private keys.

Store reservation and counter metadata durably before forwarding. After
interruption, the system may lose traffic or capacity. It must not mint quota or
replay authority or reset a budget. Restore a routing entry only after full
validation and only while its
deadline remains. If the implementation cannot prove that a route has no queued
application bytes and valid forwarding state, it fails closed for that route.
Clients then start a fresh canonical exchange with new route, Noise keys, and
nonces. They never retry raw ciphertext.

Process-local monotonic timestamps alone cannot restore a lease after eviction.
At the original check, compute the effective monotonic deadline including local
caps. Snapshot its remaining duration and the host UTC clock together. Retain
`restoreNotAfterUTC = utcSnapshot + effectiveRemainingMs - 10000`, alongside the
authority deadline. The guard covers a change between two host clocks each
within five seconds of UTC. If monotonic continuity is unavailable, reconstruct
only the time left before that fixed conservative bound using a verified host
UTC clock. Never restore as
`wake time + original remainingMs`, and never revive a closed or expired route.
If the host clock bound or the original conservative bound is unavailable, close
the affected route. Registration restoration follows the same non-extension rule.

No recurring keepalive, poll, or ping may keep an object resident. One earliest-
expiry alarm may perform cleanup. Alarms can wake an object and can be delayed or
delivered at least once, so every event checks expiry before admission or send.
A sleeping object can leave a physical WebSocket open but cannot process later
expired bytes. The relay promises no application forwarding after expiry, not
delivery timing for bytes already in native queues.

## Capacity and backpressure

The following ceilings are proposed initial limits. They are neither measured
defaults nor an activation decision. Every request intersects all applicable
limits and capacity reservations persist across hibernation and restart.

| Dimension | Service | Realm | Device | Pair or route |
| --- | ---: | ---: | ---: | ---: |
| Sockets | 1,024 total physical connections | 128 total physical connections | 1 active registration plus at most 1 closing replacement per realm | — |
| Routes | 256 | 32 | 4 | 2 unordered, one per direction |
| Open rate per minute (burst) | 1,024 | 128 | 30 (4) | 20 (2) |
| Control rate per minute (burst) | — | — | 120 (16) | — |
| Traffic per minute (burst) | 1 GiB (256 MiB) | 128 MiB (64 MiB) | 64 MiB (40 MiB) | 40 MiB (40 MiB) |
| App-managed queued ciphertext | 128 MiB | 16 MiB | 2 MiB | 256 KiB per direction |

Each exchange also has a 20 MiB wire cap and 2,048 frame cap. Its 65,558-byte
maximum frame remains below the documented 32 MiB WebSocket receive-message
limit. Endpoint transport buffers are capped at 40 MiB per route. The relay does
not allocate a complete HTTP body. A realm object's 16 MiB application queue
does not mean it has a dedicated 128 MiB isolate.

The application queue cap does not bound native, operating-system, or provider
buffers. The provider can allocate an incoming message before a handler enforces
the smaller protocol cap. `send()` success is not a delivery receipt, and a hard
native outbound queue bound or `bufferedAmount` behavior is not documented.
Activation therefore requires slow-reader, oversized-input, overload, and
hibernation proof for the selected host.
If that proof cannot show a hard native bound, `.1.5` must revise the deployment
choice. It cannot waive the gate or claim a guarantee.

Distribute a finite global service quota through persisted shard allotments whose
sum stays within the service ceiling. An isolate must not receive the whole
budget. Reserve bounded byte chunks before forwarding. An interruption can lose
unused reserved capacity but cannot reset consumption. Operator quota changes and
rolling deployments must keep old and new allotments within the same total.

The effective route-open ceiling is
defined in checks and routes **per minute**. For each configured relay audience,
let `C` be its validated coordinator check allocation after protected membership,
presence, revocation, and probe capacity is reserved. Let `N_r` be the validated
device/realm registration population in realm `r`, and `U_r` its bounded churn
reserve. Define `R = sum_r(ceil(N_r / 12) + U_r)` checks per minute. Twelve minutes
is the minimum normal renewal interval. The initial service-wide churn reserve is
four checks per minute, partitioned among realms, and includes reconnects,
replacement, and failed-registration retries.

The effective open rate is at most `floor(max(0, C - R) / 3)` routes per minute,
intersected with every other open-rate ceiling. Registrations cannot borrow the
protected membership budget, and routes cannot borrow `R`. Registration attempts
are bounded by that pool and cannot borrow the route-check allocation either. A profile with
`C < R` is invalid. Audience allocations sum to no more than the coordinator
authority's validated total. Realm allocations and burst allowances are finite
and validated too. Admission stays off until capacity and recovery validation
pass; the static ceilings do not promise availability or an SLO.
Logical route bytes count each frame once across the two traffic directions,
including bytes reserved before a forwarding failure. Provider capacity and
billing review separately includes both ingress and egress legs. Reservations
cannot be refunded by reconnecting or replacing a socket.

The proposed device and pair rates are unvalidated. Activation requires a
complete empty-receiver bootstrap under the approved data and workload, including
restart after a quota denial. The implementation must pace or adapt quotas, or
use a bounded `Retry-After` retry that preserves validated pages and the same
boundary. It must not restart indefinitely at the first page or block membership
refresh while waiting. Current clients do not show that behavior.

### Coordinator-side admission budget

The coordinator enforces every registration and all three role checks, including
the source's direct call. A relay-side limiter cannot enforce that budget.
The new endpoint uses a dedicated admission-budget authorizer and must not spend
the existing `POST:auth:<deviceId>` bucket used by presence updates. Other
coordinator routes keep their existing limiter behavior.

| Admission check bucket | Proposed bound |
| --- | --- |
| Coordinator authority | Validated total checks/minute and burst after protected capacity reservations. Default zero. |
| Audience and realm | Finite suballocations whose sums stay within that authority total. |
| Verified source device and realm | 96 check attempts/minute, burst 16, shared by source/relay/responder and registration purposes. |
| Registration purpose for that device/realm | 2 attempts/minute, burst 2, including reconnects and renewals. |

Thirty opens/minute require up to 90 checks plus registration, so the separate
96-check ceiling accommodates that proposed open rate without consuming the
presence bucket. All device limits in this contract are per `(deviceId, realm)`;
authority and audience parent allocations prevent multiplication across realms.

Before enrollment lookups, admission-only authority/realm ingress reservations
bound unauthenticated attempts. After signature verification, a device reservation
uses the verified signer, not an untrusted device header. Durable/shared counters
or finite pre-reserved shard leases enforce both stages across isolates, restart,
and reconnect. The current per-isolate limiter does not meet this requirement.
Unknown quota state denies the check. Reservations precede the eligibility
decision, consume attempts even on failure, and cannot be reset or refunded by
retries. The final store decision still requires current policy and readiness.
This requires a new admission-specific dispatch path and budget dependency in
`createCoordinatorApp`. If that dependency is absent or unavailable, the endpoint
is disabled rather than falling back to the ordinary per-isolate limiter.

## Shedding, health, and switches

Reject excess upgrades, opens, and admission checks before accepting relay data.
When membership health is degraded, unknown, or stale, stop new routes. Close
affected routes when safety requires it. Coordinator refresh, direct sync, and
local work take priority over relay work. Denials and status responses use finite
codes and reveal no presence, scope, raw coordinator error, or connection roster.
An offline coordinator permits no new registration or route.

Pre-authentication fairness additionally allows at most two pending sockets per
trusted transport-derived network address and ten upgrade attempts/minute, burst
two. These best-effort in-memory counters expire after one minute and have a
finite 4,096-entry bound per host. They never persist or log addresses and never
trust caller-supplied forwarding headers. They supplement hard service caps;
they are not a distributed ceiling. NAT collisions and distributed floods can
still deny relay availability. Direct/local fallback remains independent.
Before verification, callers can also name a victim realm and consume that
admission-only ingress allowance. This may pause relay in that realm. The fallback
accepts this availability risk and never borrows membership or presence capacity
to compensate.

### Health observation and publication

A coordinator-owned health controller consumes trusted server instrumentation
and an operator-controlled probe. Public peers cannot submit health reports.
Server instrumentation measures authenticated `GET /v1/scopes` and
`GET /v1/scopes/:scope_id/members` from dispatcher entry through completed response
construction, including auth, nonce, and database work. It keeps authority and
configured-realm aggregates separately for each endpoint class. Probe requests
count toward server-side freshness. Real-client and probe-originated server
latency/failure aggregates remain separate. Probe clients independently measure
request-start to complete validated response over the real HTTPS path. A nonempty
real-client window must pass its own rules and can trip admission regardless of
probe speed. Missing real-client traffic alone is not unhealthy if the required
probe and server paths are fresh.

The default probe cycle is once every 30 seconds while monitoring is enabled,
at most two cycles or four endpoint requests/minute per realm. Higher rates
require a new protected-capacity allocation. An approved probe uses a normal
enrolled low-privilege device to call those real v2-authenticated catalogue
and member-snapshot paths with its configured `group_id` and an operator-owned
synthetic scope. It validates the
response without memory payloads. No database ping substitutes for this path.
Probe credentials/fixtures require operator provisioning. Probe observations
arrive through a trusted internal producer link, never a public client-reporting
API, and retain their actual completion time rather than becoming fresh on receipt.
Probe timestamp readings, including resolution and rounding, must also remain
within five seconds of UTC. An unverified or out-of-bound probe clock makes
health unknown. Receipt time cannot replace a delayed observation's completion.

The controller requires a fresh server-path success and probe-client success for
each endpoint class. The server observation may be a probe request. Real-client
latency and failures remain independently enforced when present. Catalogue
success alone cannot renew member-snapshot health.
It publishes durable readiness metadata for the authority and realm:
revision, state, observation time, and qualifying-window counts. It retains only
aggregates, never response bodies or device work histories. For each required
endpoint/cohort combination, take its most recent successful observation.
`observedAtMs` is the minimum of those timestamps. The exposed readiness stamp
is `{revision, state, observedAtMs, validUntilMs}`, with
`validUntilMs = observedAtMs + 50000`. The ten-second clock margin limits actual
observation age to 60 seconds under the verified backend clock bounds. Reject
`observedAtMs > decisionNowMs + 10000` or `validUntilMs <= decisionNowMs`.
Missing, inconsistent, stale, or unavailable metadata means paused admission.

The admission endpoint checks this current record before eligibility and in its
final conditional decision. It returns a ready stamp only in each participant's
own successful HTTPS reply. The relay obtains its signal there, without per-frame
polling or trusting another participant's report. Revoked audiences and readiness
updates have monotonic coordinator-owned revisions. Current code has neither
this controller nor these enforcement hooks.

### Health state rules

Apply the rules to each endpoint's probe-client and probe-originated server
cohorts and every nonempty real-client server window. Require all applicable
cohorts to be healthy. A system failure includes unexpected
backend/transport errors,
timeouts, malformed probe responses, or a completion beyond three seconds.
Correct authorization denials are not system failures or positive probe results.

- For a one-minute window with at least 20 samples, bad means p95 above one second
  or system failures above 0.1 percent. Two consecutive bad windows trip admission.
- For 1–19 samples, a healthy low-volume window has at least one fresh full-path
  success, no system failures, and every completion within three seconds. Do not
  publish a statistically unsupported p95. Any system failure trips this mode.
- Missing or stale required freshness observations pause admission. One fresh valid observation can
  clear a no-data pause within the validated capacity ceiling.
- An overload/error trip requires five consecutive healthy one-minute windows
  before recovery. Every window needs fresh observations in the two required
  probe cohorts, and any nonempty real-client window must also be healthy. For
  20 or more samples, healthy requires p95 at most one second and failures at most
  0.1 percent. The low-volume definition above covers smaller windows.

These are new proposed readiness modes. They monitor coordinator work, not the
residency of a relay object, and do not add keepalive traffic to a relay DO.

Independent local-client, service, realm, device, and pair switches apply before
opening or emitting bytes. A local-client switch acts synchronously. Policy
revisions are monotonic. After an authoritative coordinator decision commits a
disabled audience or participant, it grants no new routes. Cached relay events
are best effort only. Once an endpoint learns a switch or revocation, it stops
forwarding and closes the route. Offline clients have no instant-revocation
guarantee. Unchanged leases, observed clock bounds, and local deadlines bound
future acceptance and sending.

After restoring stale nonce or revocation state from a database backup, disable
admission until authoritative policy state is resolved and every accepted packet
window has elapsed. Passing time alone does not repair lost revocations. A nonce
replay never succeeds.

## Rollout, observability, and privacy

New setups do not automatically use relay fallback until approved dogfooding and
disclosure. Existing setups require explicit opt-in. A coordinator-only setup
continues to work while relay health is disabled or unavailable.

Proposed retention is seven days for detailed operational events, 30 days for
aggregate counters, and 90 days for policy-change audit records. Routine logs
and metrics use finite codes and rotating realm-scoped pseudonymous identifiers.
They exclude raw scopes, keys, tickets, source packets, signatures, full URLs,
IP addresses, peer rosters, payloads, and route-length or timing traces that
permit linkability.

Payload logging must be disabled across platform tailing, log-push, tracing,
error pipelines, and browser-client logging before activation. This requires
deployment verification. Diagnostics use bounded, nonblocking buffers and shed
low-priority logs first. A failed audit blocks an enabling change, a new audience,
or a quota increase. A disablement, revocation, or quota tightening applies
immediately when the audit sink fails, writes a bounded local fallback record,
and alerts an operator. The system must expose audit loss and must not re-enable
relay admission until audit recovery is complete.
These rules cover application-managed logging and configured observability.
Provider-wide metadata collection or deletion is not guaranteed by application
settings. Activation review must document the provider's controls and disclosed
limits, and must reject a deployment that cannot meet the agreed privacy policy.

## Measurement targets and activation evidence

These proposed objectives require future measurement. Activation does not require
30 days of production history. It requires representative approved load, soak,
and saturation evidence before activation. Human review documents the rolling
window and coverage for a later operating objective.

| Target | Evidence |
| --- | --- |
| Membership server handling | Coordinator instrumentation shows 99.9% completion within 3 seconds over rolling 30 days for the approved authenticated membership workload, including adversarial relay limits. This excludes client network time. |
| Membership end-to-end | Operator-controlled probes separately show 99.9% complete validated responses within 3 seconds, including their network path. Do not pool these samples with server handling. |
| Online convergence | In the approved instrumented validation cohort, 99% converge within 150 seconds from a coordinator commit marker to successful local membership installation. Exclude offline/suspended clients and record skipped ticks/presence failures. This does not claim automatic fleet-wide client telemetry. |

The current 60-second membership-cache label is a UI measurement, not a permission
lease. Current serialized sync ticks and failed-presence ordering require future
work before they can meet the convergence target.

The final validation plan includes saturation against the measured coordinator
target, slow readers, native buffering, realm quotas through restart and
hibernation, in-flight termination, lease expiry, clock faults, database restore,
stale policy, a disabled relay with a healthy coordinator, redaction, and alarm
delay. It must show no instant-expiry claim for alarms or physical delivery.

## Open gates and references

`.1.4` finalizes admission-proof shape. `.1.5` remains the human architecture
gate. `.1.7` defines the design target and does not certify a runtime.

- [Relay protocol](relay-protocol.md)
- [Encrypted peer stream](relay-encrypted-peer-stream.md)
- [Relay admission](relay-admission.md)
- [ADR 0004](../adr/0004-authenticated-identity-and-live-relay-boundaries.md)
- [ADR 0005](../adr/0005-authenticated-identity-device-and-membership-lifecycle.md)
- [`sync-daemon.ts`](../../packages/core/src/sync-daemon.ts), [`coordinator-sync-config.ts`](../../packages/core/src/coordinator-sync-config.ts), and [`scope-membership-cache.ts`](../../packages/core/src/scope-membership-cache.ts)
- [`request-rate-limit.ts`](../../packages/core/src/request-rate-limit.ts) and [`coordinator-api.ts`](../../packages/core/src/coordinator-api.ts)
- [Current viewer health route](../../packages/viewer-server/src/routes/health.ts) and [coordinator Worker configuration](../../packages/cloudflare-coordinator-worker/wrangler.jsonc)
- [Cloudflare WebSocket best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Cloudflare Durable Object state API](https://developers.cloudflare.com/durable-objects/api/state/)
- [Cloudflare Workers WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
