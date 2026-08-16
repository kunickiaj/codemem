# Adapter interoperability and prompt transport parity: implementation plan

**Design:** [Adapter interoperability and prompt transport parity](./2026-08-15-adapter-interoperability-and-prompt-transport-design.md)
**Tracking:** `codemem-2b06`
**Status:** Approved for implementation
**Date:** 2026-08-15

## Outcome

Claude Code, Codex, and OpenCode will share:

- one source-aware normalized event ingress at `POST /api/raw-events`;
- one route-independent core ingestion service for HTTP, direct fallback, and
  spool replay;
- one prompt-pack profile, retrieval, fallback-classification, and delivery-ledger
  contract;
- source-specific edge normalizers and host output formats;
- zero `codemem` or `npx` children on healthy prompt paths.

The existing `/api/claude-hooks` and `/api/codex-hooks` routes remain temporary
compatibility adapters. Human-facing CLI cleanup is a separate workstream and is
not allowed to destabilize transport parity.

## Non-negotiable contracts

1. HTTP request data must not expand the Viewer's filesystem authority.
2. Event identity and first-event sequence `0` must match across HTTP, direct
   fallback, and spool replay.
3. Database/runtime identity mismatch must never read from the mismatched Viewer;
   classified local fallback may use the intended local configuration.
4. A compatible profile followed by `viewer_contract_unsupported` fails closed.
   Missing or non-overlapping protocol support may fall back.
5. Pack retrieval and delivery reporting remain separate. Ledger failure cannot
   delay host output or turn an unknown delivery into a claimed handoff.
6. New plugin artifacts must work without a globally installed CLI while the
   Viewer is healthy.
7. Existing host-specific output bytes remain compatible.

## Proposed Graphite stack

```text
main
  <- PR 1: harden bounded transcript reads
  <- PR 2: add canonical raw-event ingestion service
  <- PR 3: make normalized HTTP ingress source-aware
  <- PR 4: generate and ship edge normalizers
  <- PR 5: unify prompt transport profile and classification
  <- PR 6: move Claude prompt transport to direct Viewer HTTP
  <- PR 7: move Codex prompt transport to direct Viewer HTTP
  <- PR 8: prove packaged parity and update documentation
```

Each PR must be independently testable. Do not combine CLI command-tree cleanup
with this stack.

## PR 1: Harden bounded transcript reads

### Purpose

Remove arbitrary Viewer-side file reads before retaining legacy native-hook
routes, without regressing Stop-event transcript capture.

### Files

- Add `packages/core/src/hook-transcript.ts`.
- Update `packages/core/src/api-types.ts`.
- Update `packages/core/src/claude-hooks.ts`.
- Update `packages/core/src/codex-hooks.ts`.
- Update `packages/core/src/claude-hooks.test.ts`.
- Update `packages/core/src/codex-hooks.test.ts`.
- Update `packages/viewer-server/src/routes/raw-events.ts`.
- Update `packages/viewer-server/src/index.test.ts`.

### Steps

1. Before changing code, validate current host behavior with synthetic sessions:
   - Claude default and `CLAUDE_CONFIG_DIR` transcript locations;
   - Codex default and `CODEX_HOME` session locations;
   - whether each host supplies absolute or relative `transcript_path` values.
   Record only generic conclusions in the repository; no local paths or session
   content.
   Verified on 2026-08-15: Claude Code 2.1.207 and Codex CLI 0.147.0 both emit
   absolute `transcript_path` and `cwd` values beneath their configured roots;
   `CLAUDE_CONFIG_DIR` and `CODEX_HOME` relocate transcript persistence.
2. Extract a transcript reader with explicit dependencies:
   - approved realpath roots supplied by the caller;
   - optional real `cwd` for relative paths from trusted hook-edge callers;
   - a 16 MiB tail-read limit;
   - JSONL alignment to the next complete record;
   - symlink resolution before containment checks;
   - benign failure semantics and fixed, path-free legacy HTTP skip reasons.
3. Edge callers may pass the exact host-provided path as trusted input. Legacy
   HTTP routes accept only absolute paths beneath verified default/configured
   roots; they reject relative paths so request-controlled `cwd` cannot become a
   filesystem root.
4. Preserve assistant text and usage extraction. A rejected transcript produces a
   benign skip, never a hook failure.

