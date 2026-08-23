# Recipient-policy canonical hashing design

## Goal

Make recipient-policy serialization injective over its supported JSON data model and bind each digest cryptographically to its domain prefix.

## Supported values

Canonical serialization accepts only:

- `null`, booleans, and strings;
- finite numbers other than negative zero;
- dense arrays without custom properties; and
- plain objects with enumerable data properties and either `Object.prototype` or `null` as their prototype.

Object keys remain deterministically UTF-16-code-unit sorted and array order remains significant.

Values outside that model throw at the serialization boundary. This includes `undefined`, functions, symbols, bigint values, non-finite numbers, negative zero, sparse arrays, accessors, symbol or non-enumerable properties, non-plain objects, and cycles. Shared acyclic values remain valid because JSON represents their expanded value rather than object identity.

## Digest construction

`recipientPolicyDigest(prefix, value)` retains the external `prefix:<hex>` shape but computes SHA-256 over these bytes in order:

1. the UTF-8 domain prefix;
2. one NUL byte; and
3. the canonical JSON value.

Prefixes containing NUL are rejected so the separator is unambiguous.

## Released identifier compatibility

Codemem v0.42.0 already persisted the former hash construction in Team and Identity primary keys, relationship metadata, and review-resolution fingerprints. Rekeying that graph inside this hardening bead would risk orphaned grants and duplicate logical records.

Released digest families therefore continue through an explicitly named compatibility helper that hashes only canonical JSON and preserves their bytes. This includes `deterministicPolicyTeamId` and the existing recipient-policy migration and review flows. New legacy-Team setup digest domains use `recipientPolicyDigest` and receive domain separation. Any future migration away from the compatibility helper requires an explicit database rekey plan.

Other modules with independently versioned confirmation or reconciliation digests remain outside this change; moving those contracts requires their own compatibility analysis.

## Compatibility and errors

No dependency, schema, or public response-shape change is required. Existing callers already provide JSON-shaped policy data. Invalid values throw `TypeError` with a stable boundary message instead of collapsing to another representation.

## Verification

- Preserve stable object-key ordering and array ordering behavior.
- Reject every unsupported primitive and structural form.
- Prove formerly colliding values such as `undefined`, functions, and symbols no longer serialize as `null`.
- Pin domain-separated digest output and show identical values in distinct domains hash differently.
- Pin both the new domain-separated bytes and released compatibility bytes, then run the full workspace gate.
