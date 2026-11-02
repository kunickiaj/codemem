# Inert traversal coordinator schema

These definitions describe policy, health observations, and digest-only traversal
attempts. They install nothing at startup and authorize no request. Tests install
them only in disposable SQLite and local D1 databases. Production schema
activation, controller writers, budgets, and maintenance require separate work.

`TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS` exports a frozen list of SQL definitions
from `peer-traversal-coordinator-schema.ts`. It has no package index export.
The metadata and attempt modules also export separate frozen definition lists,
`TRAVERSAL_COORDINATOR_METADATA_SCHEMA_STATEMENTS` and
`TRAVERSAL_COORDINATOR_ATTEMPT_SCHEMA_STATEMENTS`. The aggregate orders metadata
before attempts so the referenced realm tables exist first.
Attempt realm existence relies on foreign-key enforcement. SQLite installers
must enable `PRAGMA foreign_keys=ON`. D1 enables enforcement by default.

## Policy and readiness

A realm is one authority and discovery group pair. The metadata tables are:

| Table | Columns |
| --- | --- |
| `traversal_authority_policy` | `authority_id`, `policy_revision`, `operator_state` |
| `traversal_realms` | `authority_id`, `group_id`, `operator_state`, `changed_revision` |
| `traversal_readiness` | `authority_id`, `scope`, `group_id`, `revision`, `state`, `observed_at_ms` |

The root policy begins at revision 1 and each update increments it by exactly 1.
Realm changes use the current root revision and increase their own recorded
revision. A trusted writer must publish a fixed captured successor revision and
its child changes in one atomic batch. Filtering a stale root update to zero
rows cannot prove that its child changes belong to that batch.

Authority readiness begins at revision 1. Realm readiness inherits the current
authority readiness revision. Ready observations require an integer timestamp.
Observation timestamps reserve 50,000 milliseconds below the maximum safe integer
for subsequent freshness arithmetic.
Metadata collisions, replacement paths, and deletes abort. Missing metadata
cannot enable traversal, and omitted operator states default to disabled.

## Attempt records

`traversal_attempts` uses `session_id` as its primary key and stores no raw body,
description, SDP candidate, or coordinator response.

| Columns | Meaning |
| --- | --- |
| `session_id`, `authority_id`, `group_id` | Fixed attempt and realm identifiers. |
| `source_device_id`, `source_key_id`, `target_device_id`, `target_key_id` | Fixed peer pair and pinned SSH wire-key digests. Device IDs differ. |
| `message_a_digest`, `prepare_created_at`, `attempt_not_after` | Fixed opening digest and Unix-second times. The deadline equals preparation time plus 55 seconds. |
| `policy_revision`, `prepare_digest`, `created_at_ms` | Fixed captured policy revision, PREPARE body digest, and SQL creation time. |
| `phase`, `offer_digest`, `answer_digest` | Current phase and packet digests introduced at phases 2 and 4. |
| `last_request_digest`, `last_nonce`, `exec_id`, `updated_at_ms` | Current request association, fresh execution ID, and SQL update time. |

Device IDs use the signal codec's visible-ASCII bounds. Hex IDs and digests use
its exact lowercase hexadecimal lengths. Group IDs occupy 1–128 SQL text bytes
and exclude NUL. The codec validates the remaining group syntax before admission.
Unix seconds must convert safely to milliseconds. Times and revisions are safe
nonnegative integers. Revisions start at 1, the deadline is positive, and update
time cannot precede creation or the previous update.

An insert starts at phase 1 with `last_request_digest = prepare_digest` and null
offer and answer digests. Every update advances exactly one phase through 5 and
changes `exec_id`. Fixed columns never change. The offer digest is introduced
only at 1 → 2 and the answer digest only at 3 → 4. Each is preserved afterward.
At phases 2 and 4, the last request digest equals the newly stored packet digest.

## Quotas and retention

Insert triggers count unfinished attempts in the same realm using their own SQL
clock. An unfinished attempt has a phase below 5 and has not expired. The limits
are one per ordered source/target pair, four per source, and four per target.
Crossed calls are independent pairs. Expired and completed attempts do not count.
An expired historical insert can coexist with a full live quota because it adds
no live usage. Request freshness must still pass the admission checks.
Unknown or invalid SQL clock values deny attempt writes and deletion.

