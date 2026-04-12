# File & Concept Index Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add normalized junction tables for file references and concept references so codemem can efficiently answer "what decisions affected foo.ts?" and "what do we know about auth?" without scanning JSON arrays.

**Architecture:** Two new tables (`memory_file_refs`, `memory_concept_refs`) are populated at write time from existing JSON array columns (`files_read`, `files_modified`, `concepts`) on `memory_items`. A backfill maintenance job populates refs for existing data. New query functions enable indexed lookups, and the existing `workingSetOverlapBoost` reranker is updated to use indexed data instead of runtime JSON parsing.

**Tech Stack:** TypeScript, Drizzle ORM, better-sqlite3, vitest, pnpm monorepo (`packages/core`)

**Related bead:** codemem-am33

---

## Conventions

- Run quality gate after each task: `pnpm run tsc && pnpm run lint && pnpm run test`
- Test schema regeneration: `pnpm --filter @codemem/core run generate:test-schema`
- Use Graphite for commits: `gt create --all --message "..."`
- Biome handles formatting — run `pnpm run lint` and fix any issues
- Schema version lives at `packages/core/src/db.ts:35` (`SCHEMA_VERSION`)
- Bootstrap DDL lives at `packages/core/src/schema-bootstrap.ts` (`SCHEMA_AUX_DDL`)
- Drizzle schema lives at `packages/core/src/schema.ts`
- Test schema is auto-generated from Drizzle schema; regenerate after schema changes

---

## Task 1: Add Drizzle schema definitions for junction tables

**Files:**
- Modify: `packages/core/src/schema.ts` (add two new table definitions + export)

**Step 1: Add the `memoryFileRefs` table definition**

After the `memoryItems` table definition (~line 102), add:

```ts
export const memoryFileRefs = sqliteTable(
	"memory_file_refs",
	{
		memory_id: integer("memory_id")
			.notNull()
			.references(() => memoryItems.id, { onDelete: "cascade" }),
		file_path: text("file_path").notNull(),
		relation: text("relation").notNull(), // 'read' | 'modified'
	},
	(table) => [
		primaryKey({ columns: [table.memory_id, table.file_path, table.relation] }),
		index("idx_memory_file_refs_path").on(table.file_path),
	],
);

export type MemoryFileRef = typeof memoryFileRefs.$inferSelect;
export type NewMemoryFileRef = typeof memoryFileRefs.$inferInsert;
```

**Step 2: Add the `memoryConceptRefs` table definition**

Immediately after `memoryFileRefs`:

```ts
export const memoryConceptRefs = sqliteTable(
	"memory_concept_refs",
	{
		memory_id: integer("memory_id")
			.notNull()
			.references(() => memoryItems.id, { onDelete: "cascade" }),
		concept: text("concept").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.memory_id, table.concept] }),
		index("idx_memory_concept_refs_concept").on(table.concept),
	],
);

export type MemoryConceptRef = typeof memoryConceptRefs.$inferSelect;
export type NewMemoryConceptRef = typeof memoryConceptRefs.$inferInsert;
```

**Step 3: Add both tables to the `schema` export**

At the bottom of the file, add `memoryFileRefs` and `memoryConceptRefs` to the `schema` object.

**Step 4: Regenerate test schema**

Run: `pnpm --filter @codemem/core run generate:test-schema`

This will regenerate `packages/core/src/test-schema.generated.ts` with the new DDL.

**Step 5: Run quality gate**

