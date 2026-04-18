# Contributing to codemem

Thanks for helping improve codemem.

## Local setup

```text
pnpm install
pnpm run codemem --help
```

This repo is TypeScript-first. Treat `codemem/` and `tests/` Python code as legacy/reference unless you are explicitly working on those surfaces.

## Quality checks

Run these before opening a PR:

```text
pnpm run lint
pnpm run tsc
pnpm run test
pnpm build
```

Targeted test examples:

```text
pnpm exec vitest run packages/cli/src/commands/serve.test.ts
pnpm exec vitest run packages/viewer-server/src/index.test.ts
pnpm exec vitest run packages/core/src/index.test.ts
```

## Context injection validation

When changing pack retrieval, context injection, or the adapter surfaces
that inject memory into an agent's prompt, the following suites cover
the relevant behavior. Run the targeted one first, then `pnpm run test`
before opening a PR.

| Concern | Command |
|---|---|
| Core pack invariants (section selection, dedupe, token budget, recall vs default mode) | `pnpm exec vitest run packages/core/src/pack.test.ts` |
| Pack usefulness evals (recall / task / continuation / working-set ranking) | `pnpm exec vitest run packages/core/src/pack.eval.test.ts` |
| OpenCode adapter prompt-time injection (transform, cache, toast, failure paths) | `pnpm --filter codemem run test:plugin` |
| Claude hook context injection (PreToolUse / UserPromptSubmit) | `pnpm exec vitest run packages/core/src/claude-hooks.test.ts` |
| CLI manual injection contract (`codemem pack`, `codemem memory inject`) | `pnpm exec vitest run packages/cli/src/commands/pack.test.ts packages/cli/src/commands/memory-inject.test.ts` |

Shared fixture corpus for pack / usefulness evals lives at
`packages/core/src/pack-eval-fixtures.ts` — extend it rather than
inlining ad-hoc test data when adding new ranking scenarios.

## Viewer/plugin development

- Viewer UI source is `packages/ui/` and is served by `packages/viewer-server/`.
- OpenCode plugin source is `packages/opencode-plugin/.opencode/plugins/codemem.js`.
- If you change the UI or viewer assets, rebuild first so `packages/viewer-server/static/` is restaged:

```text
pnpm --filter @codemem/ui build
```

- Then restart the viewer if needed:

```text
pnpm run codemem serve restart
```

## Release workflow

Releases are tag-driven (`vX.Y.Z`) and run via `.github/workflows/release.yml`.

Before tagging:

1. Create a release branch and PR. Do not push release changes directly to `main`.
2. Bump the shared version fields listed in `docs/versioning.md`.
3. Regenerate JS artifacts and lockfiles:
   - `pnpm install`
   - `pnpm build`
4. Wait for CI to pass and merge the release PR.
5. Switch to updated `main`, verify `HEAD` is the merged release commit, and confirm the worktree is clean.
6. Tag from `main` and push the tag:

```text
git tag vX.Y.Z
git push origin vX.Y.Z
```

Verify release version alignment before tagging:

```text
pnpm run release:preflight-tag
```

## Docs expectations

- Keep README focused on user onboarding.
- Put advanced operational details in `docs/`.
- If behavior changes, update the related docs in the same PR.
