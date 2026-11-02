# Durable admission budgets

These private definitions and statements reserve admission-check capacity in one
shared authoritative database per coordinator authority. Tests install them only
in disposable SQLite and local D1. They install no startup schema, provide no
positive production allocation, and change no existing endpoint limiter.

`ADMISSION_BUDGET_ALLOCATION_SCHEMA_STATEMENTS` exports the allocation definitions
separately. `ADMISSION_BUDGET_SCHEMA_STATEMENTS` orders those definitions before
the bucket definitions. Both lists are frozen and install nothing automatically.

## Allocation keys

`admission_budget_allocations` has primary key
`(authority_id, pool, audience_id, group_id)` and integer `rate_per_min` and
`burst` columns, both defaulting to zero. A disabled allocation has both values
zero. An enabled allocation has both positive.

| Pool | Audience | Group | Parent and limits |
| --- | --- | --- | --- |
| `authority` | Empty | Empty | Validated total capacity, default zero. |
| `relay-route` | Relay audience ID | Empty or realm group | Pool rows share the authority total. Realm rows share their pool. |
| `relay-registration` | Relay audience ID | Empty or realm group | Separate registration capacity that routes cannot borrow. |
| `traversal` | Empty | Empty or realm group | Separate traversal capacity under the same authority total. |
| `device` | Empty | Empty | Policy ceiling of 96 checks/minute, burst 16. |
| `device-registration` | Empty | Empty | Policy ceiling of 2 checks/minute, burst 2. |

Pool rates and bursts sum to no more than the authority allocation. Realm rates
and bursts sum to no more than their pool allocation. Device policy rows are
independent ceilings and do not participate in these sums. Their authority must
exist. A parent cannot shrink below its children. Allocation keys are immutable,
collisions abort, and allocation deletion is prohibited.

Authority and audience IDs use 64 lowercase hexadecimal characters. A nonempty
group occupies 1–128 UTF-8 bytes without NUL. The statement builder also applies
the coordinator group syntax. These are storage constraints, not authorization.

## Persistent buckets

`admission_budget_buckets` adds `device_id` to the allocation key. Device and
device-registration buckets use the actual realm group and verified device ID,
but read their policy from the corresponding empty-group allocation. Other
buckets have an empty device ID and use their exact allocation key.

The remaining columns are `units`, `refilled_at_ms`, `last_rate`,
`last_capacity`, `exec_id`, and `granted`. Device IDs use visible ASCII with a
1–64 byte limit. Non-device bucket keys contain no device ID. UPDATE triggers
reject key changes and backward clocks. A DELETE trigger rejects explicit
deletion. Trusted bucket writers must not use `REPLACE INTO` or `INSERT OR
REPLACE`: SQLite can delete the conflicting row without running delete triggers
when recursive triggers are disabled. The reservation API uses UPSERT and never
deletes or replaces a bucket.

Keys contain no policy revision, public-key ID, ingress key, or address. New
adapter instances, reconnects, key rotation, and profile changes therefore use
the existing balance. Only explicitly provisioned scopes can create buckets.

## Refill and reservation

The local implementation uses token-bucket rate and burst semantics. One check
costs 60,000 integer units. Capacity is `burst * 60000`, and each elapsed
millisecond replenishes `rate_per_min` units. A new enabled bucket begins with
its full burst and immediately pays for its first check.

Existing buckets settle conservatively using the smaller of their last observed
and current rates and capacities. The old balance is clamped to that capacity
before refill. The write then stores the current rate and capacity snapshots.
Profile increases cannot recover previously discarded credits or apply a higher
rate retroactively. A valid-clock denial still updates the snapshots and refill
time, so a disabled bucket can resume gradual refill after configuration changes.

Rates are safe nonnegative integers. Burst is at most 150,119,987,579, keeping
capacity within the safe integer range. Refill checks the integer time to fill
before multiplying elapsed time by rate. The multiplication runs only when its
result is below the remaining capacity. SQLite integer type checks reject a
floating-point result.

Every reservation uses `RELAY_ADMISSION_CLOCK_SQL` in its own statement. NULL,
fractional, text, negative, unsafe, or backward clocks produce no receipt.
There is no application-clock fallback or caller-provided time parameter.

## Own receipts and adapters

`buildAdmissionBudgetReservationStatement` binds only the bucket key and a fresh
32-hex execution ID. It reads the current allocation inside the write and returns
the stored execution ID, full bucket association, SQL clock, balance, snapshots,
and `granted` flag.

`readAdmissionBudgetReservationReceipt` accepts only the singular raw row from
that invocation. A matching `granted = 1` means `reserved`, and a matching
`granted = 0` means `denied`. Missing, malformed, multiple, foreign, or uncertain
receipts mean `unknown`. No later read or retry can recover a reservation.
These receipts reserve capacity only and do not authenticate or admit a peer.

`createAdmissionBudgetAdapters({ database })` supplies the existing relay and
traversal decision callbacks as `relay` and `traversal`. Its database port exposes
only `writeReturning(sql, bindings)`, which executes once and returns the singular
raw row. The factory captures that method and its receiver without performing I/O.
Every scope write uses a fresh execution ID and the current persisted allocation.

Ingress callbacks charge realm, pool, then authority before enrollment lookup.
After signature verification, registration charges its device subset before the
shared device/realm bucket. A parent denial may leave child capacity consumed.
Nothing refunds it. Relay audiences and traversal share the same device bucket.
The callbacks return the first denied or unknown result without charging later
scopes, retrying, or reading back an uncertain write.

The decision operation authenticates the caller before invoking the verified
device callback. The adapter reserves capacity and performs no authentication of
its own. It captures the namespace and device before awaiting storage, so later
caller mutation cannot redirect a partially completed reservation.

Trusted profile provisioning must validate protected capacity, registration
population and churn reserves, and the actual service ceiling before activation.
The implementation supplies no such production profile or health evidence.
