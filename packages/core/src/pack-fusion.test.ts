import { describe, expect, it } from "vitest";
import { buildMemoryPackWithTrace } from "./pack.js";
import { fusePackCandidates } from "./pack-fusion.js";
import { scoreResult, search } from "./search.js";
import { MemoryStore } from "./store.js";
import { insertTestSession } from "./test-utils.js";
import type { MemoryResult } from "./types.js";

function memory(id: number, score: number): MemoryResult {
	return {
		id,
		score,
		kind: "discovery",
		title: `item ${id}`,
		body_text: "evidence",
		confidence: 0.8,
		created_at: "2026-01-01",
		updated_at: "2026-01-01",
		tags_text: "",
		session_id: 1,
		metadata: {},
		narrative: null,
		facts: null,
	};
}

describe("pack reciprocal rank fusion", () => {
	it("keeps hybrid pack ranking invariant to semantic scale and input order", () => {
		// Arrange
		const store = new MemoryStore(":memory:");
		try {
			const session = insertTestSession(store.db);
			const exactId = store.remember(
				session,
				"decision",
				"RFC-427",
				"RFC-427 defines the retry protocol",
				0.9,
			);
			store.remember(
				session,
				"discovery",
				"Retry protocol notes",
				"Background notes that mention RFC-427",
				0.8,
			);
			const semanticOnlyId = store.remember(
				session,
				"discovery",
				"Transport backoff",
				"Semantically related transport guidance",
				0.8,
			);
			const semantic = [memory(semanticOnlyId, 0.99), memory(exactId, 0.5)];
			const rescaledAndShuffled = [memory(exactId, 500), memory(semanticOnlyId, 990)];
			const exactFtsRank =
				search(store, "RFC-427", 10).findIndex((item) => item.id === exactId) + 1;

			// Act
			const baseline = buildMemoryPackWithTrace(store, "RFC-427", 10, null, undefined, semantic);
			const rescaled = buildMemoryPackWithTrace(
				store,
				"RFC-427",
				10,
				null,
				undefined,
				rescaledAndShuffled,
			);

			// Assert
			expect(exactFtsRank).toBeGreaterThan(0);
			expect(rescaled.response.item_ids).toEqual(baseline.response.item_ids);
			expect(baseline.response.item_ids[0]).toBe(exactId);
			expect(
				baseline.trace.retrieval.candidates.find((item) => item.id === exactId)?.scores.fusion,
			).toMatchObject({ fts_rank: exactFtsRank, semantic_rank: 2, fusion_rank: 1 });
			expect(
				rescaled.trace.retrieval.candidates.find((item) => item.id === exactId)?.scores.fusion,
			).toMatchObject({
				fts_rank: exactFtsRank,
				semantic_rank: 2,
				fusion_rank: 1,
				semantic_score: 500,
			});
		} finally {
			store.close();
		}
	});

	it.each(["quasar", "continue quasar", "recall quasar"])(
		"retains both channel traces for %s",
		(query) => {
			const store = new MemoryStore(":memory:");
			try {
				const session = insertTestSession(store.db);
				const id = store.remember(session, "discovery", "quasar", "quasar evidence", 0.8);
				const lexical = search(store, query, 10);
				const { trace } = buildMemoryPackWithTrace(store, query, 10, null, undefined, [
					memory(id, 0.7),
				]);
				const scores = trace.retrieval.candidates.find((item) => item.id === id)?.scores;
				expect(scores?.fusion).toMatchObject({
					fts_rank: 1,
					semantic_rank: 1,
					semantic_score: 0.7,
					fusion_rank: 1,
				});
				expect(scores?.fusion?.fused_score).toBe(2 / 61);
				const lexicalItem = lexical[0];
				if (!lexicalItem) throw new Error("fixture must produce a lexical candidate");
				expect(scores?.combined_score).toBe(
					scoreResult(store, lexicalItem, undefined, query).combined_score,
				);
				if (query === "quasar") expect(scores?.fusion?.fts_score).toBe(lexical[0]?.score);
			} finally {
				store.close();
			}
		},
	);

	it("converts scoped semantic metadata like keyword metadata rather than trusting supplied fields", () => {
		// Arrange
		const store = new MemoryStore(":memory:");
		try {
			const session = insertTestSession(store.db);
			const lexicalId = store.remember(session, "discovery", "quasar", "quasar evidence", 0.8);
			const semanticId = store.remember(session, "discovery", "nebula", "nebula evidence", 0.8);
			store.db
				.prepare(
					`UPDATE memory_items
					 SET metadata_json = ?, actor_id = ?, actor_display_name = ?, visibility = ?,
					     workspace_id = ?, workspace_kind = ?, origin_device_id = ?, origin_source = ?,
					     trust_state = ?
					 WHERE id = ?`,
				)
				.run(
					JSON.stringify({ actor_id: "forged", custom: "retained", workspace_id: "forged" }),
					store.actorId,
					"Local Tester",
					"private",
					"workspace-real",
					"repository",
					store.deviceId,
					"opencode",
					"reviewed",
					semanticId,
				);
			const expected = search(store, "nebula", 10)[0]?.metadata;
			const supplied = {
				...memory(semanticId, 0.8),
				metadata: {
					actor_id: "forged",
					origin_device_id: "forged",
					trust_state: "forged",
					workspace_id: "forged",
				},
			};

			// Act
			const { response, trace } = buildMemoryPackWithTrace(store, "quasar", 10, null, undefined, [
				supplied,
			]);

			// Assert
			expect(response.items.find((item) => item.id === semanticId)?.metadata).toEqual(expected);
			expect(expected).toMatchObject({
				actor_id: store.actorId,
				actor_display_name: "Local Tester",
				custom: "retained",
				origin_device_id: store.deviceId,
				origin_source: "opencode",
				trust_state: "reviewed",
				visibility: "private",
				workspace_id: "workspace-real",
				workspace_kind: "repository",
			});
			expect(
				trace.retrieval.candidates.find((item) => item.id === lexicalId)?.scores.fusion
					?.semantic_rank,
			).toBeNull();
			expect(
				trace.retrieval.candidates.find((item) => item.id === semanticId)?.scores.fusion?.fts_rank,
			).toBeNull();
		} finally {
			store.close();
		}
	});

	it("is invariant to independent channel scales and preserves raw evidence", () => {
		const fts = [memory(1, 37.8), memory(2, 12)];
		const semantic = [memory(3, 0.9), memory(2, 0.61)];
		const fused = fusePackCandidates(fts, semantic, () => 0);
		const scaled = fusePackCandidates(
			fts.map((item) => ({ ...item, score: item.score / 10000 })),
			semantic.map((item) => ({ ...item, score: item.score * 1000 })),
			() => 0,
		);
		expect(fused.map(({ item }) => item.id)).toEqual([2, 1, 3]);
		expect(scaled.map(({ item }) => item.id)).toEqual([2, 1, 3]);
		expect(fused[0]?.evidence).toMatchObject({
			fts_score: 12,
			semantic_score: 0.61,
			fts_rank: 2,
			semantic_rank: 2,
		});
		expect(fused[0]?.item.score).toBe(12);
		expect(fts[0]?.score).toBe(37.8);
	});

	it("counts each channel once and ignores malformed evidence without rank gaps", () => {
		const fused = fusePackCandidates(
			[memory(1, 4), memory(1, 2), memory(-1, 100), memory(4, Number.NaN)],
			[memory(2, Number.POSITIVE_INFINITY), memory(2, 0.8), memory(1, 0.7), memory(1, 0.6)],
			() => 0,
		);
		expect(fused.map(({ item }) => item.id)).toEqual([1, 2]);
		expect(fused[0]?.evidence.fused_score).toBe(1 / 61 + 1 / 62);
		expect(fused[1]?.evidence.semantic_rank).toBe(1);
	});

	it("deduplicates and rejects malformed semantic evidence in the hybrid pack trace", () => {
		// Arrange
		const store = new MemoryStore(":memory:");
		try {
			const session = insertTestSession(store.db);
			const firstId = store.remember(
				session,
				"discovery",
				"Hybrid duplicate first",
				"hybridduplicate evidence",
				0.8,
			);
			const secondId = store.remember(
				session,
				"discovery",
				"Hybrid duplicate second",
				"hybridduplicate evidence",
				0.8,
			);
			const malformedStoredId = store.remember(
				session,
				"discovery",
				"Malformed score",
				"hybridduplicate evidence",
				0.8,
			);
			const semantic = [
				memory(secondId, 0.1),
				memory(-1, 100),
				memory(firstId, 0.8),
				memory(malformedStoredId, Number.NaN),
				memory(secondId, 0.9),
				memory(Number.MAX_SAFE_INTEGER + 1, 200),
			];

			// Act
			const { trace } = buildMemoryPackWithTrace(
				store,
				"hybridduplicate",
				10,
				null,
				undefined,
				semantic,
			);
			const shuffled = buildMemoryPackWithTrace(store, "hybridduplicate", 10, null, undefined, [
				memory(secondId, 0.9),
				memory(malformedStoredId, Number.NaN),
				memory(secondId, 0.1),
				memory(firstId, 0.8),
			]).trace;
			const candidates = trace.retrieval.candidates;
			const firstFusion = candidates.find((item) => item.id === firstId)?.scores.fusion;
			const secondFusion = candidates.find((item) => item.id === secondId)?.scores.fusion;
			const semanticRanks = (candidateTrace: typeof trace) =>
				candidateTrace.retrieval.candidates
					.filter((item) => item.scores.fusion?.semantic_rank != null)
					.map((item) => [item.id, item.scores.fusion?.semantic_rank]);

			// Assert
			expect(candidates.filter((item) => item.id === secondId)).toHaveLength(1);
			expect(secondFusion).toMatchObject({ semantic_rank: 1, semantic_score: 0.9 });
			expect(firstFusion).toMatchObject({ semantic_rank: 2, semantic_score: 0.8 });
			expect(semanticRanks(shuffled)).toEqual(semanticRanks(trace));
			expect(candidates.map((item) => item.id)).not.toContain(-1);
			expect(candidates.map((item) => item.id)).not.toContain(Number.MAX_SAFE_INTEGER + 1);
			expect(
				candidates.find((item) => item.id === malformedStoredId)?.scores.fusion?.semantic_rank,
			).toBeNull();
		} finally {
			store.close();
		}
	});

	it("preserves empty and single-channel behavior", () => {
		// Arrange
		const fts = [memory(2, 1), memory(1, 2)];
		const semantic = [memory(4, 0.6), memory(3, 0.8)];

		// Act
		const empty = fusePackCandidates([], [], () => 0);
		const ftsOnly = fusePackCandidates(fts, [], () => 0);
		const semanticOnly = fusePackCandidates([], semantic, () => 0);

		// Assert
		expect(empty).toEqual([]);
		expect(ftsOnly.map(({ item }) => item.id)).toEqual([1, 2]);
		expect(ftsOnly.map(({ evidence }) => evidence.semantic_rank)).toEqual([null, null]);
		expect(semanticOnly.map(({ item }) => item.id)).toEqual([3, 4]);
		expect(semanticOnly.map(({ evidence }) => evidence.fts_rank)).toEqual([null, null]);
	});

	it("keeps project, visibility, scope, and requester-session gates on hybrid candidates", () => {
		// Arrange
		const store = new MemoryStore(":memory:");
		try {
			const currentSession = insertTestSession(store.db);
			const foreignSession = insertTestSession(store.db);
			const otherProjectSession = Number(
				store.db
					.prepare(
						"INSERT INTO sessions(started_at, cwd, project, user, tool_version) VALUES (?, ?, ?, ?, ?)",
					)
					.run(
						"2026-01-01T00:00:00.000Z",
						"/tmp/other-project",
						"other-project",
						"test-user",
						"test",
					).lastInsertRowid,
			);
			store.db
				.prepare(
					"INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run(
					"opencode",
					"host-current",
					"host-current",
					currentSession,
					"2026-01-01T00:00:00.000Z",
				);
			const currentSummaryId = store.remember(
				currentSession,
				"session_summary",
				"Current boundary summary",
				"boundaryhybrid evidence",
				0.9,
			);
			const durableId = store.remember(
				foreignSession,
				"decision",
				"Durable boundary fact",
				"boundaryhybrid evidence",
				0.8,
			);
			const foreignSummaryId = store.remember(
				foreignSession,
				"session_summary",
				"Foreign boundary summary",
				"boundaryhybrid evidence",
				0.99,
			);
			const wrongProjectId = store.remember(
				otherProjectSession,
				"decision",
				"Wrong project boundary fact",
				"boundaryhybrid evidence",
				0.99,
			);
			const foreignPrivateId = store.remember(
				foreignSession,
				"decision",
				"Foreign private boundary fact",
				"boundaryhybrid evidence",
				0.99,
			);
			store.db
				.prepare(
					"UPDATE memory_items SET actor_id = 'remote-actor', origin_device_id = 'remote-device', visibility = 'private' WHERE id = ?",
				)
				.run(foreignPrivateId);
			const foreignPrivateRow = store.db
				.prepare("SELECT * FROM memory_items WHERE id = ?")
				.get(foreignPrivateId) as Record<string, unknown>;
			expect(store.memoryOwnedBySelf(foreignPrivateRow)).toBe(false);
			store.db
				.prepare(
					`INSERT INTO replication_scopes(
						scope_id, label, kind, authority_type, coordinator_id, group_id,
						membership_epoch, status, created_at, updated_at
					 ) VALUES (?, ?, 'team', 'coordinator', 'fixture-coordinator', 'fixture-group', 0, 'active', ?, ?)`,
				)
				.run(
					"hidden-boundary-scope",
					"Hidden boundary scope",
					"2026-01-01T00:00:00.000Z",
					"2026-01-01T00:00:00.000Z",
				);
			const hiddenSharedId = store.remember(
				foreignSession,
				"decision",
				"Hidden shared boundary fact",
				"boundaryhybrid evidence",
				0.99,
			);
			store.db
				.prepare("UPDATE memory_items SET visibility = 'shared', scope_id = ? WHERE id = ?")
				.run("hidden-boundary-scope", hiddenSharedId);
			const allIds = [
				currentSummaryId,
				durableId,
				foreignSummaryId,
				wrongProjectId,
				foreignPrivateId,
				hiddenSharedId,
			];

			// Act
			const { response, trace } = buildMemoryPackWithTrace(
				store,
				"boundaryhybrid",
				10,
				null,
				// Local-default rows pass the scope gate regardless of ownership.
				// Exercise visibility explicitly rather than assuming a private-row deny rule.
				{ project: "test-project", include_visibility: ["shared"] },
				allIds.map((id, index) => memory(id, 1 - index / 10)),
				undefined,
				{ source: "opencode", hostSessionId: "host-current" },
			);
			const candidateIds = trace.retrieval.candidates.map((item) => item.id);

			// Assert
			expect(response.item_ids).toContain(currentSummaryId);
			expect(response.item_ids).toContain(durableId);
			for (const hiddenId of [foreignSummaryId, wrongProjectId, foreignPrivateId, hiddenSharedId]) {
				expect(candidateIds).not.toContain(hiddenId);
				expect(response.item_ids).not.toContain(hiddenId);
			}
		} finally {
			store.close();
		}
	});

	it("lets preferences break ties but never overtake stronger fused relevance", () => {
		const fused = fusePackCandidates([memory(1, 10), memory(2, 9)], [memory(3, 0.8)], (item) =>
			item.id === 1 ? -1000 : 1000,
		);
		expect(fused.map(({ item }) => item.id)).toEqual([3, 1, 2]);
	});
});
