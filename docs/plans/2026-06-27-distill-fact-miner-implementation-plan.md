# Distill fact miner — v1 implementation plan

**Status:** Plan ready — pending build
**Design:** [Distill: mining history into promotable context and skills](./2026-06-27-distill-fact-miner-design.md)
**Tracking:** `bd` epic (see "Beads" section)

Scope: the **v1 context-fact miner** only. Deterministic candidate engine in
core + `codemem distill` CLI + review handoff (emit diff, human applies). Skill
miner and proactive ledger are v2 (separate epic).

## Build order (each step = one PR / one bead)

Core lands before CLI so the deterministic engine is fully tested in isolation.

### Step 1 — Core scaffolding + corpus read
**Files:** `packages/core/src/distill.ts` (new), `packages/core/src/store.ts`,
`packages/core/src/index.ts`, `packages/core/src/distill.test.ts` (new).

- Define types: `DistillCandidate`, `DistillScope = "project" | "user"`,
  `ArtifactKind = "context_fact" | "skill"`, and the `Detector<T>` seam.
- Add a corpus-read on `MemoryStore` (the existing `recent`/`search` are
  query-scoped; we need a deterministic full scan). Either paginate `recent`
  with `offset` and no project filter, or add `iterateMemories(filters)`.
  Default selection = `kind in (discovery, decision)`.
- Export from `core/index.ts`.
- **Test:** corpus read returns the expected member set deterministically for a
  seeded fixture DB.

### Step 2 — Semantic clustering
**Files:** `distill.ts`, `distill.test.ts`.

- Pull stored vectors from `memory_vectors` for the selected members.
- Build KNN adjacency at a cosine threshold; union-find (reuse the shape in
  `pack.ts`) to form clusters. `concepts[]` overlap as a booster/tie-breaker.
- Degrade gracefully when embeddings are unavailable (fall back to the
  title-word/concept overlap path; never throw — same posture as `vectors.ts`).
- **Test:** inject fixture vectors (no model needed, mirror
  `vectors.test.ts`/`scope-regression.test.ts`); assert deterministic cluster
  membership and the embeddings-disabled fallback.

### Step 3 — Promotability scoring
**Files:** `distill.ts`, `distill.test.ts`.

- `score = recurrence × session_spread × time_spread × mean_confidence`,
  lightly recency-weighted. Pure function over a cluster.
- **Test:** crafted clusters assert ranking — "recurs across many sessions over
  weeks" outranks "many hits in one session."

### Step 4 — Dedup vs existing context
**Files:** `distill.ts`, `distill.test.ts`.

- Read target context files (`AGENTS.md`, configured user-context path), chunk +
  embed (reuse `embeddings.ts` `chunkText`/`embedTexts`).
- Suppress (or mark `already_documented`) clusters whose centroid is within a
  cosine threshold of an existing chunk.
- **Test:** a candidate matching seeded context text is suppressed; a net-new one
  survives.

### Step 5 — Scope routing + candidate emit
**Files:** `distill.ts`, `distill.test.ts`.

- Distinct `project` count → `project` (1) vs `user` (≥2) + `suggested_target`.
- Assemble `DistillCandidate[]`, stable-sorted by score; `draft_text` stays
  `null` (B fills it).
- **Test:** snapshot the candidate contract shape; assert scope routing both ways.

### Step 6 — `codemem distill` CLI + docs
**Files:** `packages/cli/src/commands/distill.ts` (new),
`packages/cli/src/index.ts`, `packages/cli/src/commands/distill.test.ts` (new),
`README.md`, `docs/user-guide.md`.

- Mirror `recent.ts`/`stats.ts`: `helpStyle`, `addDbOption`, `addJsonOption`,
  `resolveDbOpt`, `emitJsonError`. Catch at the handler boundary (no uncaught
  throws). `--json` is a stable contract.
- Flags: `--project`, `--all-projects`, `--kind`, `--min-recurrence`,
  `--limit`, `--explain` (dry-run showing per-candidate evidence + score
  breakdown).
- Register via `program.addCommand(distillCommand)`. Update the completion list.
- **Test:** smoke test (JSON shape, exit codes) + a `--explain` snapshot.
- **Docs parity:** required by `cli-design-conventions.md` — same PR.

## Test strategy

- Pure functions (cluster/score/dedup/route) are unit-tested with injected
  vectors and seeded fixtures — **no embedding model required in CI**.
- One integration-ish test seeds a temp DB and runs the full pipeline.
- Gate locally with `pnpm run tsc && pnpm run lint && pnpm run test`.

## Tuning (post-merge, against real data)

Thresholds (KNN cosine, `--min-recurrence`, doc-overlap suppression) ship with
conservative defaults and are tuned via `--explain` against a real store. This
is expected iteration, not a blocker for v1 merge.

## Out of scope (v2 epic)

Skill miner (detector #2), proactive `distill_candidates` ledger + session
nudge, auto-apply, viewer tab.
