# ADR 0006: Self-hosted Node is the first supported relay host

**Date:** 2026-11-04  
**Status:** Accepted

## Context

The [relay operations contract](../contracts/relay-operations.md) named
Cloudflare Durable Objects as the recommended relay host and a self-hosted Node
host as a fallback that needed review. The implemented relay runtime is Node:
`createRelayWebSocketRuntime()` with SQLite-backed quota state, co-hosted on an
existing Node HTTP(S) server or run on its own listener. The native coordinator
(`codemem coordinator serve`) also runs on Node with SQLite.

The Node runtime has local contract tests, a three-process local acceptance run,
and a hosted cross-network trial on one Linux VM. In that trial, coordinator and
relay shared one HTTPS listener and a separate peer process ran on the same VM.
The trial passed direct sync, relay fallback, scope isolation, offline drop
without queuing, repair after reconnect, relay disablement, and direct-only sync
after the relay was killed. The Cloudflare coordinator Worker has no relay
implementation.

## Decision

- The self-hosted Node relay is the first supported relay host. It runs
  co-hosted with the Node coordinator or as a standalone relay process.
- A Cloudflare Durable Object relay host is a separate, later track. It needs its
  own approval, implementation, and the hibernation, lease-restoration, and
  isolation evidence that the contract describes.
- The isolation rules in the contract still apply to the Node host. The relay
  keeps its own routes, configuration, health, switch, service identity, and
  quota storage. It has no coordinator database credentials and reaches
  enrollment state only through the admission-check API. The peer protocol must
  not require co-location.

## Consequences

- Co-hosting (`codemem-zjvr.2.6`), the compatibility gate (`codemem-zjvr.2.8`),
  and operator guidance (`codemem-zjvr.2.11`) target the Node host.
- Deployments that use only the Cloudflare coordinator Worker have no relay
  until a Durable Object host exists. Those peers keep using direct sync.
- When one Node process co-hosts coordinator and relay, they share CPU, memory,
  and file descriptors. Operators size the host and relay quotas for both, and
  the relay switch must stop relay work without affecting membership or
  discovery.