Run: `pnpm run tsc && pnpm run lint && pnpm run test`
Expected: PASS (new tables exist in schema but aren't used yet)

**Step 6: Commit**

```
gt create --all --message "feat(core): add Drizzle schema for memory_file_refs and memory_concept_refs"
```

---

## Task 2: Add DDL to schema bootstrap and bump schema version

**Files:**
- Modify: `packages/core/src/schema-bootstrap.ts` (add DDL to `SCHEMA_AUX_DDL`)
- Modify: `packages/core/src/db.ts` (bump `SCHEMA_VERSION` from 6 to 7)

**Step 1: Add junction table DDL to `SCHEMA_AUX_DDL`**

In `schema-bootstrap.ts`, append to the `SCHEMA_AUX_DDL` string (before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS memory_file_refs (
	memory_id INTEGER NOT NULL,
	file_path TEXT NOT NULL,
	relation TEXT NOT NULL,
	PRIMARY KEY (memory_id, file_path, relation),
	FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_file_refs_path
	ON memory_file_refs(file_path);

CREATE TABLE IF NOT EXISTS memory_concept_refs (
	memory_id INTEGER NOT NULL,
	concept TEXT NOT NULL,
	PRIMARY KEY (memory_id, concept),
	FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_concept_refs_concept
	ON memory_concept_refs(concept);
```

**Step 2: Bump SCHEMA_VERSION**

In `packages/core/src/db.ts`, change line 35:

```ts
export const SCHEMA_VERSION = 7;
```

**Step 3: Run quality gate**

Run: `pnpm run tsc && pnpm run lint && pnpm run test`
Expected: PASS (schema bootstrap now creates the tables on fresh DBs; existing tests using bootstrapSchema get them automatically)

**Step 4: Commit**

```
gt create --all --message "feat(core): bootstrap memory_file_refs and memory_concept_refs tables (schema v7)"
```

---

## Task 3: Populate junction tables at write time in `store.remember()`

**Files:**
- Modify: `packages/core/src/store.ts` (insert refs after memory insert, inside transaction)
- Test: `packages/core/src/store.test.ts` (add tests for ref population)

**Step 1: Write the failing tests**

Add tests to `packages/core/src/store.test.ts` that verify:

1. When `store.remember()` is called with `files_read` and `files_modified` metadata, corresponding rows appear in `memory_file_refs`.
2. When `store.remember()` is called with `concepts` metadata, corresponding rows appear in `memory_concept_refs`.
3. When `files_read`/`files_modified`/`concepts` are null or empty, no ref rows are created.
4. Duplicate file paths across `files_read` and `files_modified` produce distinct rows (different `relation` values).

Test approach: call `store.remember()`, then query `memory_file_refs` and `memory_concept_refs` directly via raw SQL to verify rows.

**Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/core/src/store.test.ts -t "file_refs"`
Expected: FAIL (no rows in junction tables yet)

**Step 3: Implement ref population in `store.remember()`**

In `packages/core/src/store.ts`, after the successful `memoryItems` insert (around line 647, after `const memoryId = ...`), add a helper call to populate refs. Add a private method to `MemoryStore`:

```ts
private populateMemoryRefs(
	memoryId: number,
	filesRead: string[] | null,
	filesModified: string[] | null,
	concepts: string[] | null,
): void {
	const insertFileRef = this.db.prepare(
		"INSERT OR IGNORE INTO memory_file_refs (memory_id, file_path, relation) VALUES (?, ?, ?)",
	);
	if (filesRead) {
		for (const path of filesRead) {
			if (path) insertFileRef.run(memoryId, path, "read");
		}
	}
	if (filesModified) {
		for (const path of filesModified) {
			if (path) insertFileRef.run(memoryId, path, "modified");
		}
	}
	const insertConceptRef = this.db.prepare(
		"INSERT OR IGNORE INTO memory_concept_refs (memory_id, concept) VALUES (?, ?)",
	);
	if (concepts) {
		for (const concept of concepts) {
			const normalized = concept?.trim().toLowerCase();
			if (normalized) insertConceptRef.run(memoryId, normalized);
		}
	}
}
```

Call `this.populateMemoryRefs(memoryId, filesRead, filesModified, concepts)` right after the insert succeeds (inside the same try block, before the replication op).

**Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/core/src/store.test.ts`
Expected: PASS

**Step 5: Run full quality gate**

Run: `pnpm run tsc && pnpm run lint && pnpm run test`

**Step 6: Commit**

```
gt create --all --message "feat(core): populate memory_file_refs and memory_concept_refs at write time"
```

---

## Task 4: Add backfill maintenance job for existing data

**Files:**
- Create: `packages/core/src/ref-backfill.ts`
- Create: `packages/core/src/ref-backfill.test.ts`

**Step 1: Write the failing tests**

In `ref-backfill.test.ts`, test:

1. `runRefBackfillPass()` populates file/concept refs for memories that have JSON data but no ref rows.
2. Running a second pass is a no-op (idempotent).
3. Batch size is respected — if there are more rows than `batchSize`, the function returns `true` (more work) and a subsequent call processes the next batch.
4. Memories with null/empty JSON arrays produce no ref rows.
5. The maintenance job record is created and transitions through `running` → `completed`.

Follow the pattern in `dedup-key-backfill.test.ts` for test structure.

**Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/core/src/ref-backfill.test.ts`
Expected: FAIL (module doesn't exist)

**Step 3: Implement `ref-backfill.ts`**

Follow the pattern from `dedup-key-backfill.ts`:

- Export `REF_BACKFILL_JOB = "memory_ref_backfill"` constant.
- `hasPendingRefBackfill(db)`: check if any `memory_items` with non-null `files_read`/`files_modified`/`concepts` have no corresponding ref rows.
- `runRefBackfillPass(db, options?)`: scan `memory_items` in batches (cursor-based, ordered by `id`), parse JSON arrays, insert into `memory_file_refs` / `memory_concept_refs` with `INSERT OR IGNORE`, update maintenance job progress.
- `RefBackfillRunner` class: same timer-based runner pattern as `DedupKeyBackfillRunner`.

Query to find memories needing backfill:

```sql
SELECT mi.id, mi.files_read, mi.files_modified, mi.concepts
FROM memory_items mi
WHERE mi.active = 1
  AND mi.id > ?  -- cursor
  AND (mi.files_read IS NOT NULL OR mi.files_modified IS NOT NULL OR mi.concepts IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM memory_file_refs mfr WHERE mfr.memory_id = mi.id
    UNION ALL
    SELECT 1 FROM memory_concept_refs mcr WHERE mcr.memory_id = mi.id
  )
ORDER BY mi.id ASC
LIMIT ?
```

For each row, parse the JSON arrays with `JSON.parse()` (wrapped in try/catch for corrupt data), then insert refs.

**Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/core/src/ref-backfill.test.ts`
Expected: PASS

**Step 5: Export from core index**

Add exports for `REF_BACKFILL_JOB`, `hasPendingRefBackfill`, `runRefBackfillPass`, and `RefBackfillRunner` from `packages/core/src/index.ts`.

**Step 6: Run full quality gate**

Run: `pnpm run tsc && pnpm run lint && pnpm run test`

**Step 7: Commit**

```
gt create --all --message "feat(core): add ref-backfill maintenance job for existing memory file/concept data"
```

---

## Task 5: Wire backfill into maintenance runner

**Files:**
- Modify: `packages/core/src/maintenance.ts` (add ref backfill to the maintenance pass)
- Test: `packages/core/src/maintenance.test.ts` (verify backfill is triggered)

**Step 1: Read the maintenance runner to understand the hook point**

Read `packages/core/src/maintenance.ts` to find where other backfill jobs are triggered (e.g., dedup-key backfill, session-context backfill).

**Step 2: Write a failing test**

Add a test in `maintenance.test.ts` that verifies:
- When there are memories with file/concept JSON but no ref rows, the maintenance pass triggers the ref backfill.

**Step 3: Wire in the ref backfill**

Add `runRefBackfillPass` to the maintenance runner, following the same pattern as existing backfill jobs.

**Step 4: Run tests**

Run: `pnpm exec vitest run packages/core/src/maintenance.test.ts`
Expected: PASS

**Step 5: Run full quality gate**

Run: `pnpm run tsc && pnpm run lint && pnpm run test`

**Step 6: Commit**

```
gt create --all --message "feat(core): wire ref-backfill into maintenance runner"
```

---

## Task 6: Add `findByFile()` and `findByConcept()` query functions

**Files:**
- Create: `packages/core/src/ref-queries.ts`
- Create: `packages/core/src/ref-queries.test.ts`

**Step 1: Write failing tests**

In `ref-queries.test.ts`, test:

1. `findByFile("src/auth.ts")` returns memories where that file appears in `memory_file_refs`.
2. `findByFile("src/auth.ts", { relation: "modified" })` filters to only modified refs.
3. `findByFile("src/auth.ts", { kind: "decision" })` filters by memory kind.
4. `findByFile("src/auth/")` with directory prefix matches all files under that directory (LIKE query).
5. `findByConcept("auth")` returns memories with that concept in `memory_concept_refs`.
6. `findByConcept("auth", { kind: "decision" })` filters by memory kind.
7. Both functions return results ordered by `created_at DESC` (most recent first).
8. Both functions respect the `limit` option.
9. Soft-deleted memories (`active = 0`) are excluded.

**Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/core/src/ref-queries.test.ts`
Expected: FAIL

**Step 3: Implement query functions**

```ts
// ref-queries.ts

export interface RefQueryOptions {
	kind?: string;
	relation?: "read" | "modified";
	limit?: number;
	since?: string;
	project?: string;
}

export function findByFile(
	db: Database,
	filePath: string,
	options?: RefQueryOptions,
): MemoryItemResponse[] {
	// JOIN memory_file_refs → memory_items
	// WHERE file_path = ? (exact) OR file_path LIKE ? (directory prefix)
	// AND active = 1
	// Optional: kind, relation, since, project (via session JOIN)
	// ORDER BY mi.created_at DESC
	// LIMIT ?
}

export function findByConcept(
	db: Database,
	concept: string,
	options?: RefQueryOptions,
): MemoryItemResponse[] {
	// JOIN memory_concept_refs → memory_items
	// WHERE concept = ?
	// AND active = 1
	// Optional: kind, since, project
	// ORDER BY mi.created_at DESC
	// LIMIT ?
}
```

Use raw SQL with `db.prepare()` since Drizzle doesn't cleanly handle these junction table JOINs with dynamic WHERE clauses. Follow the existing pattern in `search.ts` for building SQL with optional clauses.

**Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/core/src/ref-queries.test.ts`
Expected: PASS

**Step 5: Add methods to MemoryStore**

Add `findByFile()` and `findByConcept()` methods to `MemoryStore` in `store.ts` that delegate to the functions in `ref-queries.ts`.

**Step 6: Export from core index**

Add exports from `packages/core/src/index.ts`.

**Step 7: Run full quality gate**

Run: `pnpm run tsc && pnpm run lint && pnpm run test`

**Step 8: Commit**

```
gt create --all --message "feat(core): add findByFile() and findByConcept() indexed query functions"
```

---

## Task 7: Integrate file/concept refs into pack scoring and working-set filter

The primary retrieval interface is `buildMemoryPack()` (auto context injection), not MCP tools. The junction tables should improve pack quality when `working_set_paths` are provided — currently this only boosts already-fetched results, but with indexed refs we can pre-filter candidates.

**Files:**
- Modify: `packages/core/src/pack.ts` (add ref-aware candidate sourcing when working_set_paths present)
- Modify: `packages/core/src/search.ts` (add `findCandidatesByFile()` helper that returns memory IDs from the index)
- Test: `packages/core/src/pack.test.ts` (verify working-set memories are found even without FTS/vector match)

**Step 1: Write failing test**

Add a test to `pack.test.ts` that creates a memory with `files_modified: ["packages/core/src/auth.ts"]` but whose title/body have no overlap with the query string. Then call `buildMemoryPack()` with `working_set_paths: ["packages/core/src/auth.ts"]` and a query that doesn't match the memory text. Currently this memory would be missed because it never enters the FTS candidate pool. After this task it should appear because the file ref index pulls it in.

**Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/pack.test.ts -t "file ref"`
Expected: FAIL (memory not found in pack)

**Step 3: Add `findCandidatesByFile()` in search.ts**

```ts
export function findCandidatesByFile(
	db: Database,
	filePaths: string[],
	limit = 50,
): number[] {
	if (filePaths.length === 0) return [];
	const placeholders = filePaths.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT DISTINCT mfr.memory_id
			 FROM memory_file_refs mfr
			 JOIN memory_items mi ON mi.id = mfr.memory_id
			 WHERE mfr.file_path IN (${placeholders})
			   AND mi.active = 1
			 ORDER BY mi.created_at DESC
			 LIMIT ?`,
		)
		.all(...filePaths, limit) as Array<{ memory_id: number }>;
	return rows.map((r) => r.memory_id);
}
```

**Step 4: Integrate into pack builder**

In `pack.ts`, when `working_set_paths` is non-empty, call `findCandidatesByFile()` to get memory IDs, then fetch those memories and merge them into the candidate pool before scoring. This ensures file-relevant memories enter the ranking even when FTS/vector don't surface them.

**Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/core/src/pack.test.ts`
Expected: PASS

**Step 6: Run full quality gate**

Run: `pnpm run tsc && pnpm run lint && pnpm run test`

**Step 7: Commit**

```
gt create --all --message "feat(core): use memory_file_refs index to source working-set candidates in pack builder"
```

---

## Task 8: Update working set overlap scoring to use indexed refs

**Files:**
- Modify: `packages/core/src/search.ts` (update `workingSetOverlapBoost` to use junction table)
- Test: `packages/core/src/search.test.ts` (existing tests should still pass)

**Step 1: Review current implementation**

The current `workingSetOverlapBoost` at `search.ts:539` reads `files_modified` from `item.metadata` (deserialized JSON). It does path segment matching and basename matching to compute a boost.

**Step 2: Consider approach**

Two options:
- **Option A**: Keep the reranker as-is (it operates on already-fetched results, JSON is already parsed into metadata). The junction tables primarily benefit query-time filtering, not post-fetch reranking.
- **Option B**: Add a pre-filter step that uses the junction table to narrow candidates before FTS/vector search.

**Recommendation: Option A for now.** The reranker already has the data it needs in memory. The real win from the junction tables is in Task 6's query functions and Task 7's MCP tools. Changing the reranker to hit the DB again would add latency without improving results. Document this decision in a code comment.

**Step 3: Add a comment documenting the design decision**

In `search.ts` near `workingSetOverlapBoost`, add a brief comment noting that `memory_file_refs` exists for indexed lookups but the reranker intentionally uses in-memory metadata since results are already loaded.

**Step 4: Run quality gate**

Run: `pnpm run tsc && pnpm run lint && pnpm run test`
Expected: PASS (no behavioral change)

**Step 5: Commit**

```
gt create --all --message "docs(core): document search reranker relationship to memory_file_refs index"
```

---

## Summary of changes

| Task | What | Files |
|------|------|-------|
| 1 | Drizzle schema definitions | `schema.ts`, `test-schema.generated.ts` |
| 2 | Bootstrap DDL + schema version bump | `schema-bootstrap.ts`, `db.ts` |
| 3 | Write-time population in `remember()` | `store.ts`, `store.test.ts` |
| 4 | Backfill maintenance job | `ref-backfill.ts`, `ref-backfill.test.ts` |
| 5 | Wire backfill into maintenance | `maintenance.ts`, `maintenance.test.ts` |
| 6 | Query functions | `ref-queries.ts`, `ref-queries.test.ts`, `store.ts` |
| 7 | Pack builder file-ref integration | `pack.ts`, `search.ts`, `pack.test.ts` |
| 8 | Document reranker design decision | `search.ts` |
