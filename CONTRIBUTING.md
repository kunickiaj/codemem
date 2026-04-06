# Contributing to codemem

Thanks for helping improve codemem.

## Local setup

```text
pnpm install
pnpm run codemem --help
```

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
pnpm vitest run packages/cli/src/commands/serve.test.ts
pnpm vitest run packages/viewer-server/src/index.test.ts
pnpm vitest run packages/core/src/index.test.ts
```

## Viewer/plugin development

- Viewer UI source is `packages/ui/` and is served by `packages/viewer-server/`.
- OpenCode plugin source is `packages/opencode-plugin/.opencode/plugins/codemem.js`.
- Restart the viewer after UI changes:

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
