# Relay runtime local guidance

The internal entry point, `@codemem/core/internal/relay-runtime`, now exports the WebSocket runtime and quota types alongside `createRelayPeerClient`, `RelayHealthMonitor`, and their types. It supports local, programmatic composition. There is no public CLI, feature activation, deployment flow, or RTC transport.

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

Pass the same `reachability` settings to `runSyncDaemon` for automatic fallback on its existing reconciliation tick. The daemon combines cancellation signals and gives each tick a fresh fallback budget. It ignores the one-shot absolute `deadlineMs`. With peers configured, it waits up to three seconds for registration maintenance, then continues direct sync even if maintenance is unfinished. Shared registration has its own client-owned deadline, so one caller cancelling cannot terminate unrelated routes. No relay keepalive timer is added. The caller owns the supplied client and must close it during shutdown. Owners integrating another loop can call `client.maintainRegistration(signal, deadlineMs)` themselves.

## Admission and quota state

`createRelayCoordinatorClient({ url })` requires an HTTPS admission URL ending in `/v1/relay/admission-check`. Supply the full external pathname, including any signed mount prefix. The client rejects userinfo, queries, fragments, redirects, retries, and decision readback.

`allowLoopbackHttp: true` permits HTTP only for disposable loopback fixtures at `127.0.0.1` or `[::1]`. Register the coordinator route with server-owned `namespace`, `externalPathname`, and `ingressKey`. Registration does not create schemas, policy, readiness, or profiles.

Use a relay-owned SQLite database for quota metadata only. It contains the root switch, allocations, and durable token buckets. Initialize it explicitly with `initializeRelayQuotaSchema(database)`. `createSqliteRelayQuota()` does not initialize, provision, retry, refund, read back, or use the application clock. Missing or uncertain quota state denies the request.

Existing quota databases require explicit initialization to install policy-change protection. Initialization atomically installs the protection and tightens stored bounds against current positive allocations. Reservations deny when that protection is absent. Policy tightening then persists even when a reservation is denied or another scope rolls back consumption.

Zero or missing allocations pause reservations without erasing the last positive bounds. Restoring an allocation cannot exceed those stored bounds. Initialization cannot reconstruct positive policy history that an older implementation already lost, so operators must validate existing allocations before activation.

`provisionLocalRelayQuota()` is for disposable fixtures. It inserts one disabled root and zero allocations unless a fixture supplies a profile, and fails if a root already exists. Enable the stored switch with `setRelayQuotaEnabled()`, then construct the adapter with `enabled: true`. Existing buckets keep their lowest historical rate and capacity. Do not delete buckets to recover capacity because deletion resets consumption. The enabled adapter sets a zero busy timeout, so another connection's lock makes a reservation return `unknown`. A Durable Object's SQL API rejects that PRAGMA, so `createSqliteRelayQuota()` returns `unknown` for every reservation there. The Worker's Durable Object adapter instead uses an internal factory that skips the PRAGMA, which is safe only because the object has no other writer.

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
| `relay_rejected` | The relay sent REJECTED. This covers an offline or unregistered target, a relay or target admission denial, a target that rejected the route, and a relay route lifetime that ended before acceptance. The client cannot tell these apart. | Confirm the target is online and registered, then check relay and target admission. |
| `relay_aborted` | The relay sent CLOSE abort after acceptance. This covers a traffic quota abort, a route expiry at the relay, and a fault that made the target abort. | Check the relay's `counters().trafficQuotaAborts` and the target's own failure reason. |
| `relay_frame_invalid` | A cleartext relay frame failed to decode, arrived out of order, or exceeded a route buffer. This includes truncated DATA and unexpected controls. | Look for a proxy or relay modifying frames, and check version alignment. |
| `relay_handshake_failed` | The Noise handshake did not authenticate, for example because a handshake DATA frame was substituted. | Confirm both pins and look for frame tampering. |
| `relay_record_invalid` | An encrypted record failed after authentication, or the authenticated peer's HTTP response was malformed. Substituted, duplicated, and replayed records produce this code, as do a wrong HTTP version, a status outside 200 to 599, an oversized or mismatched body, trailers, and 1xx or upgrade responses. | Look for frame tampering or replay between the peers and the relay. For malformed HTTP, check the peer's codemem version. |
| `relay_expired` | The route lease, receive-idle timer, Noise handshake deadline, admission lifetime, or caller deadline ended, or the caller cancelled. A dropped OPEN usually ends here. | Check relay latency, and raise the pass deadline only if routes regularly run out of time. |

A failure seen at the target reaches the source as `relay_aborted`, because the target can only send CLOSE abort. A source-side pass that fails without a route failure, such as a scope authorization denial, keeps the generic error without a code.

## Relay health

Pass `relayHealth` factory options, including its namespace and probe identity, to a coordinator runtime. When `enabled` is true, the runtime constructs a stopped `RelayHealthMonitor` and passes it to `onMonitor`. The owner controls `start()` and `stop()`. `stop()` returns false if storage has not confirmed the final pause. Use the independent relay switch when traffic must stop immediately.

The monitor probes the normal v2 catalogue and synthetic-scope member endpoints with the configured low-privilege identity. A cycle makes two requests, each bounded to three seconds. Cycles run no more than twice per minute, so probes use at most four requests per minute. A verified clock stamp must include resolution in an error bound of five seconds or less.

The monitor starts tripped and needs five complete healthy windows before it publishes ready. Anonymous requests and expected rate-limit denials cannot trip its authenticated server cohorts. A failure pauses readiness while a minute has fewer than 20 samples. The completed window determines whether to trip or apply the high-volume thresholds. It aggregates durations and outcomes in memory, without request payloads. SQLite and D1 publishers atomically update existing readiness rows. They do not create tables, profiles, or positive quota budgets. Profile provisioning remains a local-fixture operation. Operators must separately approve positive profiles and the environment before activation.

## Verify local composition

Run focused relay peer, reachability, health, scoped-channel, and relay integration tests, then type-check:

```fish
pnpm exec vitest run packages/core/src/relay-peer-client.test.ts packages/core/src/relay-failure-reason.test.ts packages/core/src/relay-fault-proxy.test.ts packages/core/src/sync-reachability-pass.test.ts packages/core/src/relay-health.test.ts packages/core/src/relay-health-probe.test.ts packages/core/src/relay-health-storage.test.ts packages/core/src/relay-health-runtime.test.ts packages/viewer-server/src/relay-sync.test.ts packages/viewer-server/src/sync-channel-pass.test.ts
pnpm run tsc
```

The tests exercise local WebSocket, Noise, HTTP, scoped authorization, admission, quota, selector fallback, cancellation, and SQLite/D1 readiness paths. Stop after local acceptance.
