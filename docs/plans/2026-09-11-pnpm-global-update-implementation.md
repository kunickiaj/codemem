# pnpm-Global Update Implementation Plan

The implementation adds evidence-backed pnpm-global explicit updates without extending unattended update authority.

## 1. Extend Release Discovery

- Add `pnpm-global` to the installation-kind contract in `packages/core/src/release-discovery.ts` and its UI mirror.
- Classify only the resolved JavaScript entry path when it provides pnpm global-layout evidence; do not invoke pnpm while calculating status.
- Return the exact paired-release guidance for pnpm-global installations and set `auto_update_eligible=false`.
- Refuse `pnpm dlx`, project-local, missing, and ambiguous paths.
- Add focused cases in `packages/core/src/release-discovery.test.ts` for Unix and Windows normalization, precedence, guidance, and fail-closed classification.

## 2. Gate Explicit Installation on Re-proven Ownership

- Export explicit-install eligibility separately from background eligibility so pnpm-global can run `codemem update install` but never a background installation.
- In `packages/cli/src/commands/update.ts`, bound stdout and run `pnpm root -g`, `pnpm bin -g`, and `pnpm list -g --depth 0 --json` with argument arrays and `shell: false`.
- Normalize the roots and parse the list payload as the ownership record. Require `pnpm root -g` to equal the list root for pnpm 12 or `<list-root>/node_modules` for pnpm 9–11. Before mutation, require a listed `codemem` entry at the running version with a canonical registered path beneath the list root, and require that path to own the resolved JavaScript entry. Permit embeddings to be absent before the paired update.
- Use the normalized bin result to locate the specific pnpm-global launcher for verification, including supported Windows shim variants. Do not treat `process.argv[1]` as that launcher.
- Abort before mutation if pnpm is missing, any query fails or exceeds its bound, the list payload is malformed or ambiguous, or any root/package/entry ownership check disagrees.

## 3. Run and Verify the Exact Update

- Spawn the exact paired install without a shell:

  ```text
  pnpm add -g codemem@<version> @codemem/embeddings@<version>
  ```

- Keep pnpm options before package operands. Pass `--registry` and pnpm's verified `--config.@codemem:registry` option, preserve matching pins in the sanitized environment, and add the Linux CPU-only ONNX setting. Do not add `--allow-build` or any build-script approval.
- From a neutral directory, repeat bounded `pnpm list -g --depth 0 --json`; require the list root to remain unchanged, both canonical registered paths beneath it, and both `codemem` and `@codemem/embeddings` versions to equal the requested version exactly.
- Execute the specific launcher supplied by `pnpm bin -g` from that neutral directory and require `codemem version` to equal the requested version.
- Treat any install, package-state, or executable-version failure as an update failure.

## 4. Cover the Contract and User Surfaces

- Add CLI cases in `packages/cli/src/commands/update.test.ts` for legacy/current list fixtures and root semantics, bounded notice-tolerant root/bin/list probes, registered-path ownership, setup guidance, no-shell execution, mismatches, scoped registry arguments and sanitized environment, Linux ONNX handling, paired exact versions, oversized successful install output, and neutral-directory verification through the pnpm bin launcher.
- Record the disposable pnpm 12.2.1 plus Node 24 rehearsal: ignored native build scripts still allowed SQLite-backed `codemem status`. Note that pnpm 9 runs install scripts by default, and assert the updater does not request build-script approval on any version.
- Update `README.md`, `docs/user-guide.md`, and `docs/plugin-reference.md` to distinguish pnpm-global release notifications and explicit updates from npm-global background updates.

## 5. Validate

- Run the release-discovery and update-command test files.
- Run affected UI and plugin tests when the installation-kind wire contract reaches their fixtures.
- Run TypeScript, lint, and the repository test gate after the focused tests pass.
