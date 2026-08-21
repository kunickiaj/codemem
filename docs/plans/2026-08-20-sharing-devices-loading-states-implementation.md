# Sharing and Devices loading states implementation

## Scope

1. Add a shared Preact card-list skeleton for Sharing and Devices.
2. Replace both plain initial-loading messages with the shared skeleton.
3. Add shared CSS beside the existing recipient-policy card styles, using
   `--duration-shimmer` and the current motion preference.
4. Cache the last successful Sharing data so a background refresh failure can retain its cards.
5. Cover initial skeleton semantics, successful replacement, retained background content, and
   initial versus refresh errors in focused tests.

## Validation

- Run the Sharing, Sharing loader, and Devices Vitest files.
- Run TypeScript, Biome, and `git diff --check`.
- Build the UI because Viewer assets and static hosting depend on the UI output.
