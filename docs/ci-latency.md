# CI latency evidence report

**Investigation date:** 2026-10-25 UTC  
**Bead:** `codemem-ahjzp`  
**Scope:** Evidence and policy options for reducing CI latency without weakening required checks.

## Decision status

No authoritative test, typecheck, build, or acceptance result reuse is approved.

The repository ruleset requires these checks to be up to date:

| Required check |
| --- |
| TypeScript Test |
| TypeScript Lint |
| Plugin Smoke Test |

The historical aggregate `CI Gate` was removed in PR 1626 (`50e639881`). It should not be restored.

All current CI jobs run in parallel and have no `needs` dependencies. Summing job durations therefore does not measure either wall time or billed runner minutes.

## Evidence boundary

Measurements use read-only GitHub Actions job/step timestamps, logs, checkout commits, and PR timelines. Source audits cover all nine workspaces, root checks, E2E, and Docker. These runs have different test populations; they are not a controlled performance comparison. API timestamps have one-second precision.

The local baseline was `25973990f1db5822f3742c543bdff76d7d0f0eca`; remote `main` was `1103fd2e`.

All five workflows were byte-identical locally and on that remote `main`; `ci.yml` was also identical at each sampled head. The implementation branch later fast-forwarded to `c9a534c56`; its three edited files had no intervening upstream changes.

The public ruleset examined was `24033683`.

Run `headSha` is not necessarily the commit checked out by a pull-request workflow. A merge commit may be checked out instead.

Pull-request associations returned by the API are mutable metadata, not immutable event history.

## Sampled workflow runs

| Run | Outcome | Wall / critical path | Queue delay / runtime | TypeScript Test job | Aggregate runner time |
| --- | --- | ---: | ---: | ---: | ---: |
| 40157301771 | PR | 739 s | 32 s / 707 s | 707 s | 1,576 s |
| 40157236299 | `main` | 486 s | 3 s / 483 s | 483 s | 1,914 s |
| 40156641858 | stack | 941 s | 442 s / 499 s | 499 s | 1,404 s |
| 40156792041 | failing stack | 1,120 s | 360 s / 760 s | 760 s | 1,630 s |

The critical job was TypeScript Test in all four runs. Stack queueing added six to seven minutes before that job started. Reducing redundant runner work may relieve queue pressure, but this sample does not measure that effect.

### Checkout identity

| Run | Event head | Checked-out merge commit | Merge base / parent evidence |
| --- | --- | --- | --- |
| 40157301771 | `42b5cacd` | `2b1be0c2` | parents `4984175c`, `42b5cacd` |
| 40156641858 | `ec7cd4e6` | `88d8f0bf` | base `f0666ddd`; PR 2352 |
| 40156792041 | `890c2392` | `10a6c01a` | base `a730e8af`; PR 2359 |

Runs 40158108758 and 40158109304 used the same PR 2340 head one second apart; one consumed zero runner seconds and the other 575 seconds. They occurred while the head and base changed, then a new-head run followed. This is consistent with PR-number concurrency cancellation, not retries. The originating actions and cancellation actor are unknown.

## Test and job timing

| Measure | PR | `main` | Stack | Failing stack |
| --- | ---: | ---: | ---: | ---: |
| Test step | 668 s | 450 s | 464 s | 723 s |
| Vitest | 658.73 s | 444.16 s | 458.09 s | 714.65 s |
| Build | 14 s | 10 s | 9 s | 14 s |
| Install | 4 s | 4 s | 4 s | 3 s |
| Test files | 782 | 779 | 804 | 804 |
| Passing tests | 26,833 | 26,751 | 27,716 | 27,710 |
| Failed tests | 0 | 0 | 0 | 6 |
| Skipped / todo | 3 / 3 | 3 / 3 | 3 / 3 | 3 / 3 |

The failing run contained six core and two native-worker timeouts at five seconds. The defects were neither fixed nor hidden, and their underlying cause was not proved.

TypeScript Test setup also included 4–7 seconds for pnpm, 7–10 seconds for Node setup including the cache restore, and 2–3 seconds for checkout. The separate TypeScript Check job spent 10–13 seconds checking types.

Lint delta work took 6–13 seconds plus 5–6 seconds for the full lint; the `main` sample lint was 4 seconds. Biome uploads took 1–2 seconds.

The UI Chromium work took 19–28 seconds plus 39–42 seconds of acceptance work. The worker job took 247–272 seconds: native work took 137–204 seconds and Node work 31–34 seconds, with build, binding, and HTTP stages included. The successful PR HTTP stage was 71.78 seconds.

