# Local account-owner associations

An account-owner association proposes local account context; it never grants remote authority or changes the running actor.
Consumers must recheck remote authority before acting on it.

## Exact generations

Callers that pass `expectedProfilePins` use an exact generation keyed by all eight captured pins, including the database's filesystem device and inode (`dev:ino`).
New records live in the current user's `~/.codemem/account-owner-associations/` directory, not beside the database.
The filename is `.account-owner-<SHA-256 of the pins>.json`; neither the database basename nor its containing directory participates in this location.

Renames and hardlinks, including links in different directories, therefore find the same retained generation when the pins and user home stay the same.
A conflicting review cannot publish a second record for that generation through another database pathname.
This is local filesystem identity, not a permanent database UUID: inode reuse is not detected by these pins.

Generation filenames are 84 ASCII bytes and staging adds 41 bytes.
Publication no longer depends on the length of the database pathname; it requires the user's state directory and its complete staging pathname to fit the filesystem limits.
The state directory must be owned by the current user, must not be a symlink, and must have mode `0700`; its `.codemem` parent must be owned by the current user, must not be a symlink, and must not be group- or world-writable.
The helper does not change existing directory permissions.

Capture and read operations do not create directories, databases, or associations.
Retention creates missing state directories, syncs their ancestors, and uses the existing create-only, file-and-directory-synced publication helper.
Retries sync the ancestors again even when a previous directory creation became visible before a sync failed.
Ambiguous publication failures never remove retained evidence.

## Historical compatibility

Reads still inspect the selected database pathname's legacy sidecar, original generation sidecar, and basename-hashed generation sidecar.
Malformed or unsafe historical evidence still fails validation, and conflicting exact generations fail rather than choosing one.
An `ENAMETOOLONG` result counts as missing only for historical sidecar lookups; other failures remain errors.

An exact retention retry against matching historical evidence also publishes a create-only copy in the stable per-user directory.
It does not rewrite, move, or delete the historical file.
After that retention succeeds, database aliases can find the stable copy without knowing the original pathname.

Historical files that have never been retained into the stable directory remain discoverable only through their original database pathname.
The helper cannot find sidecars beside arbitrary unknown hardlinks or former names; it does not scan the filesystem.
Applications must retain historical evidence through its known pathname before relying on alias-independent lookup.

Callers that omit `expectedProfilePins` keep the legacy sidecar behavior and its existing pathname limits.
Older binaries cannot discover the new per-user generation files, and changing the user's home or transferring only the database does not transfer these associations.
These helpers do not detect hostile replace-and-restore races between filesystem checks and do not turn mutable local JSON into signed evidence.
