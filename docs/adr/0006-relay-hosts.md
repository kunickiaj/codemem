# ADR 0006: Relay hosts: a Durable Object in the coordinator Worker, with a Node reference host

**Date:** 2026-11-04  
**Status:** Accepted

## Context

The [relay operations contract](../contracts/relay-operations.md) recommended
Cloudflare Durable Objects as the relay host and treated a self-hosted Node host
as a fallback that needed review.

The relay is built as a core that does not depend on its host, plus thin Node
adapters. The peer client, protocol codecs, admission decision, Noise channel,
and relay state machine (`relay-server.ts`) do not need Node. The Node-specific
parts are the WebSocket runtime (`relay-websocket-runtime.ts`) and the SQLite
quota store. The D1 coordinator runtime already accepts relay admission and
relay health options, and a D1 readiness publisher exists. The Cloudflare
coordinator Worker does not wire them in yet.

The Node host has local contract tests, a three-process local acceptance run,
and a hosted cross-network trial. In that trial, coordinator and relay shared
one HTTPS listener on a Linux VM. It passed direct sync, relay fallback, scope
isolation, offline drop without queuing, repair after reconnect, relay
disablement, and direct-only sync after the relay was killed.

The production coordinator runs on Cloudflare. Operators should not need a
separate server or a second endpoint for the relay.

## Decision

- The primary relay host is a Durable Object class in the coordinator Worker.
  The coordinator and relay deploy together from one Worker configuration.
- Peers reach the relay at `/v1/relay/<realmId>` on the coordinator's host.
  Each realm (authority and group) has one relay Durable Object, so both peers
  of a route reach the same object. The Worker's fetch handler passes a
  WebSocket upgrade on that path to the realm's Durable Object and does no other
  relay work. It returns 404 for realms the coordinator does not serve. All
  other paths stay with the coordinator.
- Relay processing must not block coordinator requests. After the upgrade,
  frames go between peers and the Durable Object, not through the coordinator's
  request handling. The relay uses the WebSocket Hibernation API, so idle
  connections keep no object resident.
- The relay keeps its own Durable Object namespace and storage for routes,
  quotas, replay state, health, and switch policy. It does not use the
  coordinator's D1 binding. It reaches enrollment state only through the
  admission-check route, which runs under the existing coordinator admission
  budgets.
- The self-hosted Node relay stays supported for self-hosted coordinators,
  local development, and as the reference implementation that the Durable
  Object host is tested against.
- The peer protocol must not depend on the host. The same peer contract suite
  runs against both hosts.

## Consequences

- Co-hosting (`codemem-zjvr.2.6`), the compatibility gate (`codemem-zjvr.2.8`),
  and operator guidance (`codemem-zjvr.2.11`) target the Cloudflare deployment
  first.
- The Durable Object host needs the hibernation, lease-restoration, and
  fail-closed rules in the contract, and Durable Object storage for quota state.
  It also needs scheduling for the relay health monitor, which runs on a timer
  on Node.
- The coordinator and relay share account-level Cloudflare limits and one
  deploy. A load test must show that relay traffic does not slow membership or
  discovery, and the relay switch must stop relay work without affecting them.
- Peers can derive the relay URL from the coordinator URL and realm, so adding the relay
  needs no new hostname.
