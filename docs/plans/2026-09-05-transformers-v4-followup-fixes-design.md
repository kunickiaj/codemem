# Transformers.js v4 Follow-up Fixes

**Status:** Approved

**Date:** 2026-09-05

**Tracking:** `codemem-6ve5`, `codemem-3msb`, `codemem-1gyo`, `codemem-jgn2`, `codemem-sfz8`, `codemem-g7yf`

## Decision

The follow-up work will ship as seven small implementation pull requests ordered by install integrity, vector correctness, offline compatibility, and cleanup performance.

1. Pin the `@codemem` npm scope during explicit CLI updates.
2. Preserve the Linux ONNX Runtime install guard during plugin auto-updates.
3. Validate injected embedding client identity before backfill inference or writes.
4. Persist requested-to-canonical identity metadata after inline vector writes.
5. Retain queued vector upserts whose current target coverage is incomplete.
6. Let cached custom models use an explicit commit identity without a network lookup when Codemem offline mode is enabled.
7. Avoid repeating full-corpus vector validation between bounded stale-row cleanup batches.

Each pull request owns its regression tests and can merge in stack order. The two updater fixes share one bead but remain separate pull requests because they change different execution surfaces.

## Install Behavior

Update commands will preserve the public-package and CPU-only contracts without changing user-owned configuration.

- Explicit CLI updates pass both `--registry=https://registry.npmjs.org/` and `--@codemem:registry=https://registry.npmjs.org/` in POSIX and Windows command forms.
- Linux plugin auto-updates add `ONNXRUNTIME_NODE_INSTALL=skip` to the child environment while preserving existing variables. Other platforms retain the current environment behavior.

## Embedding Identity Behavior

Every vector-producing path will use and record one internally consistent runtime identity.

- A shared validator checks the embedding package, model, revision shape, dtype, device, mean pooling, L2 normalization, dimensions, and consistency between client fields and identity fields.
- Factory-created clients retain checks against the requested model and revision.
- Injected backfill clients fail before inference when their public fields disagree with their identity.
- Successful inline writes persist the requested model, requested revision, and canonical target label through the existing vector identity maintenance record in the same transaction as the vector rows.

The identity record is written only after vectors are inserted or confirmed present. Dry runs and no-op calls do not claim a persisted identity.

## Queue and Cleanup Behavior

Migration bookkeeping will treat current database coverage as the source of truth.

- After queued backfill and stale-row pruning, only memory IDs with complete current target coverage leave the durable upsert queue.
- IDs changed or redacted during asynchronous inference remain queued for another pass.
- A completed cleanup records that target pruning and coverage validation succeeded for the current mutation snapshot.
- Within one runner tick, stale-model deletion batches retain the same SQLite connection and reuse the validated phase only while its database mutation fence remains unchanged.
- After each isolated stale-model deletion batch, cleanup advances its in-memory fence to include that batch and its progress write. This prevents cleanup's own writes from repeating full validation while same-connection or concurrent unrelated mutations still pause the pass.
- A shutdown or interruption discards that connection-local fence. The next tick opens a new connection and repeats target pruning and coverage validation before deleting more stale rows; a reconnect regression covers an intervening memory mutation.

This keeps shutdown work bounded without weakening cutover checks.

## Offline Commit Pins

A lowercase 40-character hexadecimal revision is accepted as an explicit commit identity before cache lookup when `CODEMEM_EMBEDDING_OFFLINE=1`. Codemem maps that setting to Transformers.js' `allowRemoteModels=false`, permitting cached custom commits to load without canonicalization or model-download requests while other revision forms retain the existing fail-closed behavior.

Core, viewer-server, the OpenCode plugin, and the packaged dependency-free Claude and Codex adapters include the same normalized offline flag. Their parity tests and packed-artifact smoke fixtures cover the complete identity-target shape.

A caller in offline mode therefore rejects an already-running viewer with an online identity before sending prompt content. Because a healthy viewer already owns the configured endpoint, the caller uses the local CLI fallback; this change does not start or reconnect to a second viewer with a matching identity.

When remote access is enabled, custom Hub revisions always require canonicalization because a branch or tag can itself have a 40-character hexadecimal name. Local model identities and the built-in model's known pinned revision do not require a network lookup.

## Error Handling

The fixes fail before side effects when embedding identity cannot be proven.

- Invalid embedding identities throw typed validation errors before inference and writes.
- Queue processing retains uncertain work rather than reporting completion.
- Cleanup clears its validated phase when the database mutation snapshot changes.

## Validation

Each layer runs the smallest focused test file plus TypeScript and formatting checks for touched paths.

The stack tip runs the serial repository gate:

```text
pnpm run tsc && pnpm run lint && pnpm run test
```

Stack review checks each pull request as an independent diff and verifies that documentation remains aligned with plugin and migration behavior.