### Tests

- Absolute paths under each approved root succeed.
- Relative paths under real `cwd` succeed only for trusted edge callers and are
  rejected by restricted legacy HTTP callers.
- Traversal, sibling-prefix, symlink escape, non-file, missing file, and
  oversized-line cases fail safely.
- A transcript larger than 16 MiB still finds a final complete assistant record.
- Existing Claude and Codex transcript fixtures pass with explicit temporary test
  roots.

```text
pnpm exec vitest run packages/core/src/claude-hooks.test.ts packages/core/src/codex-hooks.test.ts
pnpm exec vitest run packages/viewer-server/src/index.test.ts
```

### Rollback

The extracted reader can be reverted without changing event or HTTP schemas. Do
not relax containment to recover capture; add a verified configured root instead.

## PR 2: Add canonical raw-event ingestion service

### Purpose

Put validation, sanitization, deduplication, sequencing, session metadata, and
ingestion outcomes behind one core API.

### Files

- Add `packages/core/src/raw-event-ingest.ts`.
- Add `packages/core/src/raw-event-ingest.test.ts`.
- Update `packages/core/src/store.ts` only where a narrower store primitive is
  required.
- Update `packages/core/src/index.ts` exports.
- Update `packages/cli/src/commands/enqueue-raw-event.ts`.
- Add `packages/cli/src/commands/enqueue-raw-event.test.ts`.
- Update `packages/cli/src/commands/claude-hook-ingest.ts`.
- Update `packages/cli/src/commands/codex-hook-ingest.ts`.
- Update their existing test files.

### Steps

1. Define a source-aware normalized request type and a single
   `{ inserted, skipped, received }` result.
2. Validate source syntax and length as provenance only; source grants no trust.
3. Normalize aliases for stream/session identity and reject conflicting values.
4. Strip private fields before persistence.
5. Deduplicate by `(source, stream_id, event_id)`.
6. Allocate a fresh stream's first sequence as `0`; keep supplied valid sequence
   semantics where the normalized contract permits them.
7. Update session metadata and return the session/source pairs that need a sweeper
   nudge without importing Viewer concerns into core.
8. Replace the Claude `COALESCE(MAX(event_seq), 0) + 1`, Codex direct SQL, and
   `enqueue-raw-event`'s OpenCode-only writes with calls to the service.

### Tests

- HTTP-equivalent, direct, and replayed requests produce identical rows.
- Duplicate retries report `skipped` without allocating another sequence.
- Claude and Codex first events both receive sequence `0`.
- Conflicting session aliases and malformed source/event fields fail before writes.
- Private fields never reach persisted payload JSON.

```text
pnpm exec vitest run packages/core/src/raw-event-ingest.test.ts
pnpm exec vitest run packages/cli/src/commands/claude-hook-ingest.test.ts packages/cli/src/commands/codex-hook-ingest.test.ts
```

### Rollback

Keep store schema unchanged. The old callers can be restored while the service
remains unused; do not maintain two SQL implementations after cutover.

## PR 3: Make normalized HTTP ingress source-aware

### Purpose

Make `POST /api/raw-events` the canonical source-neutral wire contract and reduce
named routes to compatibility adapters.

### Files

- Update `packages/viewer-server/src/routes/raw-events.ts`.
- Update `packages/viewer-server/src/index.test.ts`.
- Update `docs/plans/adapter-event-v1.schema.json` only for clarified metadata,
  not a breaking top-level field.

### Steps

1. Parse and validate top-level `source`; default omitted source to `opencode`
   during compatibility.
2. Delegate single and batch requests to the core ingestion service.
3. Nudge the sweeper with the validated source returned by the service.
4. Keep response shape `{ inserted, skipped, received }`.
5. Keep `/api/claude-hooks` and `/api/codex-hooks`, but make each route:
   - parse a bounded native payload;
   - invoke its hardened legacy normalizer;
   - pass only normalized output to the canonical service;
   - contain no persistence, sequence, or metadata SQL.

### Tests

- Omitted source preserves current OpenCode behavior.
- Claude, Codex, and OpenCode sources remain separate for identical stream IDs.
- Canonical and named compatibility routes produce identical normalized rows.
- Mixed-source batches are either explicitly rejected or split according to the
  final request schema; behavior must be deterministic and documented.
