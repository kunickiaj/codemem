import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, fromJson } from "./db.js";
import {
	type CorpusRow,
	computeClaimKey,
	computeScopeKey,
	deriveClaimsFromBundle,
	groundingTokensPresent,
	leastTrustedState,
	reduceProvenance,
	runDerivePass,
} from "./derive.js";
import { DERIVE_EVAL_FIXTURES } from "./derive-eval-fixtures.js";
import { type DerivedFactInput, MemoryStore } from "./store.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

function makeStore(): { store: MemoryStore; tmpDir: string } {
	const tmpDir = mkdtempSync(join(tmpdir(), "codemem-derive-test-"));
	const dbPath = join(tmpDir, "test.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	return { store: new MemoryStore(dbPath), tmpDir };
}

function baseInput(sessionId: number, overrides: Partial<DerivedFactInput> = {}): DerivedFactInput {
	return {
		sessionId,
		kind: "decision",
		title: "Handlers must return structured errors",
		bodyText: "Handlers must return structured errors instead of throwing uncaught exceptions.",
		facts: ["Handlers must return structured errors instead of throwing uncaught exceptions."],
		concepts: ["handlers"],
		filesRead: ["packages/core/src/store.ts"],
		filesModified: [],
		provenance: {
			scope_id: "scope-a",
			visibility: "shared",
			workspace_id: "shared:default",
			workspace_kind: "shared",
			trust_state: "trusted",
		},
		derivation: {
			claim_type: "contract",
			claim_key: "df:v1:contract:handlers:handlers must return structured errors",
			extractor_version: "v1",
			source: { session_ids: [sessionId], memory_ids: [1], memory_import_keys: ["mem:1"] },
			grounding: { concepts: ["handlers"], files: [], must_appear_tokens: ["Handlers"] },
		},
		options: { skipVectorWrite: true },
		...overrides,
	};
}

describe("derive pure helpers", () => {
	it("computes claim keys without grounding tokens", () => {
		expect(
			computeClaimKey({
				claimType: "contract",
				scopeKey: "src/a.ts",
				title: "PR #12 Handlers must return structured errors",
			}),
		).toBe("df:v1:contract:src/a.ts:handlers must return structured errors");
	});

	it("computes sorted normalized scope keys capped at three", () => {
		expect(
			computeScopeKey({
				filesModified: ["SRC/B.ts", "src/a.ts"],
				filesRead: ["src/a.ts"],
				concepts: ["Handlers", "Zed"],
			}),
		).toBe("handlers,src/a.ts,src/b.ts");
	});

	it("uses the least trusted source state", () => {
		expect(leastTrustedState(["trusted", "unreviewed"])).toBe("unreviewed");
		expect(leastTrustedState(["trusted", "legacy_unknown"])).toBe("legacy_unknown");
	});

	// Codex: a NULL/blank source trust_state must not be treated as trusted.
	it("does not treat a missing source trust state as trusted", () => {
		expect(leastTrustedState(["trusted", null])).toBe("legacy_unknown");
		expect(leastTrustedState([undefined])).toBe("legacy_unknown");
		expect(leastTrustedState([""])).toBe("legacy_unknown");
	});

	it("rejects mixed provenance", () => {
		const result = reduceProvenance([
			{
				scope_id: "a",
				visibility: "shared",
				workspace_id: "shared:a",
				workspace_kind: "shared",
				trust_state: "trusted",
			},
			{
				scope_id: "b",
				visibility: "shared",
				workspace_id: "shared:a",
				workspace_kind: "shared",
				trust_state: "trusted",
			},
		]);
		expect(result).toEqual({ ok: false, reason: "mixed_provenance" });
	});

	it("checks grounding tokens against source and summary bodies", () => {
		expect(
			groundingTokensPresent({
				mustAppearTokens: ["structured errors"],
				sourceBodies: ["source body", "Summary says structured errors are required"],
			}),
		).toBe(true);
	});
});

describe("derive pass", () => {
	let store: MemoryStore;
	let tmpDir: string;
	let prevEmbeddingDisabled: string | undefined;

	beforeEach(() => {
		prevEmbeddingDisabled = process.env.CODEMEM_EMBEDDING_DISABLED;
		process.env.CODEMEM_EMBEDDING_DISABLED = "1";
		const setup = makeStore();
		store = setup.store;
		tmpDir = setup.tmpDir;
	});

	afterEach(() => {
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
		if (prevEmbeddingDisabled === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
		else process.env.CODEMEM_EMBEDDING_DISABLED = prevEmbeddingDisabled;
	});

	it("promotes M1/M2 fixtures and suppresses pure telemetry", () => {
		for (const fixture of DERIVE_EVAL_FIXTURES) {
			const sessionId = insertTestSession(store.db);
			store.remember(sessionId, fixture.kind, fixture.title, fixture.bodyText, 0.5, [], {
				concepts: ["handlers"],
				visibility: "shared",
				workspace_id: "shared:default",
			});
		}

		const result = runDerivePass(store, {
			createdAtFrom: "2000-01-01T00:00:00.000Z",
			skipVectorWrite: true,
		});
		expect(result.inserted).toBe(2);
	});

	it("derives summary-only grounded claims using the summary body", () => {
		const sessionId = insertTestSession(store.db);
		const summaryId = store.remember(
			sessionId,
			"session_summary",
			"Summary",
			"Handlers must return structured errors instead of throwing uncaught exceptions.",
			0.5,
			[],
			{
				source: "observer_summary",
				concepts: ["handlers"],
				visibility: "shared",
				workspace_id: "shared:default",
			},
		);
		const row = store.db
			.prepare(
				"SELECT m.*, s.import_key AS session_import_key FROM memory_items m LEFT JOIN sessions s ON s.id = m.session_id WHERE m.id = ?",
			)
			.get(summaryId) as CorpusRow;

		const claims = deriveClaimsFromBundle({
			sessionId,
			sessionImportKey: null,
			sources: [],
			summary: row,
		});
		expect(claims).toHaveLength(1);
		expect(claims[0]?.derivation.source.summary_memory_id).toBe(summaryId);
	});

	it("is idempotent across reruns and extractor version bumps", () => {
		const sessionId = insertTestSession(store.db);
		store.remember(
			sessionId,
			"decision",
			"Handlers must return structured errors",
			"Handlers must return structured errors instead of throwing uncaught exceptions.",
			0.5,
			[],
			{
				concepts: ["handlers"],
				visibility: "shared",
				workspace_id: "shared:default",
			},
		);

		expect(
			runDerivePass(store, { createdAtFrom: "2000-01-01T00:00:00.000Z", skipVectorWrite: true })
				.inserted,
		).toBe(1);
		expect(
			runDerivePass(store, { createdAtFrom: "2000-01-01T00:00:00.000Z", skipVectorWrite: true })
				.updated,
		).toBe(1);
		expect(
			runDerivePass(store, {
				createdAtFrom: "2000-01-01T00:00:00.000Z",
				extractorVersion: "v2",
				skipVectorWrite: true,
			}).updated,
		).toBe(1);
		const count = store.db
			.prepare(
				"SELECT COUNT(*) AS count FROM memory_items WHERE json_extract(metadata_json, '$.derivation.artifact_class') = 'derived_fact'",
			)
			.get() as { count: number };
		expect(count.count).toBe(1);
	});

	// Codex: trust can only ratchet down when a less-trusted source merges.
	it("lowers trust_state when a less-trusted source updates an existing fact", () => {
		const sessionId = insertTestSession(store.db);
		const inserted = store.upsertDerivedFact(baseInput(sessionId)); // trusted
		expect(inserted.outcome).toBe("inserted");
		const updated = store.upsertDerivedFact(
			baseInput(sessionId, {
				provenance: {
					scope_id: "scope-a",
					visibility: "shared",
					workspace_id: "shared:default",
					workspace_kind: "shared",
					trust_state: "unreviewed",
				},
			}),
		);
		expect(updated.outcome).toBe("updated");
		const row = store.db
			.prepare("SELECT trust_state FROM memory_items WHERE id = ?")
			.get(inserted.id) as { trust_state: string };
		expect(row.trust_state).toBe("unreviewed");
	});

	it("does not upgrade trust_state when a more-trusted source updates", () => {
		const sessionId = insertTestSession(store.db);
		const inserted = store.upsertDerivedFact(
			baseInput(sessionId, {
				provenance: {
					scope_id: "scope-a",
					visibility: "shared",
					workspace_id: "shared:default",
					workspace_kind: "shared",
					trust_state: "unreviewed",
				},
			}),
		);
		store.upsertDerivedFact(baseInput(sessionId)); // trusted source
		const row = store.db
			.prepare("SELECT trust_state FROM memory_items WHERE id = ?")
			.get(inserted.id) as { trust_state: string };
		expect(row.trust_state).toBe("unreviewed");
	});

	it("does not recreate forgotten derived fact tombstones", () => {
		const sessionId = insertTestSession(store.db);
		const inserted = store.upsertDerivedFact(baseInput(sessionId));
		expect(inserted.outcome).toBe("inserted");
		store.forget(inserted.id);

		const skipped = store.upsertDerivedFact(baseInput(sessionId));
		expect(skipped.outcome).toBe("skipped_tombstone");
		const rows = store.db
			.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE dedup_key = ?")
			.get(baseInput(sessionId).derivation.claim_key) as { count: number };
		expect(rows.count).toBe(1);
	});

	it("bypasses legacy title dedup and never mutates source observations", () => {
		const sessionId = insertTestSession(store.db);
		const sourceId = store.remember(
			sessionId,
			"decision",
			"Handlers must return structured errors",
			"Handlers must return structured errors instead of throwing uncaught exceptions.",
		);
		const result = store.upsertDerivedFact(
			baseInput(sessionId, {
				derivation: {
					...baseInput(sessionId).derivation,
					source: { session_ids: [sessionId], memory_ids: [sourceId] },
				},
			}),
		);

		expect(result.outcome).toBe("inserted");
		expect(result.id).not.toBe(sourceId);
		const source = store.db
			.prepare("SELECT metadata_json FROM memory_items WHERE id = ?")
			.get(sourceId) as { metadata_json: string | null };
		expect(fromJson(source.metadata_json).derivation).toBeUndefined();
	});

	it("preserves private visibility and least trusted state", () => {
		const sessionId = insertTestSession(store.db);
		const result = store.upsertDerivedFact(
			baseInput(sessionId, {
				provenance: {
					scope_id: "personal:actor",
					visibility: "private",
					workspace_id: "personal:actor",
					workspace_kind: "personal",
					trust_state: "unreviewed",
				},
			}),
		);
		expect(result.outcome).toBe("inserted");
		const row = store.db
			.prepare("SELECT visibility, workspace_id, trust_state FROM memory_items WHERE id = ?")
			.get(result.id) as { visibility: string; workspace_id: string; trust_state: string };
		expect(row).toMatchObject({
			visibility: "private",
			workspace_id: "personal:actor",
			trust_state: "unreviewed",
		});
	});

	it("skips active legacy rows with the same claim key", () => {
		const sessionId = insertTestSession(store.db);
		store.db
			.prepare(
				"INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, rev, scope_id, dedup_key) VALUES (?, 'decision', 'Legacy', 'Body', 0.5, '', 1, ?, ?, '{}', 1, 'scope-a', ?)",
			)
			.run(
				sessionId,
				new Date().toISOString(),
				new Date().toISOString(),
				baseInput(sessionId).derivation.claim_key,
			);

		expect(store.upsertDerivedFact(baseInput(sessionId)).outcome).toBe("skipped_legacy_conflict");
	});

	// Security: provenance must be explicit — never fail open to shared/trusted.
	it("rejects blank trust_state instead of laundering to trusted", () => {
		const sessionId = insertTestSession(store.db);
		expect(() =>
			store.upsertDerivedFact(
				baseInput(sessionId, {
					provenance: {
						scope_id: "personal:actor",
						visibility: "private",
						workspace_id: "personal:actor",
						workspace_kind: "personal",
						trust_state: "",
					},
				}),
			),
		).toThrow(/trust_state is required/);
	});

	it("rejects blank visibility instead of laundering to shared", () => {
		const sessionId = insertTestSession(store.db);
		expect(() =>
			store.upsertDerivedFact(
				baseInput(sessionId, {
					provenance: {
						scope_id: "personal:actor",
						visibility: "",
						workspace_id: "personal:actor",
						workspace_kind: "personal",
						trust_state: "unreviewed",
					},
				}),
			),
		).toThrow(/visibility is required/);
	});
});
