# Source-qualified memory identity prerequisite

New source-qualified identities let an authenticated device prove authority over its own memory namespace without trusting mutable origin metadata.
The internal format is `memory-source-v1:<canonical base64url device ID>:<UUIDv4>`.
The namespace owner must match the device identity returned by successful transport authentication; parsing a key alone is not authentication.

## Authority boundary

Immutable bindings retain verified source authority independently of memory rows and operation logs.
Local allocation reads the database's local device identity, generates a new key, and records `local_creation` evidence inside the caller's transaction.
Remote verification records `authenticated_namespace` evidence only when the authenticated sender owns the namespace, including when the memory row is absent.
Bindings cannot be updated or deleted by ordinary SQL, have no cascading foreign keys, and preserve their first evidence on retry.

Historical UUIDs remain unverified even if their mutable origin matches the sender.
The existing importer can overwrite `origin_device_id` from a higher-clock payload; neither that field, a user's ownership choice, nor a sender's signature proves who created a historical UUID.
Forwarded claims require a separate verified source proof and cannot use the immediate forwarding peer as the source.

## Activation and manual recovery

This prerequisite supplies internal primitives only and does not enable a wire feature, change capture IDs, or expose an ownership UI.
Subsequent units must enforce these bindings at capture, import, retirement, snapshot, and transport admission boundaries before activation.
The existing protocol remains unchanged, including its mutable-origin behavior; the new regression tests prove that such mutation cannot change verified bindings.

Historical resolution must ship with executable verification or recovery actions before the repair UI is enabled.
When the original source cannot be verified, the approved recovery path creates new local source-qualified copies under the user's current authority, preserves privacy, records the original identity as provenance, and marks the copies as recovered.
Its reviewed preview must identify the affected records, missing evidence, recipients, duplicate effects, and retained originals; commit must reject stale authority and retry without duplicate copies.
Recovery must never relabel a historical UUID as verified or claim that unproven originals were erased from peers.

The recovery API is a separate dependent unit; no endpoint in this prerequisite performs recovery.
