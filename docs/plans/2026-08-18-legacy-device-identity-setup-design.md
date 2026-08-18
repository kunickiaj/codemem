# Legacy Device Identity Setup and Ownership Repair

**Date:** 2026-08-18

**Status:** Approved

## Summary

Codemem needs to stop presenting every legacy or newly discovered device as if its Identity and owner were already known. Existing stores contain several kinds of device evidence with different trust strengths, and current UI copy sometimes collapses those distinctions too early.

This design introduces an explicit device-identity inventory and a conservative ownership setup workflow. It preserves existing Identity assignments, keeps pairing separate from ownership, treats historical evidence as suggestions unless it is authoritative, and gives users a direct way to confirm which Identity a device belongs to.

The first implementation layer is additive and read-only. It defines the inventory contract, classifies device records, exposes the result to the viewer, and does not change any existing reconciliation or authorization writes.

Implementation-shape clarification: PR1 uses a versioned core projection named `DeviceIdentityInventoryV1`, exposed at `GET /api/sync/recipient-policy/v1/device-inventory`. Coordinator enrollments are injected into the pure core projection by the viewer route; the core projection performs no network reads.

## Problem

Today the viewer can infer or display device ownership from a mixture of:

- the local `sync_device` row,
- `sync_peers`,
- `identity_devices`,
- coordinator enrollments,
- coordinator presence,
- pairing or trust state,
- display names,
- and historical actor references.

Those sources do not all prove the same thing.

A device can be:

- known locally but not assigned to an Identity,
- visible through a coordinator but not yet paired,
- paired but still unassigned,
- assigned through an existing authoritative binding,
- represented more than once because historical identifiers differ,
- or conflicted because evidence disagrees.

The current product language can imply ownership where only reachability or historical association exists. That is unsafe and confusing. A user needs to know what is proven, what is only suggested, and what action is required next.

## Goals

- Preserve existing active device-to-Identity assignments.
- Preserve authoritative Identity assignments created by the reviewed invitation onboarding path.
- Never infer ownership from pairing, trust, display names, coordinator groups, addresses, or `sync_peers.actor_id` alone.
- Distinguish local, paired, coordinator-only, configured, and conflicted devices.
- Provide a stable, versioned inventory contract for the viewer.
- Make setup actions explicit and attributable.
- Keep the first implementation additive and read-only.
- Fail closed when fingerprints or authoritative bindings conflict.
- Bound inventory size and report coordinator evidence availability.

## Non-goals

- Replacing the existing invitation onboarding flow.
- Changing sync authorization or recipient-policy semantics in the first PR.
- Automatically merging Identities.
- Automatically assigning an unbound device to the current user.
- Treating coordinator enrollment as proof of ownership.
- Treating pairing as proof of ownership.
- Reworking the viewer UI in the first PR.
- Migrating or deleting historical rows in the first PR.

## Terminology

### Device

A cryptographic sync endpoint identified by a stable device ID and, when available, public-key fingerprint evidence.

### Identity

A person-level actor represented by an `actors` row and referenced by recipient-policy records.

### Device binding

An `identity_devices` row connecting a device to an Identity. An active binding is authoritative for this design unless conflicting authoritative evidence exists.

### Pairing

The process by which two devices establish mutual sync trust. Pairing proves that the devices have approved communication with each other. It does not prove that they belong to the same person or Identity.

### Coordinator enrollment

A coordinator record describing a device visible in a coordinator group. Enrollment is useful discovery and cryptographic evidence, but enrollment alone is not ownership proof.

### Suggested Identity

A non-authoritative hint that may help prefill setup UI. Suggestions must be confirmed before they become bindings.

## Evidence hierarchy

The projection uses the following evidence hierarchy.

### Authoritative ownership evidence

- An active `identity_devices` row.
- An Identity-bound coordinator enrollment that has already passed the existing reviewed and consumed invitation evidence path and has materialized an active `identity_devices` row.

The second case is intentionally represented through the resulting active binding rather than by trusting the raw enrollment directly. This preserves current invitation onboarding behavior without widening trust for legacy coordinator rows.

### Strong device identity evidence

- A stable device ID.
- A local `sync_device` public key and matching fingerprint.
- A `sync_peers` pinned fingerprint or public key whose derived fingerprint matches.
- A coordinator enrollment public key and matching fingerprint.

Strong device identity evidence can deduplicate records that refer to the same cryptographic device. It does not assign ownership.

### Suggestive evidence