- Invalid source, body size, and native payload errors are bounded.

```text
pnpm exec vitest run packages/viewer-server/src/index.test.ts
pnpm exec vitest run packages/core/src/raw-event-sweeper.test.ts
```

### Rollback

The `opencode` default preserves old clients. Retain named aliases if generated
edge artifacts reveal version-skew defects; do not restore duplicated writes.

## PR 4: Generate and ship edge normalizers

### Purpose

Move native hook interpretation and trusted transcript access to standalone
plugin artifacts while preserving one authored TypeScript implementation.

### Files

- Update `packages/core/src/claude-hooks.ts` and `codex-hooks.ts` as the authored
  normalizer sources.
- Update `packages/core/src/claude-hooks.test.ts` and `codex-hooks.test.ts` with
  frozen golden fixtures.
- Add `scripts/build-adapter-normalizers.mjs`.
- Add `scripts/build-adapter-normalizers.test.mjs`.
- Add generated, dependency-free artifacts under:
  - `plugins/claude/scripts/codemem-normalizer.mjs`;
  - `plugins/codex/scripts/codemem-normalizer.mjs`.
- Replace `plugins/claude/scripts/ingest-hook.sh` with a Node/ESM ingest wrapper.
- Update `plugins/codex/scripts/ingest-hook.mjs`.
- Update `plugins/claude/hooks/hooks.json` if script names change.
- Update `packages/cli/scripts/packed-artifact-smoke.mjs`.

### Steps

1. Freeze `meta.event_id_algo` as `claude/1` and `codex/1`. Keep it under `meta`
   so AdapterEvent v1's closed top-level schema remains valid.
2. State and test that OpenCode's client-assigned random event IDs are exempt from
   derived-ID algorithms.
3. Bundle each normalizer to one checked-in ESM artifact with Node built-ins only.
4. Add a drift test that regenerates in a temporary directory and compares bytes
   with checked-in artifacts.
5. Make plugin wrappers normalize once, then send that exact envelope to
   `/api/raw-events`.
6. On retryable HTTP failure, send the same normalized envelope through
   `enqueue-raw-event` or spool it. Never remap the native payload during fallback.
7. Preserve Codex timestamp/nonce generation before normalization.

### Tests

- Core and generated mappers produce byte-identical envelopes for golden Claude
  and Codex fixtures.
- Timestamp-less retries, unknown fields, tool failures/results, transcript
  fallback, and nonce behavior preserve IDs.
- HTTP, CLI fallback, and spool replay use the same event ID.
- Generated artifacts import without workspace dependencies.

```text
pnpm exec vitest run packages/core/src/claude-hooks.test.ts packages/core/src/codex-hooks.test.ts
node --test scripts/build-adapter-normalizers.test.mjs
pnpm --filter codemem test:packed-artifact
```

### Rollback

Old packaged clients continue using named routes. A new plugin can temporarily
return to a named route, but must keep its normalized fallback artifact and must
not reintroduce Viewer-side unrestricted transcript reads.

## PR 5: Unify prompt transport profile and classification

### Purpose

Give every adapter one version-skew, identity, request, and retry classifier
before Claude and Codex adopt direct prompt HTTP.

### Files

- Add `packages/core/src/prompt-transport.ts`.
- Add `packages/core/src/prompt-transport.test.ts`.
- Update `packages/core/src/index.ts`.
- Update `packages/viewer-server/src/routes/pack.ts`.
- Update `packages/viewer-server/src/index.test.ts`.
- Update `packages/opencode-plugin/.opencode/plugins/codemem.js`.
- Update `packages/cli/.opencode/tests/plugin-injection.test.js` and
  `plugin-injection-failures.test.js`.

### Steps

1. Extend `/api/prompt-pack-profile` with
   `min_supported_protocol_version` while preserving `protocol_version`.
2. Define pure helpers for compatible-range checks and terminal versus fallback
   failure classification.
3. Require profile/database/runtime identity validation before pack retrieval.
4. Classify:
   - absent/non-overlapping profile, timeout, reset, and restart as fallback;
   - database/runtime mismatch as local fallback without retrying that Viewer;
   - invalid request, policy/auth failure, and
     `viewer_contract_unsupported` after a compatible profile as terminal.
