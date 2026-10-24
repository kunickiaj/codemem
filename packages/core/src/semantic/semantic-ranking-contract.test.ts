import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL } from "../embeddings.js";
import { getMaintenanceJob } from "../maintenance-jobs.js";
import {
	createFixture,
	MODEL,
	type RankingFixture,
	vector,
} from "./semantic-ranking.test-helper.js";
import {
	auditCorpus,
	type RankingRequest,
	rankExact,
} from "./semantic-ranking-reference.test-helper.js";

let directory: string;
let fixture: RankingFixture;
const LEGACY = "Xenova/bge-small-en-v1.5";
const CURRENT = DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "semantic-ranking-contract-"));
	vi.stubEnv("HOME", directory);
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	fixture = createFixture(directory);
});
afterEach(() => {
	fixture.db.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function request(overrides: Partial<RankingRequest> = {}): RankingRequest {
	return {
		query: { model: MODEL, vectors: [vector()] },
		limit: 2,
		filters: null,
		context: fixture.context,
		token: auditCorpus(fixture.db, { knownModels: [MODEL] }).token,
		...overrides,
	};
}

function migration(complete: boolean, status = "running") {
	getMaintenanceJob(fixture.db, "vector_model_migration");
	fixture.db
		.prepare(`INSERT INTO maintenance_jobs(kind, title, status, metadata_json, updated_at)
		VALUES ('vector_model_migration', 'Fixture migration', ?, ?, '2026-01-01')`)
		.run(
			status,
			JSON.stringify({
				source_model: LEGACY,
				target_model: CURRENT,
				reconciliation_target_coverage_complete: complete,
			}),
		);
}

it("rr91-catalog-from-accepted: rejects a mixed catalog even when the unknown label fails audit", () => {
	// Arrange: no migration job authorizes searching only one part of this catalog.
	fixture.rawVector(fixture.memory(), vector(1));
	const rejected = fixture.rawVector(fixture.memory(), vector(), 0, "unknown-model");
	const audit = auditCorpus(fixture.db, { knownModels: [MODEL] });
	const prepared = request({ token: audit.token });
	// Act
	const result = rankExact(fixture.db, prepared);
	// Assert: validity exclusion must not hide a label from model policy.
	expect(audit).toMatchObject({
		scanned: 2,
		accepted: 1,
		rejected: [{ rowid: rejected, reason: "model" }],
	});
	expect(result.results).toEqual([]);
	expect(result.probes).toEqual([]);
});

it.each([false, true])(
	"rr91-read-only-missing-maintenance: ranks without schema writes (mixed catalog: %s)",
	(mixed) => {
		// Arrange: removing a table affects only this disposable, owned fixture.
		const id = fixture.memory();
		fixture.rawVector(id, vector(1));
		if (mixed) fixture.rawVector(fixture.memory(), vector(), 0, "unknown-model");
		fixture.db.exec("DROP TABLE IF EXISTS maintenance_jobs");
		fixture.db.pragma("query_only = ON");
		const prepared = request();
		const schema = fixture.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
		// Act: audit and ranking must work while SQLite prohibits all writes.
		const result = rankExact(fixture.db, prepared);
		// Assert
		expect(result.results.map((item) => item.id)).toEqual(mixed ? [] : [id]);
		expect(fixture.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(
			schema,
		);
		expect(
			fixture.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'maintenance_jobs'").all(),
		).toEqual([]);
	},
);

it("stale-visible-scope-context: recomputes current scope visibility after a fresh audit", () => {
	// Arrange: the caller retained a previously visible scope, but current DB state denies it.
	const visible = fixture.memory();
	const hidden = fixture.memory("hidden");
	fixture.rawVector(visible, vector(1));
	fixture.rawVector(hidden, vector());
	const prepared = request({
		context: {
			...fixture.context,
			visibleScopeIds: ["local-default", "hidden"],
		},
	});
	// Act
	const result = rankExact(fixture.db, prepared);
	// Assert: a new corpus token must not revive old authorization.
	expect(result.results.map((item) => item.id)).toEqual([visible]);
});

it.each([
	["empty batch", [], MODEL, "query_vector_count_mismatch"],
	["multiple vectors", [vector(), vector()], MODEL, "query_vector_count_mismatch"],
	["wrong dimensions", [new Float32Array(383)], MODEL, "invalid_vector_shape"],
	["NaN", [vector(Number.NaN)], MODEL, "invalid_vector_nonfinite"],
	["Infinity", [vector(Number.POSITIVE_INFINITY)], MODEL, "invalid_vector_nonfinite"],
	["huge finite", [vector(1e30)], MODEL, "invalid_vector_norm"],
	["norm above two", [vector(2.01)], MODEL, "invalid_vector_norm"],
	["empty model", [vector()], "", "vector_model_required"],
	["unknown model", [vector()], "unknown", "unknown_query_model"],
] as const)(
	"rejects a prepared query with %s without changing the corpus",
	(_name, vectors, model, error) => {
		// Arrange
		fixture.rawVector(fixture.memory(), vector());
		const prepared = request({ query: { model, vectors } });
		const before = fixture.snapshot();
		// Act
		const rank = () => rankExact(fixture.db, prepared);
		// Assert
		expect(rank).toThrow(error);
		expect(fixture.snapshot()).toEqual(before);
		expect(fixture.db.inTransaction).toBe(false);
	},
);

it.each([1, 200])("accepts limit %i and query norm two without renormalizing distance", (limit) => {
	// Arrange
	const id = fixture.memory();
	fixture.rawVector(id, vector(-2));
	const prepared = request({ query: { model: MODEL, vectors: [vector(2)] }, limit });
	// Act
	const result = rankExact(fixture.db, prepared);
	// Assert
	expect(result.results.map((item) => [item.id, item.distance, item.score])).toEqual([
		[id, 4, 0.2],
	]);
});

it.each([0, -1, 201, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
	"rejects invalid limit %s",
	(limit) => {
		// Arrange
		const prepared = request({ limit });
		// Act
		const rank = () => rankExact(fixture.db, prepared);
		// Assert
		expect(rank).toThrow("semantic_limit_must_be_1_to_200");
	},
);

it.each([false, true])("rejects a forged token (copied valid token: %s)", (copyToken) => {
	// Arrange
	const prepared = request();
	const token = {} as RankingRequest["token"];
	if (copyToken) Object.assign(token, prepared.token);
	// Act
	const rank = () => rankExact(fixture.db, { ...prepared, token });
	// Assert
	expect(rank).toThrow("invalid_corpus_token");
});

it("rejects a valid token on another connection to the same database", () => {
	// Arrange
	const prepared = request();
	const other = new Database(fixture.path);
	try {
		// Act
		const rank = () => rankExact(other, prepared);
		// Assert
		expect(rank).toThrow("invalid_corpus_token");
	} finally {
		other.close();
	}
});

it.each(["same-count vector update", "deleted rowid reuse"])(
	"invalidates tokens after %s",
	(change) => {
		// Arrange
		const id = fixture.memory();
		const rowid = fixture.rawVector(id, vector(1));
		const prepared = request();
		if (change === "same-count vector update") {
			fixture.db
				.prepare("UPDATE memory_vectors SET embedding = ? WHERE rowid = ?")
				.run(Buffer.from(vector(0.5).buffer), BigInt(rowid));
		} else {
			fixture.db.prepare("DELETE FROM memory_vectors WHERE rowid = ?").run(BigInt(rowid));
			fixture.db
				.prepare(`INSERT INTO memory_vectors(rowid, embedding, memory_id, chunk_index, content_hash, model)
			VALUES (?, ?, ?, 0, 'reused', ?)`)
				.run(BigInt(rowid), Buffer.from(vector(0.5).buffer), BigInt(id), MODEL);
		}
		// Act
		const staleRank = () => rankExact(fixture.db, prepared);
		// Assert: count and rowid equality cannot substitute for a version check.
		expect(fixture.db.prepare("SELECT rowid FROM memory_vectors").all()).toEqual([{ rowid }]);
		expect(staleRank).toThrow("stale_corpus_token_reaudit_required");
		expect(rankExact(fixture.db, request()).results.map((item) => item.distance)).toEqual([0.5]);
	},
);

it.each([
	[false, "running", [LEGACY, CURRENT]],
	[true, "running", [CURRENT]],
	[true, "completed", [CURRENT]],
] as const)(
	"uses compatible model labels with coverage=%s and status=%s",
	(complete, status, models) => {
		// Arrange: one memory has chunks in both compatible labels; an unrelated label is closer.
		const first = fixture.memory();
		const second = fixture.memory();
		fixture.rawVector(first, vector(1), 0, LEGACY);
		fixture.rawVector(first, vector(0.25), 0, CURRENT);
		fixture.rawVector(second, vector(0.5), 0, LEGACY);
		fixture.rawVector(second, vector(1.5), 0, CURRENT);
		fixture.rawVector(fixture.memory(), vector(), 0, MODEL);
		migration(complete, status);
		const token = auditCorpus(fixture.db, { knownModels: [LEGACY, CURRENT, MODEL] }).token;
		const prepared = request({ query: { model: CURRENT, vectors: [vector()] }, token });
		// Act
		const result = rankExact(fixture.db, prepared);
		// Assert: MIN is global per memory, while policy selects the model labels before each probe.
		expect(result.probes.map((probe) => probe.model).sort()).toEqual([...models].sort());
		expect(result.results.map((item) => [item.id, item.distance])).toEqual([
			[first, 0.25],
			[second, complete ? 1.5 : 0.5],
		]);
		expect(result).toMatchObject({ strategy: "native", fallbackCount: 0 });
	},
);

it("does not search a partial target when the migration source model is incompatible", () => {
	// Arrange
	fixture.rawVector(fixture.memory(), vector(1), 0, "incompatible-source");
	fixture.rawVector(fixture.memory(), vector(0.25), 0, MODEL);
	getMaintenanceJob(fixture.db, "vector_model_migration");
	fixture.db
		.prepare(`INSERT INTO maintenance_jobs(kind, title, status, metadata_json, updated_at)
		VALUES ('vector_model_migration', 'Fixture', 'running', ?, '2026-01-01')`)
		.run(JSON.stringify({ source_model: "incompatible-source", target_model: MODEL }));
	const token = auditCorpus(fixture.db, { knownModels: ["incompatible-source", MODEL] }).token;
	// Act
	const result = rankExact(fixture.db, request({ token }));
	// Assert
	expect(result.results).toEqual([]);
	expect(result.probes).toEqual([]);
});

it.each(["scope revocation", "model cutover"])(
	"rejects queued ranking after another connection commits %s",
	(change) => {
		// Arrange: capture the request, commit the change, then run it; no timers or races.
		const id = fixture.memory();
		fixture.rawVector(id, vector(1), 0, LEGACY);
		fixture.rawVector(id, vector(0.25), 0, CURRENT);
		migration(false);
		fixture.db.pragma("journal_mode = WAL");
		const prepared = request({
			query: { model: CURRENT, vectors: [vector()] },
			token: auditCorpus(fixture.db, { knownModels: [LEGACY, CURRENT] }).token,
		});
		const other = new Database(fixture.path);
		try {
			if (change === "scope revocation") {
				other.prepare("UPDATE memory_items SET scope_id = 'hidden' WHERE id = ?").run(id);
			} else {
				other
					.prepare(
						"UPDATE maintenance_jobs SET status = 'completed' WHERE kind = 'vector_model_migration'",
					)
					.run();
			}
		} finally {
			other.close();
		}
		// Act
		const staleRank = () => rankExact(fixture.db, prepared);
		// Assert
		expect(staleRank).toThrow("stale_corpus_token_reaudit_required");
		const token = auditCorpus(fixture.db, { knownModels: [LEGACY, CURRENT] }).token;
		const fresh = rankExact(fixture.db, { ...prepared, token });
		expect(fresh.results.map((item) => item.id)).toEqual(change === "scope revocation" ? [] : [id]);
		if (change === "model cutover")
			expect(fresh.probes.map((probe) => probe.model)).toEqual([CURRENT]);
	},
);

it.each(["fixture", "other", "fixture' OR 1=1 --"])(
	"applies project filter %s before ranking",
	(project) => {
		// Arrange
		const visible = fixture.memory();
		const other = fixture.memory();
		fixture.db
			.prepare("INSERT INTO sessions(started_at, project) VALUES ('2026-01-01', 'other')")
			.run();
		fixture.db.prepare("UPDATE memory_items SET session_id = 2 WHERE id = ?").run(other);
		fixture.rawVector(visible, vector(1));
		fixture.rawVector(other, vector());
		const prepared = request({ filters: { project } });
		// Act
		const result = rankExact(fixture.db, prepared);
		// Assert
		const expected = new Map([
			["fixture", [visible]],
			["other", [other]],
		]);
		expect(result.results.map((item) => item.id)).toEqual(expected.get(project) ?? []);
	},
);

it.each(["mine", "theirs"])(
	"applies ownership filter %s to actual identity columns",
	(ownership_scope) => {
		// Arrange
		const mine = fixture.memory();
		const theirs = fixture.memory();
		fixture.db
			.prepare(
				"UPDATE memory_items SET actor_id = 'local:other', origin_device_id = 'other' WHERE id = ?",
			)
			.run(theirs);
		fixture.rawVector(mine, vector(1));
		fixture.rawVector(theirs, vector());
		const prepared = request({ filters: { ownership_scope } });
		// Act
		const result = rankExact(fixture.db, prepared);
		// Assert
		expect(result.results.map((item) => item.id)).toEqual([
			ownership_scope === "mine" ? mine : theirs,
		]);
	},
);

it.each([undefined, null, 1, 2])(
	"applies summary continuity with session %s",
	(summarySessionId) => {
		// Arrange
		const ordinary = fixture.memory();
		const summary = fixture.memory();
		fixture.db
			.prepare("UPDATE memory_items SET kind = 'session_summary' WHERE id = ?")
			.run(summary);
		fixture.rawVector(ordinary, vector(1));
		fixture.rawVector(summary, vector());
		const prepared = request({ summarySessionId });
		// Act
		const result = rankExact(fixture.db, prepared);
		// Assert
		const allowed = summarySessionId === undefined || summarySessionId === 1;
		expect(result.results.map((item) => item.id)).toEqual(
			allowed ? [summary, ordinary] : [ordinary],
		);
	},
);
