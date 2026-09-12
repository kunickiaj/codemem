# pnpm-Global Update Design

**Status:** Approved
**Date:** 2026-09-11

## Decision

Codemem will recognize evidence-backed pnpm-global installations, notify users of releases, and support only an explicit `codemem update install`. Background installation remains npm-global-only: pnpm-global reports `auto_update_eligible=false`.

## Detection

Status-time detection uses only the resolved JavaScript entry path. It recognizes pnpm 9–11 entries shaped like `pnpm/global/5/.pnpm/codemem@<version>/node_modules/codemem/dist/index.js` and pnpm 12 grouped entries shaped like `pnpm/global/vN/<group>/node_modules/.pnpm/codemem@<version>_<peers>/node_modules/codemem/dist/index.js`, without assuming a group-token format. A configured, normalized `PNPM_HOME` may replace the recognizable `pnpm` directory prefix. Matching this virtual-store evidence is an inexpensive signal, not proof that the running executable belongs to a mutable global installation.

The detector fails closed for `pnpm dlx`, project-local packages, missing paths, or ambiguous layouts. It must not run pnpm during status checks, so status remains fast and does not depend on a working pnpm executable.

## Explicit Update Contract

Immediately before mutation, `codemem update install` re-proves ownership with bounded, no-shell calls:

```text
pnpm root -g
pnpm bin -g
pnpm list -g --depth 0 --json
```

The bounded list payload is the package-ownership record: before mutation, it must contain `codemem` at the running version with an exact registered path beneath the canonical list root. `pnpm root -g` must equal that list root for pnpm 12 or its `node_modules` directory for pnpm 9–11. The package path must own the resolved running JavaScript entry. The embeddings package may be absent before the paired update, but both packages are mandatory during post-update verification.

The normalized global bin directory supplies the specific pnpm-global launcher to execute after installation, including supported Windows shim forms. `process.argv[1]` is entry-path evidence, not itself the launcher. A missing pnpm executable, non-zero command, oversized output, malformed or ambiguous list payload, or root/package/entry mismatch aborts without updating.

Once ownership is proven, the updater installs the exact paired release without a shell:

```text
pnpm add -g codemem@<version> @codemem/embeddings@<version>
```

The command places pnpm options before package operands. It passes `--registry` and pnpm's `--config.@codemem:registry` option, while a sanitized environment supplies the same public default and scoped registry pins. The spawned process also applies the CPU-only ONNX setting on Linux. It never runs a build-approval command or broadens pnpm's configured build-script policy.

## Verification

Verification runs outside the invoking project directory so a local package cannot satisfy it. It repeats bounded `pnpm list -g --depth 0 --json`, requires the list root to remain unchanged, both canonical registered package paths to remain beneath it, and both listed versions to equal the requested version exactly. It then runs the specific launcher from `pnpm bin -g` and requires one unambiguous reported version line to match.

```text
codemem version
```

An absent package, stale version, command failure, or executable-version mismatch reports an actionable failure rather than a successful update.

## Build-Script Finding

A disposable pnpm 12.2.1 installation on Node 24 installed matching `codemem@0.44.2` and `@codemem/embeddings@0.44.2` while pnpm ignored native build scripts. The SQLite-backed `codemem status` command still loaded successfully. pnpm 9 runs install scripts by default, while newer releases apply their configured build-script policy.

The updater therefore must not run a build-approval command: the pnpm 12 rehearsal did not need one, and approval would expand the update's trust boundary without a runtime need.

## Alternatives Rejected

- Probing pnpm at status time was rejected because `PATH` can select a manager unrelated to the running executable and makes status dependent on external command execution.
- Path-only mutation was rejected because pnpm global stores, symlinks, and shims can make a plausible path belong to another installation.
- Background pnpm updates were rejected because only a direct user command should mutate a pnpm-global installation.

## Validation

Tests cover pnpm 9–11 and pnpm 12 entry layouts, normalized custom `PNPM_HOME`, strict `dlx` and project-local refusal, legacy and current root relationships, real `private: false` list metadata, notice-tolerant path and launcher parsing, setup guidance, bounded probes and post-install verification, Unix and Windows scoped registry arguments, and oversized successful pnpm install output. The core, CLI, UI type mirror, README, user guide, and plugin reference describe notifications and explicit updates without advertising background pnpm updates.