5. Update OpenCode to consume a supported range instead of literal protocol `1`
   and stop treating every contract 409 as retryable.

### Tests

- Old client/new Viewer and new client/old Viewer profile matrices.
- Compatible profile plus contract 409 fails closed.
- Identity mismatch invokes local fallback once and never reads the Viewer pack.
- Terminal failures do not start a CLI child.
- Existing OpenCode injection bytes and healthy zero-child behavior remain stable.

```text
pnpm exec vitest run packages/core/src/prompt-transport.test.ts packages/viewer-server/src/index.test.ts
pnpm --filter codemem test:plugin
```

### Rollback

Profile fields are additive. Reverting the OpenCode client leaves the server
compatible; do not remove the minimum-supported field once Claude/Codex ship.

## PR 6: Move Claude prompt transport to direct Viewer HTTP

### Purpose

Replace Claude's shell/CLI healthy path with a dependency-free Node hook that
retrieves packs and records delivery directly.

### Files

- Add `plugins/claude/scripts/user-prompt-hook.mjs`.
- Update `plugins/claude/hooks/hooks.json`.
- Retire `plugins/claude/scripts/user-prompt-hook.sh` only after packaged tests use
  the Node entrypoint.
- Update `packages/cli/src/commands/claude-hook-inject.ts` as compatibility
  fallback, not the healthy transport.
- Update `packages/cli/src/commands/claude-hook-inject.test.ts` and
  `claude-hook-inject.contract.test.ts`.
- Extend packed-plugin smoke coverage under `packages/cli/scripts/` or the CLI
  plugin test suite.

### Steps

1. Preserve Claude session-state query construction, working-set paths,
   truncation, and `hookSpecificOutput.additionalContext` bytes.
2. Probe the profile and send identity-gated `POST /api/pack` first.
3. Include attempt metadata so Viewer retrieval artifacts remain attributable.
4. Write host output before awaiting ledger completion.
5. Bound `POST /api/prompt-pack-ledger` to 500 ms, never retry inline, and leave
   delivery truth unknown on timeout/failure.
6. Start `codemem claude-hook-inject` or pinned `npx` only for classified local
   fallback.
7. Keep fire-and-forget event ingestion independent of pack delivery.

### Tests

- Healthy delivered, empty, skipped, cached, and failed states reach the ledger.
- Healthy path starts no `codemem`, `npx`, or shell helper child.
- Retryable failure starts exactly one fallback chain.
- Terminal failure starts no fallback.
- Hook output is byte-compatible with current Claude contract fixtures.
- Ledger timeout does not delay output beyond its bound.

```text
pnpm exec vitest run packages/cli/src/commands/claude-hook-inject.test.ts packages/cli/src/commands/claude-hook-inject.contract.test.ts
pnpm --filter codemem test:packed-artifact
```

### Rollback

Restore the shell entrypoint and CLI fallback while leaving Viewer profile and
ledger APIs intact. Do not roll back to unauthenticated `GET /api/pack`.

## PR 7: Move Codex prompt transport to direct Viewer HTTP

### Purpose

Apply the same direct profile/pack/ledger transport to Codex while preserving its
lean query and explicit memory-context framing.

### Files

- Update `plugins/codex/scripts/user-prompt-hook.mjs`.
- Update `packages/cli/src/commands/codex-hook-inject.ts` as compatibility
  fallback.
- Update `packages/cli/src/commands/codex-hook-inject.test.ts`.
- Extend packed-plugin smoke coverage.

### Steps

1. Preserve Codex's prompt-plus-project query, context header, truncation, and
   output JSON.
2. Reuse the same profile range and failure classifier as Claude/OpenCode.
3. Retrieve with identity-gated `POST /api/pack` before local CLI fallback.
4. Emit host output independently from the 500 ms best-effort ledger call.
5. Keep detached event ingestion/spooling separate from prompt retrieval.

### Tests

- Same delivery-state, classifier, zero-child, and ledger-bound matrix as Claude.
- Codex context framing remains byte-compatible.
- Detached ingestion cannot contaminate prompt-path subprocess accounting.
- A stale Viewer falls back once; a compatible contract defect fails closed.