Packaged smoke took 179–228 seconds. In the successful PR, plugin packing took 84.05 seconds, V2 host work took 88.61 seconds, and CLI packing took about 35 seconds. E2E smoke took 60–71 seconds.

CI builds the full workspace in TypeScript Test, Account Browser Acceptance, and Packaged Plugin Smoke. Plugin Smoke performs a fourth full build inside CLI smoke. E2E Docker installation is separate and is not a pnpm workspace build.

## Runtime concentration

The following figures are sums of file durations in successful PR and `main` runs. They are not package wall time, CPU time, or additive savings estimates.

| Area | PR file-duration sum | `main` file-duration sum |
| --- | ---: | ---: |
| Core | 916.60 s | 607.00 s |
| Viewer | 77.56 s | 54.24 s |
| UI | 56.81 s | 43.92 s |
| CLI | 51.87 s | 35.42 s |
| Worker root | 45.42 s | 33.25 s |
| MCP | 17.267 s | 10.847 s |
| Plugin | 14.459 s | 9.960 s |
| E2E unit | 3.609 s | 2.416 s |
| Pi | 0.280 s | 0.177 s |
| Embeddings | 0.083 s | 0.046 s |

Notable individual files were Core `ownership-writer-lifecycle` at 71.38 seconds, viewer `index` at 31.01 seconds, and worker `owner-profile` at 34.06 seconds.

Core test runtime is the largest measured execution target, but whole-suite reuse is blocked by ambient state and elapsed-time assertions.

Examples include `scope-backfill` at 50 ms, store-open at two seconds, and XML work at one second. A `MemoryStore(':memory:')` still reads the profile. Historical runner inputs also include Git archive `ad50a6a4`, frozen hashes, and the currently installed dependencies.

## Current cache evidence

Thirty-five Linux and one Windows executed jobs had primary pnpm cache hits. Install logs reported 761 reused, zero downloaded, and 761 added, followed by Husky.

| Cache observation | Evidence |
| --- | --- |
| Linux entry size | 547,308,439 bytes |
| Windows entry size | 637,929,305 bytes |
| Active entries | 20 / 11.21 GB |
| CodeQL overlays | 18 entries, about 0.55 GB each |
| Configured storage / retention | 10 GB / 7 days |

`setup-node` restores package-store data, not `node_modules` or test results. Its restore also includes store download, so the exact transfer time cannot be separated from the available logs.

The over-capacity snapshot does not prove a configured storage increase or the exact timing of eviction. No task/build cache or task-result restore is configured.

No successful test reports or coverage uploads were found. Console output is the ordinary test record. Biome uploads always; visual and E2E artifacts upload only on failure; packed reports are removed in `finally`. Root coverage is not enabled, so this report does not claim coverage is preserved.

## Candidate eligibility and blockers

Any task-result key would need the common inputs: root manifests, lockfile, workspace catalog/overrides/allowed builds, patches and hook files when present, TypeScript/Vite/Vitest configuration and setup, source and transitive types/scripts, nested npm resolution, schemas and generated test schema, directory membership and migrations, fixtures, Git baseline/harness, an allowlisted environment, and exact Node/pnpm/tool/OS/architecture/native image details.

Never hash a real private home directory as an input. Isolate it before imports.

