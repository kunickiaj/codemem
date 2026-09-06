# Tiered E2E CI cadence

## Decision

Normal CI will keep fast smoke coverage universal while a dedicated `Full E2E` workflow owns nightly, manual, and labeled pull request execution. This avoids rerunning unrelated required jobs when contributors request specialized coverage without weakening `main` or release validation.

## Behavior

The normal `CI` workflow keeps only pushes to `main`, default pull request events, and release `workflow_call` triggers. Its `E2E Smoke` job runs on every event and keeps its existing GitHub check name, while `Legacy Team Migration`, `Project Sharing`, and `Sharing Domains` run only on non-pull-request events so `main` and release calls still execute all four scenarios.

The dedicated `Full E2E` workflow accepts manual dispatches, runs daily at `03:17 UTC`, and observes pull request opening, reopening, synchronization, labeling, and unlabeling. Nightly and manual runs execute smoke plus all three specialized scenarios; pull request runs skip duplicate smoke and execute the specialized matrix only while the existing `ci:full` label is present.

Each workflow groups pull request runs by pull request number and cancels older in-progress runs. This makes new revisions authoritative in normal CI and lets the dedicated workflow stop stale specialized work after label removal; non-pull-request groups include the workflow run ID and never cancel one another.

The dedicated workflow names its pull request checks `Full E2E Legacy Team Migration`, `Full E2E Project Sharing`, and `Full E2E Sharing Domains`. These checks are advisory and must not be configured as required because unlabeled pull requests intentionally skip them.

## Alternatives

Running all four scenarios in normal CI on every pull request provides maximum immediate coverage but spends substantial CI time on specialized paths. Running only smoke on pull requests is cheaper but gives contributors no opt-in path before merge; the dedicated `ci:full` label gate preserves that path.

Keeping scheduled, manual, and labeled execution in normal CI would rerun TypeScript, lint, worker, and plugin jobs that the E2E request does not need. The dedicated workflow duplicates only E2E job setup and uses distinct advisory check names, while normal CI preserves native required checks and release `workflow_call` behavior.

## Validation

A dependency-free Node test reads both workflow source files and asserts their trigger boundaries, concurrency expressions, exact job names, scenario matrices, and source-level event conditions. The dedicated `test:ci-workflow` command runs from the root `check` path without claiming to simulate GitHub Actions expression evaluation; `git diff --check` guards the focused change against patch formatting errors.