```text
pnpm exec vitest run packages/cli/src/commands/codex-hook-inject.test.ts packages/cli/src/commands/codex-hook-ingest.test.ts
pnpm --filter codemem test:packed-artifact
```

### Rollback

Restore CLI injection fallback as the primary path without changing normalized
event ingestion or removing compatibility APIs.

## PR 8: Prove packaged parity and update documentation

### Purpose

Demonstrate behavior under real packaging/version skew and update every affected
operator surface.

### Files

- Update `README.md`.
- Update `docs/architecture.md`.
- Update `docs/plugin-reference.md`.
- Update any affected package smoke/evidence scripts.
- Update `scripts/release-version.mjs` and its test only if generated artifact
  packaging/version checks require it.

### Evidence

1. Run packaged Claude and Codex plugins without a global `codemem` binary against
   a healthy Viewer.
2. Run stale-client/new-Viewer and new-client/stale-Viewer matrices for:
   - normalized event ingestion;
   - profile/pack retrieval;
   - delivery ledger;
   - classified fallback.
3. Run 30 repetitions for direct CLI, healthy Viewer, and classified fallback.
   Report median, p95, and phase-isolated child counts with privacy-safe fixtures.
4. Verify healthy prompt paths have zero `codemem`/`npx` children.
5. Search repository and packed artifacts for named-route callers. Record results
   but do not remove aliases until evidence remains clean through the compatibility
   window.

### Validation

```text
pnpm run check
pnpm run build
pnpm --filter codemem test:packed-artifact
pnpm --filter @codemem/opencode-plugin test:packed-artifact
CODEMEM_E2E_BUILD=1 CODEMEM_E2E_JSON=1 pnpm run e2e:smoke -- --json
```

Generated files under `packages/viewer-server/static/` and evidence under `.tmp/`
must remain untracked.

## Separate workstream: CLI plumbing cleanup

Start only after the parity stack is stable. Use the existing CLI cleanup design
and `docs/cli-design-conventions.md`.

Likely files:

- `packages/cli/src/command-tree.ts`;
- `packages/cli/src/command-tree.test.ts`;
- completion/help tests;
- `docs/cli-design-conventions.md` and command reference documentation.

Scope:

- classify `claude-hook-*`, `codex-hook-*`, `enqueue-raw-event`, and
  `prompt-pack-ledger` as adapter plumbing;
- hide plumbing from human help/completion where compatibility permits;
- retain stdin/stdout and exit-code contracts while shipped plugins may call them;
- remove commands and named HTTP aliases only after repository, packaged-artifact,
  and stale-client evidence shows no callers.

This work gets its own Bead and Graphite stack. It is not PR 9 of the transport
stack.

## Dependency order

```text
PR 1 transcript safety
  -> PR 3 legacy route retention

PR 2 canonical ingestion
  -> PR 3 source-aware HTTP
  -> PR 4 generated edge normalizers

PR 5 prompt profile/classifier
  -> PR 6 Claude prompt transport
  -> PR 7 Codex prompt transport

PRs 4, 6, and 7
  -> PR 8 packaged evidence and docs
```

PR 1 and PR 2 may be developed independently but should remain separate review
units. PR 5 may proceed beside PR 4 after PR 2's exported contracts stabilize.

## Review gates

- PRs 1, 3, 4, 5, 6, and 7 are medium/high risk because they touch filesystem
  trust, compatibility, plugin packaging, or delivery truth. Require
  `CodeReviewer` after self-review.
- Run `code-quality-pragmatist` on PR 4 or PR 5 if generated artifacts and shared
  transport abstractions begin duplicating policy or growing a framework.
- Run Snyk Code on changed TypeScript/JavaScript paths before final stack
  submission because the work changes filesystem and HTTP trust boundaries.
- Do not submit a stack with generated artifact drift, tracked private evidence,
  or a failing focused/full gate.

## Stop conditions

- Host transcript roots cannot be verified safely.
- A normalized event changes ID between healthy and fallback paths.
- A first event receives sequence `1` on any path.
- A compatible contract error falls back silently.
- Ledger completion delays host output or claims delivery without adapter evidence.
- Packaged plugins require workspace modules or a global CLI on the healthy path.
- Compatibility requires restoring arbitrary Viewer-side transcript reads.
