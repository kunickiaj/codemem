# Merged-main-only release tag preflight

## Context

Codemem's release policy requires tags to be created from the merged `main` commit. The existing preflight also accepts commits reachable only from one remote `release/*` branch, which can allow a release tag to bypass review and merge.

## Design

- Local preflight always checks `HEAD` and requires it to equal `origin/main` HEAD, the current branch to be `main`, and the worktree to be clean. CI-only commit-selection variables cannot redirect this local check.
- CI preflight requires the tagged commit to be reachable from `origin/main`. This preserves valid tag workflows when `main` advances after a tag is pushed.
- Commits that exist only on release or feature branches are rejected in both contexts.
- Node tests create isolated Git repositories and remotes to exercise accepted and rejected histories without touching the developer worktree.

## Consequences

Hotfixes must merge to `main` before tagging. The release workflow no longer treats a `release/*` branch as an alternate publication authority.
