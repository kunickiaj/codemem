# Contributing to codemem

Thanks for helping improve codemem.

## Local setup

```text
pnpm install
pnpm run codemem --help
```

This repo is TypeScript-first. The legacy Python runtime has been removed from `main`; use git history or the archive ref if you need to inspect the old implementation.

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

## Stacked-PR CI

CI keeps Graphite stacks fast without weakening the required aggregate gate.

- Full CI runs for non-docs PRs targeting `main`, pushes to `main`, and PRs labeled `ci:full`.
- PRs targeting another PR branch and docs-only PRs may skip expensive jobs. Docs-only PRs targeting `main` can pass the aggregate gate without those jobs.
- A PR targeting another PR branch remains blocked by **CI Gate** until it targets `main` and completes full CI. The `ci:full` label runs every job but does not remove this merge-target block. This prevents a result for the same commit from authorizing a merge after retargeting.
- If GitHub cannot determine the PR topology from GitHub-native metadata, the classifier fails open and runs full CI. **CI Gate** checks the event's base branch independently, so classifier failures cannot bypass the merge-target block. GitHub does not expose Graphite stack metadata, so topology is inferred rather than trusted.
- The classifier and aggregate gate execute scripts from the repository's default branch, not PR-controlled copies. Keep their implementations in the unconditional gate foundation when changing this workflow.

Repository branch protection must require **CI Gate**, not the conditional job checks, and must enable **Require branches to be up to date before merging**. A stacked PR's reduced gate fails intentionally, so an earlier result cannot authorize the same commit after it is retargeted to `main`. The retargeted PR must receive a new successful gate from a full CI run, and strict branch protection also requires it to be current with `main`.

Deployment order matters. Before merging this workflow, repository administrators must replace the existing required job contexts with **CI Gate**, confirm **Require branches to be up to date before merging** is enabled in the GitHub branch-protection settings, and create the `ci:full` label. The pull-request workflow reports **CI Gate** before this migration, so it is available as a required context. This repository change does not alter live settings.

The workflow also supports full CI for GitHub `merge_group` events if the repository later moves to an organization account that supports merge queues.

Add `ci:full` in the pull request's **Labels** menu when the change needs full CI despite its position or files. For example, apply it to a docs-only PR that changes release instructions:

```text
Labels → ci:full
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

Verify release version alignment and tag safety before tagging:

```text
pnpm run release:version -- check
pnpm run release:preflight-tag
```

## Docs expectations

- Keep README focused on user onboarding.
- Put advanced operational details in `docs/`.
- If behavior changes, update the related docs in the same PR.
