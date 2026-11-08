# Relay runtime local guidance

The internal entry point, `@codemem/core/internal/relay-runtime`, now exports the WebSocket runtime and quota types alongside `createRelayPeerClient`, `RelayHealthMonitor`, and their types. It supports local, programmatic composition. On a device, `codemem serve` builds relay clients from the configured coordinator, as described in [Device relay configuration](#device-relay-configuration). There is no RTC transport.

Two authorized peers can converge one Space through WebSocket relay, Noise, channel-bound HTTP, SQLite-backed admission, and quota checks. This describes the implemented API and local test scope. Hosted capacity, TLS operation, native and operating-system limits, clock evidence, audits, and dogfooding still require an approved environment and proof.

The reviewed contracts remain authoritative: [relay operations](contracts/relay-operations.md), [relay admission](contracts/relay-admission.md), and [channel-bound scoped dispatch](contracts/peer-http-scoped-dispatch.md).

## Compose the runtime

`createRelayWebSocketRuntime()` accepts upgrades only when all of the following are explicit:

- `enabled: true`
- positive `sockets`, `pendingSockets`, and `writeBytes` limits
- a `reserveUpgrade` callback that returns `"reserved"`

The defaults are disabled and zero. The runtime never calls `listen()`.

Pass `options.server` to co-host upgrades on an existing Node HTTP(S) server. The application that owns that server owns its header and connection limits, request handling, and listener lifecycle. `await runtime.close()` removes relay handling and waits for relay sockets and pending upgrades. It does not close the co-hosted listener.

Without `options.server`, the runtime creates a local Node server for tests. The caller chooses and starts its listener. `runtime.disable()` rejects new upgrades and closes existing relay sockets. The relay signer comes from `RelayServerOptions.signer`. The caller owns service-key storage and rotation.

## Sync through a selected route

Use `runSyncPass` with `reachability` only when the caller has an explicit Space, logical origin, and relay client. A normal direct-only call with no options behaves as before.

```ts
await runSyncPass(db, peerDeviceId, {
  keysDir,
  dbPath,
  reachability: {
    scopeId,
    logicalOrigin,
    relay: client,
    signal,
    deadlineMs,
  },
});
```

Direct sync keeps its legacy full-scope behavior. The selector gives direct addresses up to 10 seconds to return a status response. Once direct commits, its existing per-request timeouts apply, so a large direct bootstrap can finish beyond 60 seconds. An explicit one-shot caller deadline still limits it. If direct is unreachable before commitment, the relay attempt uses the remainder of a 60-second fallback budget. The intended order remains direct, approved traversal when a runtime capability exists, relay, then wait. The current runtime has no approved RTC factory, so it uses direct, relay, then wait.

The direct status response must match the peer's pinned fingerprint before the route commits. After commitment, a failure cannot trigger another address or transport, or replay possibly applied work. A synthetic `logicalOrigin` is neither dialed nor persisted as a peer address. The relay client creates a fresh route and Noise session for each HTTP request. Source, relay, and responder obtain independent coordinator decisions bound to the exact 34-byte Noise opening.

The client spaces locally initiated exchanges for a peer by at least six seconds after acceptance. Each direction uses half the pair's 20-opens-per-minute allowance. Pacing uses the original pass deadline and never retries an uncertain operation. Large snapshots can still exceed the 60-second pass limit and restart on a later pass.

The client remembers closed session IDs until their WebSocket closes, so frames already forwarded before cancellation cannot interrupt unrelated exchanges. Active and remembered sessions share a 4,096-entry cap. At capacity, the client rejects new routes and replaces the socket after its last active route finishes. A later maintenance call or exchange reconnects.

The public entry point prevents concurrent passes for the same database handle and peer. `syncScopedChannelOnce` remains private and callers that use it directly must serialize the same peer and scope. These are in-process protections and do not coordinate separate processes.

Construct the relay client with existing in-memory key material, current-pin lookup, local validation, coordinator check, and an inbound handler. Construction performs no I/O. The caller must invoke `client.revalidate()` when local authorization or a learned switch or pin changes, and must call `await client.close()` for finite cleanup. The inbound handler receives `context.serve(...)`. Supply it with the private viewer sync dispatcher and `origin: logicalOrigin` so the shared channel and scope checks run on the authenticated Noise pin. The viewer dispatcher is an internal implementation detail, not a public package export.

`runSyncDaemon` accepts `reachability` in two forms for automatic fallback on its existing reconciliation tick. A per-peer resolver has `forPeer(db, peerDeviceId)`, which returns that peer's route for the tick or `undefined` for direct-only sync, and `clients()`, which lists the relay clients to keep registered. A single options object is the older form and applies one route to every peer. The daemon combines cancellation signals and gives each tick a fresh fallback budget. It ignores the one-shot absolute `deadlineMs`. With peers configured, it maintains every listed client concurrently, waits up to three seconds for that maintenance, then continues direct sync even if maintenance is unfinished. A registration lasts 900 seconds and the client renews it once less than 150 seconds remain. The daemon skips a scheduled tick while the previous one still runs, so it also maintains every client with a relay on a separate 60-second timer outside the tick runner. That timer keeps registrations alive through long ticks at any `sync_interval_s`, and it stops when the daemon is aborted. If the resolver throws, the affected peer syncs directly, and a failed client listing skips maintenance for that round. Shared registration has its own client-owned deadline, so one caller cancelling cannot terminate unrelated routes. No relay keepalive timer is added. The caller owns the supplied client and must close it during shutdown. Owners integrating another loop can call `client.maintainRegistration(signal, deadlineMs)` themselves.

## Device sync status

The Devices page reports sync between the device serving the viewer and each listed device. Availability, device ownership, and sync results are separate states. A successful exchange can transfer zero operations. Sent counts track unique operations acknowledged by the peer, which does not confirm remote import. Received counts track unique operations applied locally. Both counts cover the last 24 hours since tracking began, with snapshot entries counted separately. Hover over an underlined term for its definition, or focus or tap the term to open the tooltip.

**Last successful connection** shows Direct or Relay for the latest successful sync started from the viewer's device. Incoming connections are not included in connection history. Older attempts without recorded transport show **Not recorded**. Configured addresses do not determine the displayed connection type, and a failed attempt does not replace the last successful connection.

Select **View setup issues** to load the affected devices or Team invitations, recorded reasons, and required actions. Expand an issue's **Technical details** to see its error code and reference ID. Device names appear only when the reference matches one inventory entry.

Coordinator enrollment alone does not confirm device pairing or assign an Identity. Manual pairing requires access to both devices and acceptance of each device's pairing payload on the other device. The relay health probe also uses a coordinator enrollment. The device inventory currently lacks a service-role field, so a probe enrollment can appear in device setup. Do not pair or reassign a relay probe to clear a device setup warning.

## Device relay configuration

Core derives a device's relay settings from its configured coordinator, fetches and pins the advertised service key, and routes each peer through the right group's client. The viewer process that `codemem serve` runs, in the foreground or background, uses these pieces when sync is enabled, `sync_coordinator_url` and `sync_coordinator_groups` are set, and relay is not turned off. Relay works only against a coordinator whose operator has turned relay on. On a coordinator without relay, every group resolves as `disabled` and sync stays direct.

When those conditions hold, `createViewerRelayReachability()` from `@codemem/server` keeps one relay client per configured group whose info resolves `ready`. Each client uses the device key from the key directory, which defaults to `CODEMEM_KEYS_DIR` as it does for the sync daemon, and the device public key in `sync_device`. The device's key signs the info request too. It accepts a peer's key only while `sync_peers.public_key` still matches that peer's pinned fingerprint, and it stops admitting routes if the local device identity changes. Inbound relayed requests go through the same channel dispatcher and scope checks as other sync channels, with `RELAY_LOGICAL_ORIGIN` as the origin. `serve` resolves the groups when the sync daemon starts and again after every coordinator refresh, even one that fails. Each refresh rereads `sync_coordinator_groups`, so a group joined while the viewer runs gets a client and a group left has its client closed. Changing `sync_coordinator_url` needs a restart, and until then the viewer relays for no group and logs one warning. A refresh builds clients for newly ready groups, closes clients for groups that become paused or disabled, and revalidates the others. A failed info fetch keeps a running client while its key is still the stored pin. If the local device identity changed, the refresh closes every client and rebuilds them from the current key. A failure in one group leaves only that group on direct sync, and the viewer logs each group's state once per change. Disabled states log at info level until a group has relayed once, so a coordinator without relay does not warn at every start. A paused group, an invalid info reply, and a group that stops relaying after it worked log warnings. `sync_relay_enabled` is read when the viewer starts, so changing it needs a restart. Every build that knows the `relay` feature advertises `relay_aware`, and a viewer that runs a relay client also advertises `relay`. Direct sync stores each peer's advertised features in `sync_peers.sync_features_json`; relay fallback skips a peer whose stored features include `relay_aware` but not `relay`, for 24 hours after the observation. Without these conditions, `serve` builds nothing and passes no relay options to the daemon. The daemon then syncs exactly as before. Shutdown closes every relay client.

`codemem sync relay-keys` lists each pin with its state, pinned key, pending candidate, and last withdrawn candidate. `--json` prints the same fields. `codemem sync approve-relay-key <group> --key <candidate>` approves a pending change for the configured coordinator. The command shows both keys and changes nothing unless `--key` matches the pending candidate after canonicalization. Without `--key`, it asks for confirmation in an interactive terminal and approves only the candidate it showed. With `--json` or without a terminal, it requires `--key` and exits with status 2. Check a new key with the coordinator operator before approving it. A running viewer picks up the approval after its next coordinator refresh.

Two config keys control relay on a device:

| Key | Environment variable | Default | Effect |
| --- | --- | --- | --- |
| `sync_relay_enabled` | `CODEMEM_SYNC_RELAY_ENABLED` | `true` | Relay runs for a group whenever the coordinator advertises it. `false` turns relay off and skips every relay request. |
| `sync_relay_service_key` | `CODEMEM_SYNC_RELAY_SERVICE_KEY` | empty | An operator-supplied `ssh-ed25519` key. It wins over the advertised key and is pinned directly. An invalid value turns relay off. |

`readRelayClientSettings()` reads both keys. `resolveRelayGroup(db, ...)` from `@codemem/core/internal/relay-runtime` decides one coordinator group:

1. It returns `disabled` with `relay_opt_out` when relay is off, and makes no request.
2. Relay needs a `sync_coordinator_url` that starts with `https://` and has no path, query, fragment, or credentials. A missing scheme, `http://`, or a path returns `coordinator_url_unsupported`, because the relay authority ID hashes the URL and the coordinator serves relay from its root. A trailing slash is accepted and gives the same authority ID.
3. It sends a device-signed `GET /v1/relay/info?group_id=<group>` to the configured origin and does not follow redirects. The reply must name the requested group, carry a parseable Ed25519 key, give `relay_path` equal to `/v1/relay/<realmId>` computed locally from the authority and group, and give `admission_path` equal to `/v1/relay/admission-check`. A refusal, a network failure, or any mismatch returns `disabled` for that group only.
4. It compares the key with the local pin for that coordinator and group, stored in the `sync_relay_service_pins` table. The first key is pinned. The same key again changes nothing. A different key never replaces the pin: the table records it as a pending candidate, and the group returns `paused` with both keys until the user approves the candidate with `approveRelayServiceKey()`. The pause survives restarts. If the coordinator goes back to the pinned key, the pending candidate is dropped and recorded as `last_candidate_key` with its first-seen time, so the withdrawn change stays visible. An operator key replaces the pin and records a cleared candidate the same way. Approval canonicalizes the pasted key first, so a trailing comment or extra whitespace still matches.
5. A `ready` result carries the options for `createRelayPeerClient` and `createRelayCoordinatorClient`: the realm URL `wss://<host>/v1/relay/<realmId>`, built from the configured host and never from a redirect, the admission URL, the authority ID, and the relay audience ID bound to the pinned key.

`createRelayPeerReachability()` builds the daemon's per-peer resolver for one coordinator. For each peer it lists the active managed Spaces both devices share, where both keys have fresh cached authorization, in scope ID order, and keeps only the Spaces whose group has a client. It picks one Space per peer per tick and advances by one on the next tick, so a peer that shares several Spaces covers each in turn. The rotation state lives in memory and restarts from the first Space when the process restarts. A peer with no shared managed Space gets direct sync only. Relayed passes use `RELAY_LOGICAL_ORIGIN` as their synthetic origin, and the inbound dispatcher must use the same constant.

## Admission and quota state

`createRelayCoordinatorClient({ url })` requires an HTTPS admission URL ending in `/v1/relay/admission-check`. Supply the full external pathname, including any signed mount prefix. The client rejects userinfo, queries, fragments, redirects, retries, and decision readback. With an injected `fetcher`, such as a Workers service binding, it sends `redirect: "manual"`, because Workers throws a `TypeError` for `"error"`. Any non-200 reply, including a redirect, is a denial.

Pass the relay service public key as `servicePublicKey`, SSH `ssh-ed25519 <base64>` text, in the same admission options. The coordinator app then also serves `GET /v1/relay/info?group_id=<group>` to devices. The request uses the same device-signed authorization as `/v1/peers`. An enrolled, enabled device of a served group gets `200` with `{ group_id, service_public_key, relay_path, admission_path }`. `service_public_key` is the canonical SSH text without a comment, `relay_path` is `/v1/relay/<realmId>` for that group, and `admission_path` is the configured `externalPathname`. A missing `group_id` returns `400 group_id_required`. Every other refusal matches what `/v1/peers` returns: signature, enrollment, disabled, and revoked failures return the same status and error, and a group the relay does not serve returns the `401 unknown_device` that a non-member gets. Relay off, a missing or invalid `servicePublicKey`, or an empty or inconsistent namespace map serve no group, so every member gets that same `401`. The response body names only the requested group. Devices fetch and pin this key as described in [Device relay configuration](#device-relay-configuration).

`allowLoopbackHttp: true` permits HTTP only for disposable loopback fixtures at `127.0.0.1` or `[::1]`. Register the coordinator route with server-owned `namespaces`, `externalPathname`, and `ingressKey`. `namespaces` maps each served group ID to its namespace, and every entry must share one authority and relay audience. A single-group caller can pass `relayAdmissionNamespaces(namespace)`, exported from `@codemem/core`. It returns an empty map when two namespaces share a group ID. The route selects the entry by the group ID in the signed packet body. The device signature covers that body, so a caller cannot move a check into another group, and a group missing from the map is denied with no default. An empty or inconsistent map serves only denials. Registration does not create schemas, policy, readiness, or profiles.

On the Cloudflare coordinator, `POST /v1/admin/relay/admission` writes the policy, audience, realm, and budget allocation rows from the Worker's relay config and a fixed default profile. It is idempotent, only adds or raises rows, and never writes readiness. The operator sequence is: apply migrations, set the service key and health probe secrets, set the relay vars, deploy, call the admission route, which also arms the `RelayHealth` alarm, and provision each realm's quota with `POST /v1/admin/relay/quota`. Checks stay denied until the health object has published ready readiness rows, after five healthy minutes. The [deployment guide](cloudflare-coordinator-deployment.md#optional-relay-host-off-by-default) lists the profile and the trigger arithmetic.

Every request charges ingress budget before the proof is checked, including malformed packets, oversized bodies, and timeouts. When the packet names a served group, the route charges that group's bucket, the shared bucket for the authority and audience (group `''`), and the authority bucket, in order, stopping at the first denial. When the body does not decode, or names a group the route does not serve, it charges only the shared and authority buckets and writes no per-group bucket or nonce. Device budgets and nonces are written only after the proof verifies.

Anyone who knows a served group ID can drain that group's per-group ingress bucket with unsigned junk that claims the group, because the bucket is charged before authentication. This is an accepted risk. The shared buckets already let the same junk drain checks for every group, and a drained bucket only delays relay admission until it refills.

Use a relay-owned SQLite database for quota metadata only. It contains the root switch, allocations, and durable token buckets. Initialize it explicitly with `initializeRelayQuotaSchema(database)`. `createSqliteRelayQuota()` does not initialize, provision, retry, refund, read back, or use the application clock. Missing or uncertain quota state denies the request.

Existing quota databases require explicit initialization to install policy-change protection. Initialization atomically installs the protection and tightens stored bounds against current positive allocations. Reservations deny when that protection is absent. Policy tightening then persists even when a reservation is denied or another scope rolls back consumption.

Zero or missing allocations pause reservations without erasing the last positive bounds. Restoring an allocation cannot exceed those stored bounds. Initialization cannot reconstruct positive policy history that an older implementation already lost, so operators must validate existing allocations before activation.

`provisionLocalRelayQuota()` serves disposable fixtures and the Worker's operator quota route, which passes `relayQuotaShardProfile(realmCount)` and later lowers allotments with `tightenRelayQuota()`. It inserts one disabled root and zero allocations unless a fixture supplies a profile, and fails if a root already exists. Enable the stored switch with `setRelayQuotaEnabled()`, then construct the adapter with `enabled: true`. Existing buckets keep their lowest historical rate and capacity. Do not delete buckets to recover capacity because deletion resets consumption. The enabled adapter sets a zero busy timeout, so another connection's lock makes a reservation return `unknown`. A Durable Object's SQL API rejects that PRAGMA, so `createSqliteRelayQuota()` returns `unknown` for every reservation there. The Worker's Durable Object adapter instead uses an internal factory that skips the PRAGMA, which is safe only because the object has no other writer.

The relay charges traffic quota before it forwards DATA, and it never refunds unused credit. Each route direction's first reservation covers the queued bytes, with a 16 KiB minimum. Each later reservation covers the queued bytes and is at least double the previous grant, up to 256 KiB or the route's remaining 20 MiB byte budget. A small HTTP exchange therefore costs about 16 KiB per direction, and a sustained transfer reaches full-size grants after a few reservations. Size traffic allocations so every scope's burst holds at least one 256 KiB grant, plus headroom for the expected number of concurrent routes. When a traffic reservation is denied, uncertain, or times out, the relay aborts that route, and peers report only a generic exchange failure. The runtime's `counters().trafficQuotaAborts` field counts these aborts, so check it when relayed requests fail without other errors.

## Relay failure reasons

When a relay route fails, the source records one stable reason code locally. A failed `syncScopedChannelOnce` result sets `relayFailureReason` and appends the code to its generic error, for example `scoped channel exchange failed: relay_rejected`. Through `runSyncPass`, that error text is what `sync_attempts.error` stores. The transfer observation keeps its existing `exchange_failed` code.

The first failure in a pass decides the code. A CLOSE, a duplicate frame, or a second failed open that arrives later does not replace it, and none of them saves an ACK or moves a cursor. Relay control frames still carry no reason, so peers and the relay see only the existing generic REJECTED and CLOSE frames.

| Code | Meaning | Next action |
| --- | --- | --- |
| `relay_disabled` | The client is closed, its `enabled` switch is off, or `validateLocal()` returned false. | Check the operator switch and local identity, then call `client.revalidate()`. |
| `relay_peer_revoked` | The peer's current pin no longer matches the pin this pass started with. | Re-pin or re-approve the peer before the next pass. |
| `relay_unavailable` | The relay socket failed or closed, registration failed (including service proof and timeouts), or the client hit its own route, pacing, write, or wire-budget capacity. A second route to the same peer that waits three seconds for local capacity also ends here. | Check relay reachability, the service key pin, and the number of concurrent routes. |
| `relay_admission_failed` | The source's own coordinator check returned no valid approval. The client cannot tell a denial from an unreachable coordinator. | Check coordinator reachability, its admission logs, and budget allocations. |
| `relay_peer_unsupported` | Not a relay attempt, and not recorded as one: the pass result carries `relaySkipped` and the attempt row holds only the direct failure. The peer last advertised `relay_aware` without `relay` over direct sync, so it runs no relay client and the realm has no route for it. A peer without `relay_aware` predates the advertisement and is still tried. The observation expires after 24 hours, after which the rejection back-off applies, so a peer that turns relay on while unreachable is found within a day. The pass waits instead. | Upgrade the peer, or nothing. The next direct exchange refreshes the stored features. |
| `relay_backoff` | Not a relay attempt, recorded the same way. The peer sent REJECTED recently, so relay waits 2, 4, 8, 16, then 30 minutes between tries. Any relay success resets it. | Nothing. Confirm the peer is online and on relay if it persists. |
| `relay_rejected` | The relay sent REJECTED. This covers an offline or unregistered target, a relay or target admission denial, a target that rejected the route, and a relay route lifetime that ended before acceptance. The client cannot tell these apart. | Confirm the target is online and registered, then check relay and target admission. |
| `relay_aborted` | The relay sent CLOSE abort after acceptance. This covers a traffic quota abort, a route expiry at the relay, and a fault that made the target abort. | Check the relay's `counters().trafficQuotaAborts` and the target's own failure reason. |
| `relay_frame_invalid` | A cleartext relay frame failed to decode, arrived out of order, or exceeded a route buffer. This includes truncated DATA and unexpected controls. | Look for a proxy or relay modifying frames, and check version alignment. |
| `relay_handshake_failed` | The Noise handshake did not authenticate, for example because a handshake DATA frame was substituted. | Confirm both pins and look for frame tampering. |
| `relay_record_invalid` | An encrypted record failed after authentication, or the authenticated peer's HTTP response was malformed. Substituted, duplicated, and replayed records produce this code, as do a wrong HTTP version, a status outside 200 to 599, an oversized or mismatched body, trailers, and 1xx or upgrade responses. | Look for frame tampering or replay between the peers and the relay. For malformed HTTP, check the peer's codemem version. |
| `relay_expired` | The route lease, receive-idle timer, Noise handshake deadline, admission lifetime, or caller deadline ended, or the caller cancelled. A dropped OPEN usually ends here. | Check relay latency, and raise the pass deadline only if routes regularly run out of time. |

A failure seen at the target reaches the source as `relay_aborted`, because the target can only send CLOSE abort. A source-side pass that fails without a route failure, such as a scope authorization denial, keeps the generic error without a code.

## Temporary route decision capture

This diagnostic branch adds an optional `createRelayServer({ onDiagnostic })` callback. The callback receives only an event, a validated 32-character hexadecimal session ID, and an optional allowlisted reason. Callback failures do not change relay decisions. The normal wire protocol remains unchanged.

The Worker in this branch writes application events with `event: "codemem.relay.decision"`, `decision`, `route_id`, and an optional `reason`. Events cover opening, forwarding, acceptance, rejection, and closure. Forwarding and acceptance describe engine transitions. Use transfer receipts to verify completed sync. DATA frames do not produce individual events.

A `duplicate_session` event rejects the additional OPEN. The original route keeps its own lifecycle.

Rejection reasons distinguish admission-check failure, absent or invalid target registration, key mismatch, target rejection, duplicate or parallel routes, and capacity or quota limits. `admission_check_failed` includes denial, unavailable checks, and invalid replies because the existing check cannot distinguish them. An expired registration that has already been removed appears as absent.

The matching diagnostic viewer records `relay_route_failure side=<source|target> session=<id> reason=<code>` in private logs and local attempt history. These entries use an empty peer key and do not change individual peer health. Match their `session` to the Worker's `route_id`, then compare timestamps and existing HTTP-stage diagnostics.

The same failed exchange can produce both a per-peer attempt row and a route diagnostic row. Filter diagnostic prefixes when counting sync attempts.

Keep invocation logging disabled. These application events exclude device and group identifiers, addresses, headers, admission packets, keys, payloads, and raw exception messages. Deployment and runtime switches require separate approval. Use an approved relay-only test arrangement and confirm `transport=relay`; this branch does not force transport selection. Do not merge temporary capture code into main as part of the investigation.

## Relay health

Pass `relayHealth` factory options, including its namespace and probe identity, to a coordinator runtime. The SQLite coordinator runtime also takes a list with one entry per served group, all for one authority. Each group gets its own monitor and realm row, and the authority row carries the aggregate of every group, as on Workers, so one group's trip never denies the others. Each entry's `onMonitor` receives that group's monitor. When `enabled` is true, the runtime constructs a stopped `RelayHealthMonitor` and passes it to `onMonitor`. The owner controls `start()` and `stop()`. `stop()` returns false if storage has not confirmed the final pause. Use the independent relay switch when traffic must stop immediately.

An owner that schedules cycles itself, such as the Cloudflare Worker's `RelayHealth` Durable Object, calls `runScheduledCycle()` instead of `start()` and enforces the 30 second cadence. It saves `exportState()` after each change and restores it into a new monitor with `importState()`, which rejects a value without the exported shape. Pass `maxGapMs` to also reject state last updated longer ago than that, so a restart after a long gap starts tripped. An owner of several realms passes `authority` to `d1RelayHealthPublisher` with `aggregateRelayHealthAuthority()`, so each realm row keeps its own state and the authority row carries the combined value. Instrumentation that runs in another isolate uses `RelayHealthInstrumentation` and delivers its samples to `recordServerSample()`. A sink that throws or rejects is ignored, so health delivery never changes a coordinator response. The [deployment guide](cloudflare-coordinator-deployment.md#relay-health-on-workers) covers the Worker setup.

The monitor probes the normal v2 catalogue and synthetic-scope member endpoints with the configured low-privilege identity. A cycle makes two requests, each bounded to three seconds. Cycles run no more than twice per minute, so probes use at most four requests per minute. A verified clock stamp must include resolution in an error bound of five seconds or less.

The monitor starts tripped and needs five complete healthy windows before it publishes ready. Anonymous requests and expected rate-limit denials cannot trip its authenticated server cohorts. A failure pauses readiness while a minute has fewer than 20 samples. The completed window determines whether to trip or apply the high-volume thresholds. It aggregates durations and outcomes in memory, without request payloads. SQLite and D1 publishers atomically update existing readiness rows. They do not create tables, profiles, or positive quota budgets. Outside the Cloudflare admission route above, profile provisioning remains a local-fixture operation. Operators must separately approve positive profiles and the environment before activation.

Each trip records its reason: a bad window with its cohort, sample count, failures and slowest completion; an invalid or late sample; a failed publication; a failed probe cycle; or an explicit stop. The monitor snapshot carries the most recent trip as `lastTrip`, which survives a Durable Object restore, and the Cloudflare host writes each trip to Workers Logs as a `relay_health_tripped` warning with the group ID. Search that message in the Observability page to see why a group stopped admitting.

## Verify local composition

Run focused relay peer, reachability, health, scoped-channel, and relay integration tests, then type-check:

```fish
pnpm exec vitest run packages/core/src/relay-peer-client.test.ts packages/core/src/relay-failure-reason.test.ts packages/core/src/relay-fault-proxy.test.ts packages/core/src/sync-reachability-pass.test.ts packages/core/src/relay-health.test.ts packages/core/src/relay-health-probe.test.ts packages/core/src/relay-health-storage.test.ts packages/core/src/relay-health-runtime.test.ts packages/viewer-server/src/relay-sync.test.ts packages/viewer-server/src/sync-channel-pass.test.ts
pnpm run tsc
```

The tests exercise local WebSocket, Noise, HTTP, scoped authorization, admission, quota, selector fallback, cancellation, and SQLite/D1 readiness paths. Stop after local acceptance.

## Compare relay hosts end to end

`relay:acceptance` runs one device-level acceptance sequence, unchanged, against each relay host:

- `do`: the coordinator Worker bundle that `wrangler deploy` builds, in Miniflare with D1 and the `RelayRealm` and `RelayHealth` Durable Objects. Setup goes through the deployment guide's admin routes.
- `node-cohosted`: a self-hosted SQLite coordinator with each realm's Node relay on the coordinator's own HTTP server.
- `node-standalone`: the same coordinator with each realm's relay on its own listener, as a separate relay process behind the same hostname would run.

```fish
pnpm --filter @codemem/cloudflare-coordinator-worker relay:acceptance -- --host all
```

`--host` also takes a single host. Each host takes about 12 minutes, most of it the five healthy minutes before readiness turns ready. The run stays on loopback and uses no Cloudflare account. It generates a throwaway CA, a `127.0.0.1` certificate with the `openssl` on `PATH` (set `OPENSSL` to use another), and fresh device keys. A TLS front at `https://127.0.0.1:<port>` serves as the coordinator origin and passes each realm's relay upgrades through the keyless fault proxy. Evidence goes under `.tmp/relay-host-acceptance/`.

Three device processes take part. Device A belongs to two teams. Device B is in team A only, and device C is in team B only. Each runs the relay client that `codemem serve` builds. The stages run in this order:

1. Readiness: the authority row and both realm rows turn ready.
2. Direct sync works with relay available.
3. With B's direct listener down, a pass relays both pull and push, completes the outbound ACK, and leaves personal and local-only memories on A.
4. A pass for a Space B is not a member of is refused over relay and changes nothing on B.
5. C cannot register with team A's realm.
6. Team B relays through its own realm, and team A's realm sees none of its frames.
7. With B offline, the pass fails with `relay_rejected`, the cursor and ACK hold, and the realm holds no routes or queued bytes. Nothing reaches B when it reconnects until the next pass repairs it.
8. Faults injected at the proxy give the same local reasons on every host: a dropped handshake gives `relay_unavailable`, truncated DATA gives `relay_frame_invalid`, a REJECTED substituted for ACCEPTED gives `relay_rejected`, and an OPEN lost on its way to the target gives `relay_expired`. A clean pass then converges.
9. Neither realm records a traffic quota abort.
10. The host's operator switch for team A's realm stops relay, and direct sync still works.
