# Coordinator auth guarded sign-in session retention

**Status:** Validated explicit storage cleanup capability; browser handlers remain disabled.

## Purpose and boundary

Two trusted, explicit calls delete only old, eligible normal-sign-in session
metadata. They are not handlers, authorization, logout, revoke, startup, timer,
polling, scheduler, or live cleanup.

```ts
await store.purgeAuthGuardedSigninSessions({ coordinatorId: "coord-a" });
// => { kind: "purged", processedCount: 0, more: false }

await store.purgeAuthGuardedSigninReceipts({ coordinatorId: "coord-a" }, { limit: 256 });
// => { kind: "purged", processedCount: 0, more: false }
// Either call can instead return { kind: "rejected", error: "invalid_input" }.
```

`scope` comes from trusted coordinator configuration, not HTTP JSON. The calls
are independent and may run in either order. A caller must invoke them often
enough to keep up; 256 rows per call is not a storage cap.

No browser caller can nominate a browser-transaction hash or credential hash.
Future public handlers must atomically start a new browser transaction and issue
a new guarded normal-sign-in session; they must not use legacy helpers.

## API and failure behavior

Both accept `options.limit` from 1 through 256, defaulting to 256.
`processedCount` is deleted rows, not reads; `more` is `processedCount === limit`
and can be a false positive. Scope/options and existing clock validation run
before SQL. Invalid input returns `invalid_input`; database failure throws generic
`auth_session_persistence_error`, without a backend cause.

Each call makes one bounded `DELETE`, with no cross-call transaction, scheduling
order, secure erasure, WAL/backup cleanup, or D1 Time Travel cleanup.

## Receipt eligibility

Migration `0024` appends this receipt column:

```sql
purge_eligible INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(purge_eligible) = 'integer'
    AND purge_eligible IN (0, 1)
    AND (purge_eligible = 0 OR (source = 'signin' AND attempt_id IS NULL)))
```

Only a newly issued session from `signInWithConsumedBrowserTransaction` writes
`purge_eligible = 1`. New rows from the trusted legacy
`signInWithAuthAccount` helper, link redemption, and every historical row write
or retain `0`. There is no eligibility backfill.

The exact-once D1 versioned `ALTER TABLE` leaves migrations 0018 and 0022
untouched; fresh shared and Worker schemas mirror it and add expiry/eligible-age
indexes. SQLite checks `PRAGMA table_info` and adds a missing default-0 column
inside an immediate transaction before those indexes. The write lock serializes
competing upgrades without changing keys or ownership.

## Session deletion

`purgeAuthGuardedSigninSessions` deletes at most 256 sessions per call. A row is
eligible only when all of these are true:

- `expires_at_ms <= now - 24 hours`;
- its receipt matches coordinator, session ID, browser hash, link ID, revision,
  creation time, normal-sign-in/no-attempt source, and flag `1`; and
- no browser transaction has that coordinator/browser hash.

Revocation does not change this age rule: eligible revoked and unrevoked sessions
can both be deleted. A legacy, link-created, historical, orphaned, or mismatched
row cannot qualify.

## Receipt deletion

`purgeAuthGuardedSigninReceipts` deletes at most 256 receipts per call. A row is
eligible only when it has flag `1`, normal-sign-in source/no attempt, and
`created_at_ms <= now - 32 hours`.

It also requires no browser transaction with the coordinator/browser hash, and
no session with its coordinator/session ID or coordinator/browser hash. These
predicates permit either call order; a receipt remains until prerequisites are gone.
Each separate explicit delete is atomic. S3 transaction purge leaves an issued
transaction's receipt/session alone; S3 has no hook into this work.

## Compatibility and replay boundary

While a guarded receipt/session exists, its browser-hash burn behavior is unchanged.
After both are deleted, the store cannot prevent a trusted legacy caller from
nominating the former hash and succeeding as with a fresh hash. This approved
compatibility boundary is not a caller recipe: callers must still use fresh
values, as required by the [admission contract](coordinator-auth-session-admission.md).

That is not public replay: HTTP callers never nominate hashes; transactions and
32-byte credentials require fresh CSPRNG output; and old cookies cannot look up a
deleted row. Collisions remain mathematically possible, so no permanent burn is
claimed after deletion. Legacy-created, link-created, and historical flag-0 rows
keep permanent browser-hash/credential uniqueness; their methods and SQL defaults
stay unchanged.

## Capacity, clock, and profile effects

Rollback cannot reserve a deleted session slot; future-born reservation still
applies to retained current-configuration sessions. Guarded admission enforces
the ten-session budget against those retained rows, though historical counts
can differ. The trusted legacy sign-in helper remains uncapped; this is not a
global ten-session guarantee across both methods.

S3's one-hour floor still protects 1,024 transactions/hour; S4 adds no floor.
Existing clock trust still allows an expired unswept retained session to appear
live after rollback. A forward clock jump can make cleanup delete a still-live
guarded session early, signing that browser out rather than extending access.
A deleted session cannot revive except through collision or trusted internal
nomination after cleanup; no clock restore/manual DB action is added.

Profiles may retain dangling display-only `sourceSessionId`; reads require the
current live session/configuration, with no new authority or auto-erasure. At
1,024 guarded sign-ins/hour, 32 hours is roughly 33,000 records—not a hard cap;
legacy/link metadata still grows permanently.

## Readiness limits

This does not enable routes, recovery, provider setup, deployment, or a public
cleanup endpoint; front-channel ID-token policy, OIDC/JWS, cookie binding,
CSRF/Origin, IPv4/IPv6 loopback, direct sync, and runtime/provider prerequisites
remain unchanged. Local tests do not validate live Google, remote D1, or browser
navigation.
