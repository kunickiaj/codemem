# codemem

- Public repo: never add secrets, internal hostnames, private identifiers, or local artifact paths. Keep `.tmp/`, `.venv/`, `*.sqlite`, `packages/*/dist/`, `packages/viewer-server/static/`, and `.opencode/package-lock.json` out of git.
- Default to the TypeScript toolchain: this repo is a pnpm workspace on Node 24 / pnpm 10.33.0. Use `uv ...` only when explicitly touching the legacy Python code in `codemem/` or `tests/`.

## What runs where

- CLI entrypoint: `packages/cli/src/index.ts` (`pnpm run codemem ...`).
- Shared store/search/sync logic and exported version: `packages/core/src/index.ts`.
- Viewer HTTP API + SPA host: `packages/viewer-server/src/index.ts`.
- Viewer UI source: `packages/ui/src/`.
- OpenCode plugin source of truth: `packages/opencode-plugin/.opencode/plugins/codemem.js`.
- `packages/cli/.opencode/plugins/codemem.js` and repo-root `.opencode/plugins/codemem.js` are wrappers/re-exports, not the main implementation.
- `packages/cloudflare-coordinator-worker/` is its own worker package with separate tests.

## Commands worth using

- Install: `pnpm install`
- Full local gate / CI order: `pnpm run tsc && pnpm run lint && pnpm run test` (`pnpm run check`)
- Build everything: `pnpm run build`
- Run CLI from source: `pnpm run codemem --help`
- Run one vitest file: `pnpm exec vitest run packages/cli/src/commands/serve.test.ts`
- Run one package script: `pnpm --filter codemem test`, `pnpm --filter @codemem/ui build`, `pnpm --filter @codemem/cloudflare-coordinator-worker test:worker`
- E2E smoke: `CODEMEM_E2E_BUILD=1 CODEMEM_E2E_JSON=1 pnpm run e2e:smoke -- --json` (artifacts land in `.tmp/e2e-artifacts`)

## Gotchas agents usually miss

- `pnpm run lint` only checks files included by `biome.json` (mostly `packages/**` TS/TSX/JS/JSON and root TS config). Docs like `AGENTS.md` are outside Biome.
- `pnpm run test` is workspace vitest; root `vitest.config.ts` points at `packages/*/vite.config.ts`.
- The viewer server throws if `packages/viewer-server/static/index.html` is missing. If you change UI or viewer assets, run `pnpm build` or at least `pnpm --filter @codemem/ui build`.
- `packages/viewer-server/static/` is generated and ignored. Do not hand-edit it. UI build stages assets there, but most non-`app.js` assets still come from `codemem/viewer_static/`.
- Plugin smoke tests rely on nested `.opencode` runtime deps. CI installs `@opencode-ai/plugin` inside `packages/cli/.opencode` and `packages/opencode-plugin/.opencode` before running smoke tests.
- CLI work should follow `docs/cli-design-conventions.md`: max 2 nesting levels, noun-based groups, shared `--db-path` / `--config` / `--json` helpers, and no uncaught throws from command handlers.
- The repo still contains legacy Python and old static assets. For TS work, trust `package.json`, package scripts, and CI over old Python-era docs/checklists.
- `.github/PULL_REQUEST_TEMPLATE.md` is TS-first now; use `pnpm run tsc`, `pnpm run lint`, and `pnpm run test` unless you are actually changing legacy Python.

## Workflow rules specific to this repo

- Use `bd` for issue tracking, not markdown TODOs: `bd ready --json`, `bd create ... --json`, `bd close ... --json`.
- If you change plugin behavior, update `README.md` and any affected docs under `docs/`.
- If you change memory kinds or their presentation, update all three surfaces together: `packages/core/src/store.ts`, `packages/mcp-server/src/index.ts`, and `packages/ui/src/tabs/feed.ts`.

## Release traps

- Release tags trigger publishing. Tag only the merged `main` commit, not a `release/*` branch tip.
- Version alignment is scripted in `scripts/release-version.mjs`; tag safety is enforced by `pnpm run release:preflight-tag` / `scripts/release-tag-preflight.sh`.
- Releases publish to the public npm registry; keep `.opencode/.npmrc` pointed at `https://registry.npmjs.org/`.
