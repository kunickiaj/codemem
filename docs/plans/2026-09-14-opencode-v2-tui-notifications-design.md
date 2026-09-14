# OpenCode 2 TUI notification parity design

## Decision

Codemem will restore OpenCode 2 notification parity with a package `./tui` companion backed by a location-scoped RPC bridge.

The server plugin will register a small notification RPC contract before it creates the shared runtime. Runtime notices will enter a bounded in-memory queue and emit a live RPC event. The TUI companion will subscribe first, fetch the queued notices, deduplicate both paths by notice ID, and render each notice with `context.ui.toast.show`.

OpenCode 1 will keep its existing direct `client.tui.showToast` path. Capture, recall, startup, and cleanup will not fail when RPC registration, publication, subscription, replay, or toast rendering fails.

## Alternatives

An event-only RPC bridge is smaller, but OpenCode RPC subscriptions are live-only and would lose compatibility and update notices emitted before the TUI subscribes.

Polling server plugin storage would survive process restarts, but it would add latency, writes, cleanup, and cross-restart notification semantics that OpenCode 1 does not provide. Calling a TUI endpoint directly from the server plugin would avoid a companion, but OpenCode 2 intentionally exposes toast rendering only to CLI plugins.

## Contract and data flow

The public RPC contract will expose a `list` method and a `notice` event. Each notice contains a process-unique ID, message, and OpenCode toast variant. The broker will retain only the newest notices and return a snapshot from `list`; notices are advisory and never written to Codemem's database or spool.

The TUI companion will register the live listener before calling `list`. A bounded ID set will suppress a notice observed through both replay and the live event. The server location attached by OpenCode will keep package instances isolated across projects and worktrees.

## Failure and lifecycle behavior

RPC setup failure will leave the runtime active with notifications disabled. Publication will resolve after the broker accepts the notice, not after a terminal renders it. TUI setup will tolerate a missing or older server plugin, and individual toast failures will not stop later notices.

Server cleanup will deactivate publication and dispose the RPC registration with the other OpenCode 2 registrations. TUI cleanup will unsubscribe from live events. Both queues and deduplication sets will have fixed limits.

## Implementation plan

1. Add the RPC contract and bounded notification broker with focused tests.
2. Register the broker in the OpenCode 2 adapter and pass its publisher through the existing runtime host boundary.
3. Add and export the TUI companion, including replay, live subscription, deduplication, variant mapping, and fail-open tests.
4. Extend packed artifact and OpenCode 2 host coverage to prove the installed `./tui` entrypoint loads and displays a bridged notice.
5. Update the README and plugin reference, then run the TypeScript, lint, unit, and packed V1/V2 gates.

## Validation

Unit tests will cover queue bounds, subscription-before-replay ordering, duplicate suppression, variant preservation, unavailable RPC, failed publication, and failed toast rendering. Adapter tests will prove runtime notification publication and RPC cleanup are fail-open.

Packed tests will inspect the tarball exports and files. The OpenCode 2 host smoke will use the pinned supported host to load both package targets and observe a deterministic test notice without bypassing package resolution. Existing OpenCode 1 smoke coverage will guard the legacy direct-notification path.
