# Distill: mining history into promotable context and skills

**Status:** Design draft — pending approval
**Related:**
- [Phase B: Pack near-duplicate compression](./2026-04-08-phase-b-pack-dedup-design.md) (recurrence detection this builds on)
- [File/concept index layer](./2026-04-11-file-concept-index-layer.md) (skill-miner input projection)
- [Cross-project fallback retrieval](./2026-04-17-cross-project-fallback-retrieval.md) (project-spread signal)

## Goal

Turn codemem's accumulated history into two kinds of durable, reusable output:

1. **Context facts** — lessons/constraints that recur often enough that they
   should be written into project `AGENTS.md` or user/global context, so agents
   stop re-learning them every session.
2. **Skills** — multi-step procedures that recur often enough that they should
   be codified as a `SKILL.md` (e.g. "to change a memory kind, touch `store.ts`
   + `mcp-server` + `feed.ts`").

The fact miner ships first (v1). The skill miner is a committed v2, not a maybe.

## Core insight

codemem **already** detects recurrence. `packages/core/src/pack.ts` clusters
near-duplicate memories (union-find over shared title words) and labels each
cluster with a `pattern`: `recurring_failure`, `operational_rule`,
`related_work`, `session_echo`, `thematic_overlap`. Today that signal is used
only to **compress** packs.

This feature reuses the same latent recurrence signal but routes it to a
different destination: **promotion into context/skills** instead of compression.
The hand-maintained gotchas list in `AGENTS.md` is the manual version of this
output — a graveyard of lessons that recurred enough to hurt. Distill spots them
before they have to be hand-written.

Two enablers already exist in core:
- **Semantic embeddings** — sqlite-vec, 384-dim BGE-small, KNN search
  (`packages/core/src/vectors.ts`, `embeddings.ts`). Lets us cluster by meaning,
  not just shared title words, so "the same lesson re-learned in different words"
  is detectable.
- **Structured fields** — `concepts[]`, `files_read[]`, `files_modified[]`,
  `kind`, `project`, `confidence` per memory
  (`packages/core/src/ref-queries.ts`).

## Decisions locked in this brainstorm

| Question | Decision |
|---|---|
| Product or personal? | Start personal, design so it productizes (CLI/MCP/viewer later). |
| Emission model | **A → B**: deterministic engine emits ranked candidates (A); LLM + human gate writes the artifact (B). |
| Invocation | Manual for v1; proactive "hey I noticed…" nudge is a v2 bonus. |
| First detector | Context-fact miner. Skill miner is detector #2 (v2). |
| Scope routing | **Route by project spread**: recurs in 1 project → that repo's context; recurs across ≥2 projects → user/global. Human can override at review. |
| Anti-noise | Candidates are **diffed against existing context files** (`AGENTS.md` etc.) so only net-new lessons surface. |
| Auto-write? | No. v1 stops at "emit the diff"; applying the write stays a human action. |

A wrong auto-written rule silently steers every future session — the
agent-behavior equivalent of an insecure default. That is why B is gated.

## Architecture

```
select → cluster → score → dedup-vs-context → route-scope → emit candidates
  (A: deterministic core)                                   │
                                                            ▼
                                          B: LLM drafts prose → diff → human applies
```

### Module placement

- **`packages/core/src/distill.ts`** — pure, deterministic, vitest-friendly.
  All clustering/scoring/dedup/routing. No file writes, no chat-LLM. Returns
  scored candidates.
- **CLI** — a thin command that calls `distill.ts` and prints candidates
  (`--json` + markdown), following `docs/cli-design-conventions.md`. Working
  name `codemem distill`; final name settled against the noun-group convention
  before release.
- **Detector interface** from day one so the skill miner is detector #2 with a
  different input projection and artifact type.

### Detector interface (the seam for v2)

```ts
interface Detector<TCandidate> {
  // Which memories this detector consumes.
  select(store): MemoryResult[];
  // Project memories into the feature space this detector clusters on.
  project(items: MemoryResult[]): FeatureVector[];
  // Cluster + score, shared across detectors.
  // (cluster/score/dedup/route are shared utilities)
  artifactKind: "context_fact" | "skill";
}
```

- **Fact detector (v1):** `select` = `discovery` + `decision` (config flag to
  fold in `bugfix` as guardrail candidates later). `project` = semantic
  embedding centroid + `concepts[]`.
- **Skill detector (v2):** `select` = action-bearing memories. `project` =
  `files_modified[]` co-occurrence + `kind` sequences over time.

### Clustering

1. Semantic KNN over existing embeddings → adjacency at a cosine threshold.
2. Union-find over the adjacency graph (same shape as `pack.ts`, stronger
   signal than title-word overlap).
3. `concepts[]` overlap as a tie-breaker / booster.

### Scoring (promotability)

```
score = recurrence × session_spread × time_spread × mean_confidence
        (lightly recency-weighted)
        − already_documented_penalty
```

Repetition across **many sessions over weeks** must outrank many hits in one
afternoon — the former is a durable lesson, the latter is one task. Exact
weights are tuned empirically against a real DB (see Open questions).

### Dedup vs existing context

Embed the existing `AGENTS.md` / context-file chunks. If a cluster centroid is
too close (cosine) to something already written, suppress it or mark it
`already_documented`. This is what keeps run #1 from being 90% noise.

### Scope routing

Count distinct `project` values in the cluster:
- 1 project → propose for that repo's context (`AGENTS.md`).
- ≥2 projects → propose for user/global context.

Human can override scope at review time.

### Candidate contract (handoff to B)

```jsonc
{
  "scope": "project" | "user",
  "suggested_target": "AGENTS.md" | "~/.config/.../context",
  "score": 0.0,
  "recurrence": 7,
  "projects": ["codemem", "garf"],
  "member_ids": [123, 456],
  "representative_id": 123,
  "concepts": ["lint", "biome"],
  "artifact_kind": "context_fact",   // skill detector emits "skill"
  "evidence": ["...fact lines from members..."],
  "draft_text": null                  // A leaves null; B fills it
}
```

Deterministic core emits everything except `draft_text`.

### B side (gated synthesis)

`distill` prints candidates → the agent (or human) writes the prose rule into
`draft_text` → produces a **diff against the target file** for human approval.
v1 stops at "emit the diff." Applying the write is a human action.

## Roadmap

- **v1 — fact miner.** `distill.ts` + CLI + candidate contract + review handoff.
  Context facts only. Deterministic core, manual invocation, emit-diff only.
- **v2 — skill miner (detector #2).** Reuse the pipeline; swap input projection
  to `files_modified[]` co-occurrence + `kind` sequences; emit `SKILL.md` stubs.
- **v2 — proactive nudge.** A `distill_candidates` table with status
  (`new`/`accepted`/`dismissed`/`snoozed`) so reruns don't re-surface dismissed
  items, plus a session hook that says "N new lessons worth writing down." Built
  on the batch scorer, not pack-time clustering (pack clustering only sees what
  a query pulled — biased, never whole-corpus).

## Testing

- `distill.test.ts`: deterministic fixtures → assert clustering, scoring order,
  scope routing, and `already_documented` suppression. No embedding model needed
  if fixtures inject vectors (same pattern as `scope-regression.test.ts` /
  `vectors.test.ts`).
- Validate against the real local DB via `--explain` dry-run before tuning
  thresholds.

## Open questions (need real data to settle)

- Cosine / min-recurrence / doc-overlap-suppression thresholds — start with
  defaults + a `--explain` dry-run, tune against a real store.
- Final command name/placement under CLI conventions.
- Whether `bugfix` clusters become "guardrail" candidates in v1 or wait for v2.

## Explicitly out of scope for v1

Auto-apply/auto-write; skill miner; proactive nudge; UI/viewer tab. Seams are
designed in v1; implementations land in v2.