| Area | Possible reusable work after closure | Current blocker or fresh-policy reason |
| --- | --- | --- |
| Core build, typecheck, schema generation | Candidate | Input closure still required |
| Core whole tests | Not eligible | Ambient home/config/keys, real-time assertions, cross-worker SQL/harnesses, UI/viewer/script/eval dependencies |
| Embeddings build and typecheck | Candidate | Exact dependency closure required |
| Embeddings unit tests | Candidate after offline fix | Tests mock transformers/fetch but inherit `CODEMEM_EMBEDDING_OFFLINE` |
| Embeddings packed runtime | Fresh | Unlocked npm, ONNX, and real model |
| Worker build and typecheck | Candidate | Fixed shared scratch output/environment needed |
| Worker Node/native/binding/native HTTP | Candidate only after closure | Local Miniflare D1, built Core internals, Viewer/Core imports |
| CLI, MCP, Viewer, Pi build/typecheck | Candidate | Chunks, declarations, maps, build info, and executable mode must be complete |
| CLI/Viewer/Pi/plugin unit tests | Not eligible yet | Ambient profiles |
| Plugin declarations | Candidate | Root TypeScript references emit declarations, including test types; there is no package build script and hidden runtime JS is not covered by that compiler project |
| MCP mocked units | Candidate | Transport-worker acceptance stays fresh until isolation |
| UI typechecks | Candidate | Account, health, and visual paths must each be covered |
| UI production build | Special case | Git short SHA changes outputs across same-tree commits; staging leaves obsolete output unless cleaned first |
| Visual tests | Candidate after strict controls | Pinned Playwright 1.63 image, fonts, goldens, locale/timezone, blocked network, and comparator controls required |
| Account browser | Fresh policy | Separate browser bundle, TLS, SQLite, and popup behavior |
| UI gallery build and harness tests | Candidate | Generator, canonical static files, aliases, policy scripts, fonts, and gallery configuration |
| Packed V1/V2/CLI smoke | Fresh | Floating npm dependencies, registry/model/native behavior |
| CLI wrapper tests | Isolation/pinning fix first | Dedicated hidden configuration, Core/native inputs, actual nested SDK resolution; not the ordinary CLI project |
| Installed semantic acceptance | Fresh policy | Offline relocated package/worker execution is distinct from mocked units and online packed inference |
| Root release/adapter/CI Node tests | Candidate | Git preflight fixtures require Git/environment isolation |
| Adapter generation, eval typecheck, owner pilot check | Candidate | Generator source and checked-in outputs; separate eval/pilot TS configurations and tests |
| E2E framework units | Candidate | Mocked Docker execution still reads actual Compose files and the peer Dockerfile |
| Eval, live DB, prompt-path performance, beta tags, release preflight/publish | Fresh | Live or release state |
| Real E2E, fleet, dogfood, owner pilot | Fresh | Stateful coverage |
| Watch/dev, cleanup, visual baseline updates | Fresh operations | Persistent state or explicit mutation, not reusable validation results |

The Worker project selected by root Vitest covers Worker `src`, not its separate native integration configuration. Native HTTP imports Viewer/Core and built Core internals. Do not replace installed semantic acceptance with mocked unit tests.

The native worker's root Vitest work is separate from native integration. Candidate native work must first close the environment and runtime boundary; Miniflare D1 is local, not a live Cloudflare dependency.

UI tests directly read Core SQLite, viewer/browser-proxy paths, and the built Core main export. Production UI output includes the Git short SHA, emits compressed viewer-server static assets, and uses `emptyOutDir: false`; reuse needs a clean staging directory and an explicit commit-stamp exception.

The CLI `.opencode` wrapper has separate configuration and is excluded from regular CLI/root work. Root `.opencode/tests` is a symlink, not a second suite. Plugin root-unit testing intentionally repeats the minimum SDK lane using nested 1.18.29; versions must not be collapsed. The observed nested local version, 1.2.27, differs from manifest 1.19.3, so the manifest is not the actual resolution.

Biome delta caching must include both base SHA and merge SHA, history, and tool policy; the event head tree alone is insufficient.

PR 1610 introduced the historical classifier and aggregate gate; PR 1626 removed them. Keep the current required check names and failure behavior rather than reintroducing an aggregate check. The standalone prompt-path helper tests are not wired into normal CI; that coverage gap is separate from reuse.

### Source evidence for hidden inputs

- `packages/core/src/store.ts` reads configuration even for an in-memory store; `packages/core/src/db.ts` resolves home-based defaults during module initialization. `packages/viewer-server/src/index.test.ts` can reuse an inherited key directory. Isolation must happen before application imports, not only in `beforeEach`.
- `packages/core/src/semantic/semantic-worker-test-fixtures.ts` already supplies disposable profile/key paths, rejects network requests, and injects embeddings while retaining real SQLite/vector work. Reuse that pattern instead of importing private profile contents into keys.
- `packages/core/src/coordinator-auth-link-schema.test.ts` reads Worker schema/migrations; `project-invite-identity.test.ts` imports UI; `memory-ownership-recovery.test.ts` imports a Viewer route. `scripts/eval/run-automatic-recall-baseline.mjs` archives historical source and links current installed dependencies.
- `packages/core/scripts/generate-test-schema.ts` and `src/test-schema.generated.test.ts` distinguish schema-generation inputs from the checked-in generated file. Worker `vitest.config.ts` and `test/apply-migrations.ts` consume migration directory membership and Core upgrade SQL.
- `packages/cloudflare-coordinator-worker/test/qualified-owner-journey-fixture.mjs` bundles Viewer/Core sources; `ownership-writer-cold-restart.native-http.test.mjs` also consumes built Core internals. Native D1 tests are not implied by root workspace Vitest success.
- `packages/ui/vite.config.ts` embeds `git rev-parse --short=7 HEAD`; `scripts/stage-viewer-static.mjs` emits HTML and compression sidecars into Viewer static output. `account-e2e/fixture.ts` builds a separate in-memory browser bundle. Backend E2E scenarios create placeholder static HTML; dogfood instead builds UI independently in peers.
- `packages/ui/src/tabs/my-account-synthetic-e2e.test.tsx` can consume built Core exports. `packages/viewer-server/src/managed-user-mutations.test.ts` imports CLI and MCP. `packages/mcp-server/src/semantic-worker-transport.test.ts` exercises real worker transport with isolated, injected embeddings.
- `packages/pi-extension/src/config.ts` reads global environment during config resolution; `index.ts` can read global Pi configuration. `packages/embeddings/src/index.test.ts` mocks the pipeline and hub fetch but does not normalize inherited offline mode.
- Random temporary names, RSA keys, and event identifiers usually ensure uniqueness rather than select random assertions. Worker `test/browser-auth-binding-lifetime.test.mjs` accepts the valid range of scheduling outcomes. Conversely, Core `scope-backfill.test.ts` and plugin `biome-glob.test.ts` contain real elapsed-time assertions; caching those passes would not measure a new runner.
- `packages/opencode-plugin/scripts/packed-artifact-smoke.mjs` installs floating `@types/node@24`; packed embedding/CLI scripts perform real native inference. Their external dependency graph differs from the frozen workspace install.

