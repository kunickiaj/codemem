# Coordinator auth sign-in browser-transaction purge

**Status:** Validated core storage capability; no automatic or live cleanup is enabled.

## Purpose and boundary

This trusted, explicit maintenance method recovers sign-in browser-transaction capacity by deleting old sign-in rows.

It is not browser integration, a public route, a scheduled cleanup service, or an authorization mechanism.

It is inert until a trusted caller invokes it. There is no startup sweep, timer, route hook, polling loop, live cleanup action, admin override, or configuration-rotation reset.

The method is scoped to one trusted coordinator and does not cross coordinator boundaries.

## Explicit API

```ts
await store.purgeAuthSigninBrowserTransactions(
  { coordinatorId: "coord-a" },
  { limit: 256 },
);
// => { kind: "purged", processedCount: 0, more: false }
// or { kind: "rejected", error: "invalid_input" }
```

`limit` is an integer from 1 through 256 and defaults to 256. It caps deleted
transaction rows, not reads needed to find eligible rows. Raising the floor can
also insert or update one metadata row.

`processedCount` is deleted rows; `more` is `processedCount === limit`, so `more: true` can be a false positive.

Invalid scope or options return `invalid_input`. Persistence failures stay generic and do not expose their cause.

## Eligibility and retained records

The age cutoff at invocation is `now - 2 hours`.

The method can delete only supplied-coordinator rows that are `signin`, have no attempt, and have `created_at_ms <= cutoff`.

State does not matter: eligible `pending`, `consumed`, and `expired` sign-in rows are candidates. Expiry, consumption, and later account outcome do not create exceptions.

It never deletes `link` rows, link attempts, accounts, controllers, profiles, audits, sessions, session receipts, or other receipt records. Separate explicit guarded-session retention may delete a narrow class of old normal-sign-in sessions and receipts; it has no hook here.

It does not purge legacy sign-in data or change legacy receipt-burn behavior. The old permanent receipt-burn rule remains outside this scoped browser-transaction method.

Deletion is ordinary database deletion, not secure erasure from SQL pages, WAL, D1 Time Travel, backups, or replicas.

## Floor and deletion protocol

Migration `0023` adds an initially empty `coordinator_auth_signin_purge_floors` table keyed by coordinator.

`purged_through_created_at_ms` is a monotonic per-coordinator floor.

Stage A upserts the maximum *actual eligible* `created_at_ms`, not the cutoff. It writes nothing when no row is eligible or that maximum does not exceed the floor.

Stage B deletes only rows joined to that floor, still constrained by the age cutoff and `created_at_ms <= floor`.

The delete selects bounded primary keys ordered by `created_at_ms` and hash, then deletes through that subquery. This is portable to D1 and avoids `DELETE ... LIMIT`.

The two statements intentionally run sequentially. Safety does not depend on an atomic batch.

If Stage A commits and Stage B fails, nothing is deleted; later starts can only receive the conservative retention denial.

Concurrent rows created above the floor are skipped for a later explicit purge. Rollback cannot lower the floor, and a deleted transaction cannot revive under rollback.

## Admission effect and clock tradeoff

At each successful start, the existing one-hour quota count matches the count
that would have applied if no sign-in transaction rows had ever been purged.

The existing 4,096 retained-sign-in backstop remains the admission cap.

Only an explicit purge can regain sign-in backstop capacity. It does not recover the separate permanent 10,000 non-finished-link-attempt cap.

A successful sign-in start uses its guarded atomic insert only when the floor is at or below `now - 1 hour`.

Otherwise start rejects only as `clock_retention_blocked`; existing invalid, configuration, and conflict priorities stay unchanged.

Every deleted row was created at or below the floor. A successful start requires that floor at or below `now - 1 hour`, so a deleted row cannot count toward the strict `created_at_ms > now - 1 hour` quota window.

Read-only diagnosis never mints a transaction. Existing `consumeAuthBrowserTransaction` behavior does not check the floor.

Missing deleted rows make consume, cancel, and a new guarded sign-in deny rather than restoring authority.

A forward clock jump can purge actual future-born rows. Correcting the clock can then block starts until one hour after the floor—possibly years.

There is no automatic reset, recovery authorization, live activation, or admin bypass for that conservative clock-retention result.

## Replay and provider boundaries

State and binder reuse detection is retention-scoped; this capability does not claim a purged state or binder can never be inserted again.

Browser transaction hashes remain fresh 32-byte CSPRNG output and are not caller-nominated public JSON. Unissued-hash collisions are negligible in practice, not mathematically impossible.

Fresh-hash checks keep link attempts and legacy/link-created or historical
session receipts permanently, so a forced reuse of a purged-but-issued browser
hash remains denied while its guarded receipt/session remains. The separate
[guarded-session retention contract](coordinator-auth-session-retention.md)
defines the narrow approved exception after both eligible records are deleted.

The caller SDK must independently generate fresh state, nonce, and PKCE material;
the handler separately generates a fresh 32-byte browser binder. The store keeps
state/binder commitments and pending nonce/PKCE material, never raw browser
cookies. Consumption clears the persisted nonce/PKCE fields before SDK exchange.

The code-flow handler still requires fresh SDK-verified PKCE and nonce. It does not accept a front-channel ID token, and real Google provider liveness is not exercised here.

An old authorization code cannot be assumed provably single-use after two hours solely because its row was purged; fresh entropy and durable consumption guards remain required.

Profiles are display-only and are not a purge authority source.

## Readiness and validation limits

Fresh schema parity includes the new table, and migration `0023` starts empty.

SQLite, SQLite-backed D1, and local Worker D1 tests cover schema parity, purge
boundaries, capacity recovery, replay denial, rollback admission, partial faults,
and protected-record preservation. These tests do not exercise live Google,
remote D1, or browser navigation.

Public readiness gates remain: per-client rate limits, actual browser cookies, CSRF and Origin checks, session and receipt-growth cleanup, IPv4/IPv6 loopback navigation, real provider configuration, deployment approval, and real browser navigation.

This capability does not enable provider configuration, routes, cookies, sessions, account linking, enrollment, recovery, or Project access.
