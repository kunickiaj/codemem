# Coordinator auth account-link metadata contract

**Status:** Draft; inert and unintegrated

## Purpose

This contract describes pure metadata parsing and account-link eligibility for a
future coordinator auth flow. It enables neither authentication nor runtime
authorization.

Coordinator sign-in is optional and is not a requirement for local Codemem use.

An account key is the exact configured HTTPS issuer plus opaque subject. Email,
names, tokens, and other claims do not identify an account for this contract.

## Mapping rule

Within one coordinator, one provider account links to one existing actor-backed
Identity, and one Identity has one account link in this initial version. A link
cannot cross coordinators. There is no multiplicity configuration flag.

Snapshots must include revoked rows; filtering tombstones must not free an
account or Identity for relinking. This helper rejects those rows. An
admin-reviewed account replacement or provider rotation is a future gated
workflow, not proof that recovery is impossible.

## Parser contract

`parseCoordinatorAccountReference(value, { issuer })` accepts only a value with
the exact configured HTTPS issuer and an opaque, non-empty subject. It ignores
extra claims, including email.

It does **not** verify a JWT, signature, token audience, expiry, or provider
proof. It does not create a link or proof of ownership.

```ts
// Trusted internal sample, not a production endpoint.
parseCoordinatorAccountReference(
  { issuer: "https://accounts.example.test", subject: "provider-subject" },
  { issuer: "https://accounts.example.test" },
);
// => { ok: true, account: { issuer: "https://accounts.example.test", subject: "provider-subject" } }
```

## Eligibility decision contract

`decideCoordinatorAccountLink(input, { issuer })` requires the configured issuer
for the requested account. Its input contains:

- `coordinatorId`;
- `account: { issuer, subject }`;
- `identityId`;
- `device: { deviceId, fingerprint }`;
- `accountLink` and `identityLink`, each `null` or `{ coordinatorId, account,
  identityId, status }`, where status is `active` or `revoked`; and
- internally verified ownership `{ kind, coordinatorId, identityId, deviceId,
  fingerprint }`, where kind is `controller_verified` or `admin_verified`.

`controller_verified` means an existing trusted device controls the Identity.
The labels do not verify anything here: ownership must already be verified by a
trusted future internal caller, never request JSON. For creation or an existing
matching link, the decision requires all of:

1. exact coordinator, Identity, device, and fingerprint evidence;
2. valid, consistent snapshots with the same one-to-one mapping; and
3. no revoked link or conflicting account/Identity mapping.

Invitation-derived actor claims and unavailable evidence require review. Any
conflict fails closed. Returned error codes must be redacted: never include raw
claims, tokens, keys, or account values in error text.

A shape-valid stored `identityLink` with another issuer conflicts with the
requested account; it never acts as acceptance.

```ts
// Trusted internal sample, not a production endpoint or a proof format.
decideCoordinatorAccountLink({
  coordinatorId: "coord-a",
  account: { issuer: "https://accounts.example.test", subject: "provider-subject" },
  identityId: "actor-existing",
  device: {
    deviceId: "device-1",
    fingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  ownership: {
    kind: "controller_verified",
    coordinatorId: "coord-a",
    identityId: "actor-existing",
    deviceId: "device-1",
    fingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  accountLink: null,
  identityLink: null,
}, { issuer: "https://accounts.example.test" });
// => { kind: "eligible", disposition: "create", coordinatorId: "coord-a", identityId: "actor-existing", account: { issuer: "https://accounts.example.test", subject: "provider-subject" } }
```

`eligible` is metadata only. It is not Project authorization, device enrollment,
or persistence approval.

## Integration boundary

A future store must take its snapshots transactionally and enforce atomic
uniqueness guards; this pure helper cannot prevent races. It must also perform
actual OIDC, device, and browser-completion cryptographic verification after the
authentication protocol approval gate. See
[`ADR 0004`](../adr/0004-authenticated-identity-and-live-relay-boundaries.md).

This module is not exported from runtime barrels and is not called by current
runtime code. It changes no login, sync, invitation, sharing, or recovery
behavior.

## Compatibility

The existing mixed Identity keeps its current actor ID; no personal/work split,
actor migration, reinvite, default-sharing change, or existing-key migration
occurs.
Any future split is explicit, reviewed, and never inferred from old authorship.
Separate contexts require both separate databases and separate key directories.