## Docker observations

The E2E Docker peer uses a single `node:24-bookworm-slim` stage and copies root files, every package, E2E files, scripts, and docs before installation. Any source change can therefore invalidate the install layer.

There is no `.dockerignore`, cache exporter, or cache mount. Local and private files under `packages` can enter the build context.

Before adding a remote cache exporter, review context exclusions and create a manifest-only install boundary. The deploy Dockerfile's registry install is not a repository build. `mode=max` matters only if export or additional stages are added; current intermediate-cache timing is unavailable.

Deterministic E2E compose project names can collide locally, and seed loading hardcodes a database path. Those findings are outside this latency change.

## pnpm pipeline probe

The official pnpm pipeline feature is present and experimental. It was introduced in pnpm 12.4, remote support arrived in 12.12, and installed pnpm 12.15 help was checked.

`pnpm -r run` does not cache. A pipeline task needs an `outputs` declaration to allow result caching, including `outputs: []` for a file-free result. `env` is hashed, and `dependsOn: ['^build']` must be explicit when configuring a task that needs it. Dependencies do not widen `--filter` selection, and the workspace root is excluded unless enabled.

`pnpm pipeline --full --no-cache` is a fresh-run control. TypeScript incremental build info is not a test verdict. Vitest filesystem cache is not a success cache, and blob reporting merges reports rather than acting as a cache engine.

An ignored synthetic workspace, pinned to pnpm 12.15 and Node 24.22.1, produced these probe results:

| Probe | Result |
| --- | --- |
| Cold | 207 ms; 3 executions |
| Warm | 165 ms; 3 cache hits |
| Same tree, different commit | 196 ms; 3 cache hits |
| Changed A | 249 ms; A and B executed; C hit |
| Affected selection | 182 ms; A/B hit |
| Shared-input failure | With `inputs: ['src/**', '../../shared.json', '../../task.mjs']`, changing the root shared file left stale replay at 182 ms |

The cause is confirmed in pinned pnpm 12.15.0 source: it enumerates files with Git inside each project, then filters those paths with `inputs`. Out-of-project globs cannot add root or sibling files to that enumeration. A symlink hashes its target path, not target contents. Contrary to the documentation's tracked-file wording, untracked, unignored project files also enter the key. There is no global-file input or project-specific task override in this version.

A follow-up supplied an external SHA-256 digest of shared file bytes and workspace configuration through a declared environment input. That workaround invalidated all three tasks when shared bytes changed (218 ms); a later A-only change reran A/B while C reused (213 ms). A lockfile-only change invalidated all three (228 ms). This is a tested input bridge, not an approved production design or a new cache engine.

Missing working outputs restored without execution (171 ms). Missing/corrupt cache outputs or metadata reran the affected task (169–183 ms), while unrelated tasks reused. Damaged cache directories were not repaired automatically; attempts to publish warned that the directory was not empty. Mixed execution preserved reports, artifacts, and task-authored original execution timestamps.

Setting cache mtimes to 2000 still reused every result (153 ms). Native metadata has no original-execution timestamp or TTL. Run summaries do not identify hits; the event stream does. Replay-event timestamps are not original execution times. A forced full no-cache run with an injected failure exited 1: A failed, its dependent B skipped, and independent C ran fresh. Older working output files survived that failure, so file existence is not successful fresh evidence. Pinned source writes cache entries only after success.

