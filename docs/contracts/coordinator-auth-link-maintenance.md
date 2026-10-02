# Coordinator auth link-attempt maintenance candidate

**Status:** Reviewed storage safeguards; browser integration remains disabled. It enables
no runtime behavior, route, timer, startup job, or status-poll work.

## Purpose and boundary

This optional coordinator-auth work maintains persisted, unfinished link-attempt
rows after their authorization window expires. It is not data deletion or a
retention/compaction policy. Authorization has a ten-minute TTL; durable burn
markers and proof commitments have different storage lifetimes.

Attempt rows preserve their primary key and runtime, browser, and completion
proof hashes. Do not delete or compact stale rows: a stale authorization URL or
reused hash could otherwise gain authority later. Finalized and
`session_redeemed` attempts, links, link audits, session receipts, sessions, and
controllers are untouched.

This candidate does not create or delete actors, reassign root actors or Project
grants, create controllers, handle Google tokens, add routes, operate on a
production database, or deploy.

## Explicit API

```ts
maintainAuthLinkAttempts(
  cfg: CoordinatorAuthLinkConfig,
  options?: { limit?: number },
)
// => { kind: "maintained", processedCount: 0, more: false }
```

`limit` is an integer from 1 through 32; the default is 32. The result uses
`more: processedCount === limit`, so `true` can be a false positive. Callers
must explicitly invoke this API; it must not run automatically from startup, a
timer, or status polling.

The configuration is trusted loaded server configuration. It must be enabled
and name the coordinator whose rows are considered. Maintenance may process a
row owned by that coordinator even when its stored issuer or revision is old.

## State transition and privacy

An active unfinished row with `link_id IS NULL` and an expired deadline becomes
persisted terminal `expired`; its `account_subject` becomes `NULL`. `failed` and
already-expired rows with a non-null subject are scrubbed to `NULL`, preserving
their failed reason, timestamps, hashes, and metadata.

Terminal `expired` and `failed` rows never reopen, including after a clock
rollback. An expiry that had not been observed before trusted wall-clock
rollback can remain unswept; this candidate has no high-water clock floor.

## Creation ceilings

The following conservative engineering defaults apply only while creating link
attempts. They are enforced inside the authoritative `INSERT ... SELECT`, never
by a preflight count:

| Ceiling | Default |
| --- | ---: |
| Active attempts per coordinator/group/device | 2 |
| Active attempts per coordinator/Identity | 3 |
| New attempts per device per hour | 6 |
| New attempts per device per 30 days | 60 |
| Retained non-finished rows per coordinator, including terminal `expired` and `failed` | 10,000 |

Window queries use strict `created_at_ms > cutoff`. A rollback therefore counts
more history, failing closed; the current trusted `authClock` also fails closed
when invalid or overflowing. The group/device ceiling does not use fingerprint,
so rekeying does not reset it.

```ts
// Trusted server configuration; no raw account value is present.
createAuthLinkAttempt(input, {
  coordinatorId: "coord-a",
  issuer: "https://accounts.example.test",
  revision: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  enabled: true,
});
// A new over-limit request => { kind: "rejected", error: "attempt_limited" }
```

`attempt_limited` still permits an existing exact retry, without extending its
TTL. A stale controller takes priority and denies rather than returning that
retry. Finished link rows do not count. The operator ceiling stops new linking,
not normal verified-account sign-in, current sessions, device sync, or
completion of an already in-flight attempt.

Terminal `expired` and `failed` rows count toward this ceiling and are never
removed by maintenance. Because compaction is deferred, reaching it disables
new linking until future reviewed compaction exists. `attempt_limited` does not
identify which ceiling was hit; sweeping alone cannot restore capacity.

## Storage shape

Candidate migration `0019` adds these indexes:

- `idx_auth_link_attempts_device_created` on `(coordinator_id, group_id, device_id, created_at_ms)`;
- `idx_auth_link_attempts_identity_expiry` on `(coordinator_id, identity_id, expires_at_ms)`;
- `idx_auth_link_attempts_state_expiry` on `(coordinator_id, state, expires_at_ms)`.

Definitions must be identical in fresh Worker `schema.sql` and `AUTH_LINK_SCHEMA_SQL`;
existing DDL columns remain unchanged and historical worker migration `0017`
remains untouched.

## Integration and deferred work

Future browser handlers run maintenance before create and browser mutation, never
from status polling. Route-level sign-in/session-growth braking, typed ephemeral
OIDC state/nonce/PKCE cleanup, and avatar projection remain separate gate work.
Proof labels in general APIs and cryptographic proof labels are not trusted;
configured-admin authentication and cryptographic verification remain handler work.

Capacity compaction, recovery workflows, and manual live-cleanup actions are
deferred. The defaults are not pricing, network-throughput, or storage-size
claims; no such measurements have been made.

## Expected validation

Local SQLite-backed parity tests cover races, ceiling boundaries, proof burns,
terminal-state behavior, and privacy scrubbing. Local Worker D1 tests exercise
the same storage rules without remote deployment. They do not prove the future
OIDC, cookie, signature, or CSRF integrations.
