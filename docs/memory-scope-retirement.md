# Verified memory scope retirement ledger

This prerequisite records a permanent source-authorized prohibition against replaying one memory identity into one retired scope.
It uses immutable source bindings rather than the mutable `origin_device_id` field that the existing importer can overwrite.
No production caller, wire handler, or capability advertisement activates retirement in this unit.

## Internal contract

`recordMemoryScopeRetirement(db, control, options)` records a payload-free control inside the caller's transaction.
The control is `{entityId, sourceDeviceId, retiredScopeId}`; options contain `authenticatedSourceDeviceId` and `now`.
The caller must provide the device identity from successful transport authentication, or the actual local device for a local move, and perform the corresponding move or cleanup in the same transaction.

An authenticated namespace owner can retire an absent source-qualified identity without an existing memory row.
A claimed source, forwarded peer identity, mutable origin, or historical UUID is insufficient: the namespace must match the independently authenticated device and its immutable binding.
Historical records without proof use the reviewed ownership recovery API to create new qualified copies; retirement never blesses their original identities.

`isMemoryScopeRetired` and `assertMemoryScopeNotRetired` consult the durable fence without depending on memory clocks or current origin metadata.
The ledger and source bindings have no memory/log foreign keys, reject update/delete/replace, and survive row erasure and log compaction.
Identical controls are idempotent; transaction rollback removes both newly created source proof and retirement.

## Incremental enforcement

Incremental apply skips retired-scope memory mutations before clock comparison, including absent rows and higher-clock replay.
For identities with retirement history, missing/blank envelope scopes and contradictory payload or metadata scopes are skipped even when optional membership validation is disabled.
These operations are excluded from membership preflight and checked again in the apply transaction, without recording the rejected content or changing clocks.

The peer operation loader and outbound filter use the same guard, including for deletes, reassignment sides, and legacy cleanup targets.
Reassignment validates the envelope against its declared side; a retired old scope is legitimate on a valid unretired destination-side operation.
Newly generated reassignment content stamps the destination into metadata as well as the payload so stale metadata cannot contradict the envelope.

Unrelated identities retain their existing legacy behavior, while valid unretired destination operations remain eligible for normal authorization checks.
Filtering still advances content cursors; it does not deliver retirement controls or prove that an offline recipient has cleaned up.

Local reassignment rejects a destination that the same identity previously retired.
An exact retry with both completed reassignment sides returns the original result without writes, even if an onward move has since retired that destination; new mutations still check the fence inside the write transaction.
The fence is specific to the entity and old scope; unrelated memories and scopes continue through existing authorization checks.
Retirement adds no membership or destination grant and contains no destination content or recipient list.

## Activation dependencies

The ledger is not a complete retirement protocol and must remain inactive until the dependent stack is finished.
The internal [control delivery prerequisite](memory-retirement-delivery.md) supplies separately negotiated payload-free replay and acknowledgements without activation.
The [snapshot/reset prerequisite](memory-retirement-reset.md) supplies guarded import/export and a source-pinned reset handshake.
A batch admitted before retirement can still contain previously selected bytes until cross-process export admission/drain closes that race.

Offline peers can retain originals until they receive and apply authenticated controls; unsupported peers require explicit pending status and later replay after upgrade.
No content-cursor advance, local receipt, or source-qualified recovery copy proves remote deletion.
The ownership UI remains gated on working recovery and safe repository repair activation, including a separate preview of the authoritative main Project policy.
