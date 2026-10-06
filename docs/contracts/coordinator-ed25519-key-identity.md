# Canonical coordinator device-key identity

**Scope:** Inert helper and verifier compatibility tests for future device
revocation. This slice changes no signature acceptance, stored fingerprint,
enrollment, permission, or revocation behavior.

## Two fingerprints serve different purposes

The existing `fingerprintPublicKey` hashes the entire SSH public-key string.
Comments and whitespace therefore change that fingerprint. Keep it unchanged:
existing ownership evidence and enrollment snapshots depend on exact text.

Revocation needs to recognize the same cryptographic key despite formatting
changes or a different device ID. The new key ID is SHA-256 of the canonical SSH
Ed25519 wire blob: the `ssh-ed25519` type and the 32 public-key bytes, encoded as
SSH length-prefixed strings. This is the standard OpenSSH SHA256 fingerprint
represented as hexadecimal, not a new cryptographic construction.

## Internal helper contract

- `parseSshEd25519PublicKey` returns the canonical blob for the public bytes used
  by the Ed25519 verifier, `malformed_ed25519` for an unparseable Ed25519 entry,
  or `other` for a different key type or fixture string.
- `ed25519KeyId` hashes that blob with WebCrypto and returns a hexadecimal ID,
  or `null` if no canonical blob was obtained.

The portable parser follows the existing Worker decoder's accepted representation
and bounds-checks wire reads. It is not a stricter replacement verifier. It
canonicalizes the actual Ed25519 bytes even where the existing verifiers tolerate
an alternate inner type string or trailing bytes.

## Guard integration remains gated

The Node verifier's Buffer decoder and the Worker's `atob` decoder may accept
different base64 representations. Tests must pin those differences against the
real verifiers, rather than assume the helper covers their combined acceptance.

If a real verifier accepts a key that this helper cannot parse, a future revocation
guard must not fall back silently to device-ID-only checks. It must either obtain
the canonical identity from the exact bytes the trusted verifier checked, or apply
an explicitly reviewed fail-closed compatibility rule. This slice chooses neither
runtime policy and adds no guard.

Normalizing keys for revocation also does not authorize enrollment. Registration
still needs verified account ownership, explicit device confirmation, key
possession, and current authorization. A canonical key ID alone proves none of them.