- `sync_peers.actor_id`.
- Historical display names.
- Coordinator display names.
- A coordinator enrollment `identity_id` that has not passed the reviewed invitation path.

Suggestive evidence can be exposed as a setup hint but cannot create or change an `identity_devices` row.

### Non-ownership evidence

- Pairing or mutual trust state.
- Coordinator group membership.
- Network addresses.
- Discovery source.
- Device presence.
- Matching display names.

These facts may explain reachability or guide setup, but they must never be used to infer ownership.

## Inventory states

Every projected device is classified into exactly one of four states.

### `configured`

The device has one active authoritative `identity_devices` binding and no conflicting authoritative or fingerprint evidence.

Configured devices keep their existing Identity. The inventory is descriptive and does not rewrite them.

### `setup_required`

The device is known through the local device row or `sync_peers`, but no authoritative Identity binding exists.

The UI may show a suggested Identity, including a value derived from `sync_peers.actor_id`, but must require explicit confirmation before writing a binding.

### `pairing_required`

The device is visible only through coordinator enrollment evidence. There is no matching local device, peer, or active binding.

This state remains `pairing_required` even when the coordinator enrollment contains an `identity_id`, unless reviewed invitation evidence has already materialized an active local binding. The raw coordinator `identity_id` is not ownership proof.

### `conflicted`

The available evidence cannot be safely represented as one configured or setup-ready device.

Conflicts include:

- one stable device ID associated with multiple validated fingerprints,
- one validated fingerprint associated with multiple active Identity bindings,
- multiple active bindings to different Identities after deduplication,
- an active binding to an inactive, merged, or deactivated Identity,
- a revoked device binding,
- a disabled coordinator enrollment that otherwise participates in the record,
- or a claimed fingerprint that does not match the supplied public key.

Conflicted devices require review. The projection must not choose an owner or silently drop contradictory evidence.

## Deduplication rules

The inventory combines source rows into logical devices conservatively.

### Merge when

- source rows share the same stable device ID, or
- source rows have the same validated public-key fingerprint.

### Do not merge when

- only display names match,
- only addresses match,
- only actor suggestions match,
- only coordinator groups match,
- or fingerprints are missing or invalid.

### Conflict instead of merge when

- a shared stable device ID has different validated fingerprints,
- a claimed fingerprint does not match its public key,
- or merging fingerprint aliases would combine different active Identity bindings.

The projected record keeps all evidence device IDs so a later repair workflow can explain why records were combined.

## Versioned contract

The first PR adds a versioned core contract with these conceptual fields.

```ts
interface DeviceIdentityInventoryItemV1 {
  version: 1;
  deviceId: string;
  evidenceDeviceIds: string[];
  displayName: string;
  state: "configured" | "setup_required" | "pairing_required" | "conflicted";
  identityId: string | null;
  suggestedIdentityId: string | null;
  validatedFingerprint: string | null;
  isLocal: boolean;
  sources: Array<
    "local_device" | "sync_peer" | "coordinator_enrollment" | "identity_binding"
  >;
  conflictCodes: string[];
}

interface DeviceIdentityInventoryV1 {
  version: 1;
  items: DeviceIdentityInventoryItemV1[];
  coordinatorEvidence: {
    availability: "available" | "unavailable";
    safeErrorCode: string | null;
  };
  truncated: boolean;
}
```

The public endpoint is additive and returns the versioned contract. Coordinator evidence is injected into the pure core projection so core logic performs no network reads.

## Projection flow

1. Read the local `sync_device` row.
2. Read bounded `sync_peers` rows.
3. Read `identity_devices` and the referenced actor status.
4. Receive bounded coordinator enrollment evidence from the viewer-server layer.
5. Validate public-key and fingerprint pairs.
6. Build source evidence records.
7. Group by stable device ID.
8. Union groups only when validated fingerprints match.
9. Detect fingerprint and binding conflicts.
10. Classify each logical device.
11. Sort deterministically, putting the local device first.
12. Apply the response limit and expose `truncated`.

The projection performs no writes.

## Coordinator availability

Coordinator evidence is optional at request time. The endpoint must still return local inventory when coordinator configuration is missing or the coordinator cannot be reached.

The response exposes only bounded, safe availability codes such as:

- `coordinator_not_configured`,
- `coordinator_unavailable`,
- `coordinator_evidence_too_large`.

Raw coordinator errors, URLs, credentials, and response bodies must not be returned.

If coordinator evidence is incomplete or exceeds its bound, the endpoint marks it unavailable and does not classify from a partial coordinator snapshot. Partial evidence could hide a conflict and incorrectly weaken the result.

