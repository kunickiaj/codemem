# OpenCode 2 checkout dogfood design

## Decision

Codemem will make its repository-local plugins valid under both OpenCode 1 and OpenCode 2 before preparing 0.45.0-rc.1.

The checkout Codemem wrapper will export the same dual-host definition as the package entrypoint instead of bypassing it for the legacy server function. The contributor-only Biome feedback plugin will remain active through its `server` entrypoint on OpenCode 1 and expose a no-op `setup` entrypoint on OpenCode 2; real OpenCode 2 lint feedback remains tracked separately after 0.45.

## Alternatives

The dual-wrapper approach preserves existing contributor behavior and removes misleading OpenCode 2 load failures.

Removing the Biome feedback plugin would simplify configuration but regress OpenCode 1 contributor feedback. Testing only a packed temporary install would avoid checkout changes but leave normal OpenCode 2 startup from this repository broken, which defeats local dogfooding.

## Validation

The pinned OpenCode 2.0.2 host smoke will activate plugins from the actual repository root using an isolated home directory and reject any failed Codemem or lint-feedback load.

Unit coverage will verify that the checkout Codemem wrapper is the package dual-host definition and that the lint-feedback wrapper exposes the legacy server plus an explicit OpenCode 2 no-op setup. Existing packed OpenCode 1 and OpenCode 2 checks remain release gates.
