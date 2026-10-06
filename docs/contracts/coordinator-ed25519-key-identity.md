# Canonical coordinator device-key identity

**Scope:** Canonical metadata helpers and their integration into internal
coordinator revocation storage and signed-request admission. Signature acceptance
and legacy text fingerprints remain unchanged. Public revocation management and
complete writer/discovery enforcement are still gated.

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

## Server-runtime metadata compatibility

`parseSshEd25519PublicKeyForRevocation` and `ed25519KeyIdForRevocation` provide
a separate metadata path using the standard `node:buffer` decoder. They share the
same wire extraction, canonical encoding and WebCrypto hash stages; there is no
hand-written permissive base64 decoder. This path is for Node and Worker runtimes
with Node compatibility, not a generic browser helper.

The original `atob`-based functions and both signature verifiers keep their
existing behavior. Normalizing a Node-compatible encoding for metadata does not
make the Worker accept its signature. Native compatibility tests pin that distinction.

The [revocation admission contract](coordinator-device-revocations.md) uses the
finished compatibility wrapper to derive IDs from server-held public keys.
The Worker bundle permits only the specifically required `node:buffer` builtin
in addition to its existing supported imports; unsupported modules and native
assets remain blocked. Native alias tests and bundle checks cover that integration.

## Admission invariant and remaining gates

The Node verifier's Buffer decoder and the Worker's `atob` decoder accept
different base64 representations. Tests pin those differences against the real
verifiers; callers must not assume the original strict helper covers both.

The first-party Node and Worker verifiers accept Ed25519 keys whose actual bytes
are understood by the compatibility wrapper. Parity tests maintain that invariant.
Admission additionally rejects an Ed25519 entry when that wrapper returns no ID;
it never silently falls back to a device-ID-only check for a malformed Ed25519 key.
Opaque non-key fixture strings can retain device-ID-only storage behavior, but
neither real verifier authenticates them. A custom verifier for another algorithm
needs an explicit compatible key-identity contract before key-based revocation.

Owner enrollment must require a supported canonical key ID. Public management,
all enrollment writers, and discovery/bootstrap closure still need their separate
guards and review; this integration does not claim complete revocation behavior.

Normalizing keys for revocation also does not authorize enrollment. Registration
still needs verified account ownership, explicit device confirmation, key
possession, and current authorization. A canonical key ID alone proves none of them.
