# Release Discovery and Update Notifications Implementation Plan

## Overview

Deliver the approved updater design as four dependent Graphite pull requests. Each pull request maps to one Beads feature under epic `codemem-eiq9` and must remain independently testable.

## Prerequisites

- Fresh detached worktree based on `origin/main` at `a9fa59d9`.
- Node 24 and workspace dependencies installed.
- Approved design: `docs/plans/2026-08-10-release-discovery-and-update-notifications-design.md`.
- Plugin source changes mirrored into the CLI plugin test harness where required.

## PR 1: Release discovery

**Bead:** `codemem-eiq9.1`  
**Commit:** `feat(update): add release discovery`

### Tasks

1. Define stable `UpdateStatus`, installation-kind, cache, and resolver contracts in a leaf core module.
2. Implement strict stable-semver parsing and comparison without adding a dependency.
3. Implement fixed-origin npm lookup with injected fetch/clock, two-second timeout, six-hour cache, and process-local single-flight behavior.
4. Persist cache state atomically under the Codemem home directory and preserve `first_seen_at` while the same latest release remains current.
5. Add `codemem update check` with `--json` and `--refresh`; register command and completions.
6. Add focused resolver and CLI coverage for current/newer/prerelease/downgrade/malformed/offline/cache/timeout/concurrency behavior.
7. Include the approved design and implementation plan.

### Main files

- `packages/core/src/release-discovery.ts`
- `packages/core/src/release-discovery.test.ts`
- `packages/core/src/index.ts`
- `packages/cli/src/commands/update.ts`
- `packages/cli/src/commands/update.test.ts`
- `packages/cli/src/index.ts`
- `docs/versioning.md`

### Validation

```fish
pnpm exec vitest run packages/core/src/release-discovery.test.ts packages/cli/src/commands/update.test.ts
pnpm run codemem -- update check --json
pnpm run tsc
```

## PR 2: Plugin and Viewer notifications

**Bead:** `codemem-eiq9.2`  
**Depends on:** `codemem-eiq9.1`  
**Commit:** `feat(update): surface release notifications`

### Tasks

1. Add a dedicated Viewer update-status route; keep `/api/runtime` registry-free.
2. Add UI API types/client state and Health states for current, available, stale, and unavailable checks.
3. Add plugin startup release check through the CLI runner and notify once per discovered release.
4. Respect `notify` and `off` without adding installation behavior.
5. Mark Docker builds with an explicit install kind and provide durable pin/rebuild guidance.
6. Update README and plugin reference documentation.

### Main files

- `packages/viewer-server/src/routes/update-status.ts`
- `packages/viewer-server/src/index.ts`
- `packages/viewer-server/src/index.test.ts`
- `packages/ui/src/lib/api/`
- `packages/ui/src/tabs/health/`
- `packages/opencode-plugin/.opencode/plugins/codemem.js`
- `packages/cli/.opencode/tests/`
- `deploy/docker/Dockerfile`
- `README.md`
- `docs/plugin-reference.md`

### Validation

```fish
pnpm exec vitest run packages/viewer-server/src/index.test.ts packages/ui/src/tabs/health.test.ts
pnpm --filter codemem test:plugin
pnpm --filter @codemem/ui build
pnpm run tsc
```

## PR 3: Peer runtime versions

**Bead:** `codemem-eiq9.3`  
**Depends on:** `codemem-eiq9.2`  
**Commit:** `feat(sync): report peer runtime versions`

### Tasks

1. Add nullable additive peer runtime-version columns and fresh-schema coverage without bumping `SCHEMA_VERSION`.
2. Add optional `runtime_version` to signed peer status.
3. Validate bounded stable versions only after existing identity and fingerprint verification.
4. Persist valid versions with observation time; treat missing or malformed values as unknown.
5. Expose optional versions in sync API types and render them on paired Device cards.
6. Prove that runtime versions never affect trust, authorization, status, or capability negotiation.

### Main files

- `packages/core/src/schema.ts`
- `packages/core/src/schema-bootstrap.ts`
- `packages/core/src/db.ts`
- `packages/core/src/sync-pass.ts`
- `packages/viewer-server/src/routes/sync.ts`
- `packages/ui/src/lib/api/sync.ts`
- `packages/ui/src/tabs/devices.tsx`
- Related core, viewer, and UI tests

### Validation

```fish
pnpm exec vitest run packages/core/src/db.test.ts packages/core/src/sync-pass.test.ts packages/viewer-server/src/index.test.ts packages/ui/src/tabs/devices.test.tsx packages/ui/src/app-devices.test.tsx
pnpm --filter @codemem/ui build
pnpm run tsc
```

## PR 4: Delayed opt-in npm upgrades

**Bead:** `codemem-eiq9.4`  
**Depends on:** `codemem-eiq9.3`  
**Commit:** `feat(update): enable opt-in npm upgrades`

### Tasks

1. Add the 24-hour first-seen eligibility predicate using fresh validated status only.
2. Add `codemem update install` with fail-closed installation-kind checks.
3. Extend the existing plugin update plan rather than adding a second execution mechanism.
4. Verify the active CLI version after installation.
5. Restart only a plugin-owned Viewer and keep installation/restart failures non-fatal to plugin operation.
6. Document auto policy, refusal cases, and Docker workflow.

### Main files

- `packages/core/src/release-discovery.ts`
- `packages/cli/src/commands/update.ts`
- `packages/opencode-plugin/.opencode/lib/compat.js`
- `packages/cli/.opencode/lib/compat.js`
- `packages/opencode-plugin/.opencode/plugins/codemem.js`
- Related core, CLI, and plugin tests
- `README.md`
- `docs/plugin-reference.md`
- `docs/versioning.md`
- `deploy/docker/README.md`

### Validation

```fish
pnpm exec vitest run packages/core/src/release-discovery.test.ts packages/cli/src/commands/update.test.ts
pnpm --filter codemem test:plugin
pnpm run tsc
```

## Full-stack gate

```fish
pnpm --filter @codemem/ui build
pnpm run check
```

After the full gate, run CodeReviewer on the complete stack, with a security focus on peer-authenticated metadata and process execution, then run the pragmatic quality reviewer before `gt submit --stack --no-interactive`.