Session collisions abort even for replacement, upsert, and conflict-ignore
statements. Deletes abort until expiry plus 120 seconds, so an early deletion
cannot release a quota. Physical pruning still needs a maintenance scheduler.
The delete trigger computes that cutoff with SQL integer arithmetic. At the
largest permitted deadline, adding the retention interval exceeds JavaScript's
safe integer range. Maintenance must compare the cutoff in SQL rather than
recompute it with a JavaScript `number`.
The carrier alone retains portable packets and owns their expiry and deletion.
Shared nonce cleanup must preserve the existing 600-second coordinator retention
rule and account for clock error.

## Conditional phase writes

`peer-traversal-coordinator-attempt-write.ts` compiles separate nonce and state
statements for all five phases. Both repeat the current participant, revocation,
group, policy, readiness, time, and phase-association checks. PREPARE requires an
absent session and inserts phase 1. Later phases require the exact predecessor,
fixed attempt tuple, and earlier packet digests before updating the state.

The source signs phases 1, 2, and 5. The target signs phases 3 and 4. Each phase
has its own signed creation time, admission window, and nonce. Phase times can
lag or move backward while still passing freshness checks. They never reset the
original PREPARE creation time or its fixed 55-second deadline.

The caller supplies a verified packet and captured participants. Compilation owns
the inputs before asynchronous hashing and checks their byte and identity
bindings. It executes no SQL and does not verify signatures again.

The caller must execute the nonce statement once and validate its own receipt
before executing the state statement with a fresh execution ID. The state write
returns its stored execution ID and final SQL clock. `readTraversalStateReceipt`
checks that row against the compiled statement. A quota failure can leave the
nonce consumed without creating an attempt. A missing or uncertain receipt denies
the request and cannot be recovered by a later read or an automatic retry.

The schema constraints alone do not verify signatures, current participants,
revocations, policy eligibility, freshness, or budget reservations. Conditional
statements recheck database eligibility. The private orchestrator must also verify
signatures, reserve budgets, and require receipts bound to its two writes before
replying.
A stored row or its shape alone is not evidence that an authorized decision
occurred.

## Coordinator decisions

`decideTraversalSignal` composes those checks through private database and budget
ports. It reserves ingress before lookup or hashing, captures the current policy
and both participants, verifies the phase signature against its actor's current
pin, and reserves verified-device budget before writing.

The function requires a receipt from its own nonce write before attempting the
state write with a different execution ID. It returns `null` for missing or
unknown budgets, invalid signatures, rejected writes, or uncertain receipts.
It never retries a write or reads state to recover a lost receipt.

A positive result contains only the request association, policy revision, final
state decision clock, readiness observation, and remaining attempt lifetime.
`remainingMs` equals `attemptNotAfter * 1000 - decidedAtMs`. Earlier nonce clocks
and readiness observations do not replace the final state's values.

The ports must settle within the caller's request lifetime. In-memory budget
reservations in tests prove this composition only. Production requires a durable
budget implementation, clock evidence, and separate activation approval.

## Own replies and request carrier

`requestTraversalSignalDecision` sends one raw canonical phase array with its v2
header fields through an injected authenticated HTTPS port. Portable packet
objects are not the HTTP entity body. The port owns origin authentication,
cancellation, and settlement within the supplied deadline.

The client accepts only a matching status-200 reply of at most 1,024 bytes. It
checks every reply field, the decision window, readiness, and any earlier policy
revision. It maps the remaining lifetime to the local request-start monotonic
clock, intersects earlier leases and the caller deadline, and rechecks expiry
after parsing. It never retries an uncertain request.

`createTraversalSignalCarrier` holds one offer and one answer for one session.
Each envelope contains exactly two signed requests. It accepts each envelope
type once, copies the packet values, and releases stored references on receipt,
close, or expiry within its maximum 55-second lifetime. It stores no coordinator
approvals and grants no permission to use a description or activate RTC.

Peers still verify the pinned packet prefix, obtain their own phase decisions,
and enforce the returned deadlines before using descriptions or releasing Noise.
Controlled tests combine disposable SQLite, real signatures,
and Noise over owned memory channels. They do not prove HTTPS origin handling,
RTC resource limits, or NAT traversal.