The harness initially expected `failed` instead of native `failure`. After correcting that assertion, post-failure recovery hit all three entries without executing tasks (204 ms); restored reports/artifacts retained their pre-failure bytes and original execution times. All 48 cache files were byte-identical across recovery. The earlier whole-cache pre-failure snapshot was memory-only and was unavailable for an exact historical comparison; this is not a claim that every cache byte was compared across the failure. No formal raw coverage was collected in these synthetic probes.

These synthetic results are not repository timings or GitHub Actions validation.

## Proposed policy, pending approval

This is a proposal, not an implementation or approval.

1. Run full workflows fresh on `main` and release paths; consider reuse only for PRs.
2. Key reuse to the checked-out tree and actual inputs, not event commit/head identity.
3. Require a changed-tree closure across every qualifying task; keep the UI commit-stamp exception explicit.
4. Reuse only complete successful evidence. Missing, corrupt, expired, incompatible, or uncertain records run fresh.
5. Never replace a fresh failure with a reused result.
6. Preserve original `executedAt` with a fixed proposed 24-hour TTL; do not renew it on reuse.
7. Record producer workflow/run, toolchain, input key, coverage, report digests, and whether each consumed result is fresh or reused.
8. Collect and merge raw coverage plus source maps at the consuming commit; do not invent current coverage.
9. Make the native fresh control use `--full --no-cache` plus a workflow-level control external to pnpm.

GitHub cache entries are immutable; caches written by PR runs are merge-ref scoped. PRs can read accessible base/default-branch caches, not sibling PR caches. Fork secrets must never be exposed to PR code. Concurrent misses may duplicate work before one producer saves an entry; they cannot overwrite it. Seven-day inactivity eviction applies. A cache hash is not producer identity.

Prefer maintained pnpm-native behavior after the shared-input bridge, freshness evidence, and producer trust pass validation. A remote signed publisher secret must not reach PR code. Adding a server, secret, or permissions requires separate approval. Do not use `pull_request_target` to execute untrusted PR code. No Nx or Turbo dependency is needed solely for caching.

Batch all qualifying projects only after the full audit, rather than piloting a serial tiny project. Document explicit exceptions.

## Implemented low-risk delta

A separate three-file change adds `plugin test:packed-artifact:prepared`, which directly invokes the existing smoke test after the normal full build prepares the artifact. The default command still builds the CLI; only the CI packed lane invokes the prepared command.

It does not skip acceptance, tests, typechecking, or cross-run results. Workflow tests went from 18 passing / 2 failing to 20 / 20 passing; scoped fix/Biome checks passed for two supported files (YAML is unsupported), and the diff check passed. A new lint warning was fixed by changing the test shape.

Full host smoke and GitHub Actions execution have not run. The avoided extra CLI compile is estimated at about one second, based on an ordinary CLI build span of 0.5–1.1 seconds. No critical-path improvement was observed.

Whole-workspace test reuse has an upper bound of the sampled 658-second PR Vitest time; worker runner capacity has an upper bound near 251 seconds. Neither is a promised saving. After test reuse, packaging or worker work could become the next critical path. A shared-build producer can cost more than its 9–15 second build time through transfer and serialization.

## Required validation before authoritative reuse

Real GitHub Actions cold, warm, changed-tree, and fresh-control runs are not complete. They are blocked on input closure, freshness/trust fixes, and approval.

Acceptance criteria for any proposal should include preserved test reports, a coverage matrix, and no accepted waiver for required checks.

The producer trust model and external-cache option need review against GitHub-local cache state. GitHub cache alone cannot share results between sibling stack PRs.

## References

- [pnpm pipeline](https://pnpm.io/cli/pipeline)
- [pnpm workspace task orchestration](https://pnpm.io/workspace-task-orchestration)
- [Pinned pnpm 12.15.0 input enumeration](https://github.com/pnpm/pnpm/blob/v12.15.0/pnpm/crates/cli/src/cli_args/pipeline/cache/inputs.rs)
- [pnpm filtering](https://pnpm.io/filtering)
- [GitHub Actions dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
- [Pull request workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)
- [`actions/setup-node` cache behavior](https://github.com/actions/setup-node#caching-global-packages-data)
- [Docker GitHub Actions cache backend](https://docs.docker.com/build/cache/backends/gha/)
- [TypeScript incremental builds](https://www.typescriptlang.org/tsconfig/incremental.html)