## Existing invitation onboarding

The current reviewed invitation path remains authoritative.

When an add-device or team invitation has been reviewed and consumed through the existing flow, reconciliation may materialize an active `identity_devices` row. The inventory then reports that device as `configured` because the authoritative local binding already exists.

The inventory does not re-evaluate or replace that invitation proof. It also does not downgrade such devices merely because the raw coordinator enrollment would otherwise be considered suggestive.

By contrast, a legacy coordinator enrollment with a null Identity, an unreviewed Identity, or no matching local binding remains `pairing_required`.

## Future setup workflow

A later PR may add explicit write actions for `setup_required` devices.

The intended workflow is:

1. Select an existing Identity or create a new one.
2. Show the evidence supporting the device record.
3. Require explicit confirmation.
4. Re-read the current evidence and reject stale decisions.
5. Write one active `identity_devices` binding with user-confirmed provenance.
6. Record an audit event.
7. Recompute recipient policy through the existing reconciliation path.

Coordinator-only devices must be paired or otherwise cryptographically matched before ownership setup becomes available.

Conflicted devices require a separate repair workflow and cannot use the normal setup action.

## Security properties

- Pairing cannot silently assign ownership.
- A malicious or stale coordinator enrollment cannot overwrite an active local binding.
- `sync_peers.actor_id` cannot materialize an Identity binding.
- Matching names cannot merge devices.
- Invalid public-key and fingerprint pairs fail closed.
- Partial coordinator results cannot weaken classification.
- Endpoint errors do not expose coordinator credentials or internals.
- The read-only PR cannot mutate recipient policy, authorization, actors, or device bindings.

## API behavior

The first PR adds one viewer endpoint under the recipient-policy sync namespace.

The endpoint:

- returns HTTP 200 when local evidence is available even if coordinator evidence is unavailable,
- returns the versioned response,
- reports coordinator availability separately,
- returns a deterministic bounded item list,
- performs no database writes,
- and does not trigger coordinator reconciliation.

## Testing strategy

Core tests cover:

- local unbound device becomes `setup_required`,
- peer-only device becomes `setup_required`,
- `sync_peers.actor_id` is only a suggestion,
- coordinator-only null Identity becomes `pairing_required`,
- coordinator-only unreviewed Identity remains `pairing_required`,
- an active existing binding becomes `configured`,
- reviewed-invitation materialized bindings remain `configured`,
- matching validated fingerprints deduplicate aliases,
- matching display names do not deduplicate devices,
- conflicting fingerprints fail closed,
- conflicting active bindings fail closed,
- revoked or inactive bindings fail closed,
- disabled enrollments fail closed,
- unavailable coordinator evidence does not prevent local inventory,
- and inventory reads do not create `identity_devices` rows.

Viewer-server tests cover:

- the additive endpoint shape,
- injected coordinator evidence,
- coordinator failure redaction,
- local results during coordinator failure,
- bounded output,
- and absence of reconciliation side effects.

## Rollout plan

### PR1: Read-only inventory

- Copy this approved design into the implementation worktree.
- Add versioned core types and pure projection logic.
- Add a database evidence loader.
- Add the viewer endpoint with injected coordinator evidence.
- Add focused tests.
- Export the contract and projection from core.
- Do not change UI behavior.
- Do not add write actions.
- Do not change existing invitation reconciliation.

### PR2: Setup UI

- Present configured, setup-required, pairing-required, and conflicted states.
- Make the primary action explicit.
- Show suggestions as suggestions, not facts.
- Keep advanced evidence behind disclosure.

### PR3: Confirmed binding writes

- Add stale-evidence-checked write actions.
- Add audit records.
- Reuse existing reconciliation after binding confirmation.

### PR4: Conflict repair

- Add explicit repair choices for duplicate IDs, fingerprint conflicts, and conflicting bindings.
- Never auto-resolve ownership conflicts.

## Acceptance criteria for PR1

- Existing active device bindings remain configured.
- Existing invitation onboarding behavior is unchanged.
- Coordinator-only legacy enrollments do not become owned.
- Pairing and trust are not treated as ownership.
- `sync_peers.actor_id` is never materialized by inventory reads.
- The core projection is pure with respect to coordinator I/O.
- The viewer endpoint is additive and read-only.
- Coordinator unavailability is explicit and safely redacted.
- Device records are deduplicated only through stable IDs or validated fingerprints.
- Conflicts fail closed.
- Focused tests pass.
- Type checking and linting pass.
