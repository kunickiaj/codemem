# Main and maintenance release tag preflight

## Context

Codemem normally releases from merged `main`, but persistent maintenance lines are required when `main` has advanced to the next incompatible version. Broadly accepting any `release/*` ancestor permits stale or unrelated branch commits to publish, while rejecting every maintenance branch prevents valid patch releases.

## Design

- Require the release tag to equal the aligned package version, then derive the maintenance line: `vX.Y.Z` maps only to `release/X.Y`.
- Local preflight requires `HEAD` to equal either `origin/main` HEAD while on `main`, or the exact matching `origin/release/X.Y` head while on `release/X.Y`. The worktree must be clean.
- CI preflight accepts a tagged commit reachable from `origin/main`, preserving valid tags when `main` advances, or an exact match with the corresponding maintenance branch head.
- Patch-specific release branches, stale maintenance commits, mismatched release lines, tag/package version mismatches, and feature branches are rejected.
- Node tests create isolated Git repositories and remotes to exercise accepted and rejected histories without touching the developer worktree.

## Consequences

Current-line releases still merge to `main`. Older-line hotfixes use one protected, persistent `release/X.Y` publication authority, without pulling incompatible changes from newer lines into a patch release.
