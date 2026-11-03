# Relay runtime local guidance

The internal entry point, `@codemem/core/internal/relay-runtime`, supports local composition tests. It does not start a listener, select a production host, activate relay traffic, or deploy anything. The reviewed contracts remain authoritative: [relay operations](contracts/relay-operations.md) and [relay admission](contracts/relay-admission.md).

## Compose a local runtime

`createRelayWebSocketRuntime()` accepts upgrades only when all of the following are explicit:

- `enabled: true`
- positive `sockets`, `pendingSockets`, and `writeBytes` limits
- a `reserveUpgrade` callback that returns `"reserved"`

The defaults are disabled and zero. The runtime never calls `listen()`.

Pass `options.server` to co-host upgrades on an existing Node HTTP(S) server. The application that owns that server also owns its header limits, connection limits, request handling, and shared listener lifecycle. `await runtime.close()` removes relay handling and waits for relay sockets and pending upgrades to close. It does not close the co-hosted application's listener.

Without `options.server`, the runtime creates a local Node server for tests. The caller must choose and start its listener. This does not approve Node as a hosted relay choice.

Call `runtime.disable()` to reject new upgrades and close existing relay sockets. Call `await runtime.close()` when the caller needs physical closure to finish before continuing.

Expired registrations do not consume pre-authentication slots. The adapter enables TCP keepalive after an upgrade attempt starts so dead connections can eventually release physical slots without application pings. Detection time depends on the operating system.

The relay signer is supplied through `RelayServerOptions.signer`. The caller owns service-key storage and rotation. Do not expose unused keys, configuration keys, peer addresses, packets, payloads, or raw configuration in logs.

## Connect the coordinator

`createRelayCoordinatorClient({ url })` requires an HTTPS admission URL that ends in `/v1/relay/admission-check`. Supply the full external pathname, including any signed mount prefix. The client rejects userinfo, queries, fragments, and redirects. It does not retry or read back a decision.

`allowLoopbackHttp: true` permits HTTP only for disposable loopback fixtures at `127.0.0.1` or `[::1]`. Do not use it for a remote or deployed coordinator.

Register the coordinator route with server-owned `namespace`, `externalPathname`, and `ingressKey`. Without these options, the coordinator does not register the route. It does not create schemas, policy, readiness, or profiles.

## Keep relay quota state separate

Use a relay-owned SQLite database for quota metadata only. Its schema contains the root switch, allocations, and durable token buckets. It contains no payload, session, packet, or key tables.

Initialize it explicitly with `initializeRelayQuotaSchema(database)`. `createSqliteRelayQuota()` does not initialize, provision, retry, refund, read back, or use the application clock. Missing or uncertain quota state denies the request.

`provisionLocalRelayQuota()` is for disposable tests only. It inserts one disabled root and zero allocations unless a test fixture supplies a profile. It fails if a root already exists. It is not a production initializer.

Enable the stored switch explicitly with `setRelayQuotaEnabled()`, then construct the adapter with `enabled: true`. Every reservation intersects service, realm, device, and pair allocations that apply. Recreating an adapter, restarting the process, or attempting to reprovision cannot reset durable counters.

Existing buckets retain their lowest historical rate and capacity. Raising an allocation does not raise those buckets. Do not delete buckets to recover capacity, because deletion resets consumption. The enabled adapter sets the relay database's busy timeout to zero so a lock denies a reservation instead of blocking the event loop. Keep this database separate from coordinator storage and other writers.

A stored switch is read at each reservation boundary. A switch change takes effect before a later reservation, but it does not interrupt a callback that is already between reservations. Use `runtime.disable()` when the caller must stop new and existing sockets. Do not claim immediate revocation from a SQLite switch alone.

## Verify local composition

Run the focused tests for the WebSocket listener, HTTPS client boundary, SQLite quotas, coordinator route, and composed HTTP/WebSocket flow:

```fish
pnpm exec vitest run packages/core/src/relay-websocket-runtime.test.ts packages/core/src/relay-coordinator-client.test.ts packages/core/src/relay-quota-sqlite.test.ts packages/core/src/coordinator-relay-admission-route.test.ts packages/core/src/relay-runtime.integration.test.ts
pnpm run tsc
```

These tests use actual local HTTP and WebSocket connections with test readiness and concrete SQLite-backed decisions. They verify local composition only. Finished relay-client integration, scoped-sync integration, and default transport selection are still absent.

## Current gaps and gates

The health controller, health probes, and current-profile provisioning are not implemented. They are current gaps, not automatic configuration steps in this runtime. There is no public CLI, activation flow, deployment flow, device rollout, public STUN authorization, or approved hosted capacity plan.

Hosted capacity, TLS deployment, native and operating-system buffer limits, clock evidence, and user approval remain future dogfooding and activation work. WebRTC remains paused.

Stop after local verification. This runtime performs no automatic deployment or activation.
