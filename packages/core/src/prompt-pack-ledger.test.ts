import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { buildMemoryPackWithTrace } from "./pack.js";
import {
	clonePromptPackAttempt,
	promptPackArtifactFingerprint,
	recordPromptPackArtifacts,
	recordPromptPackTerminal,
} from "./prompt-pack-ledger.js";
import { getRetrievalAttempt, updateRetrievalDelivery } from "./retrieval-ledger.js";
import { MemoryStore } from "./store.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import type { MemoryResult } from "./types.js";

const startedAt = "2026-08-03T10:00:00.000Z";
const completedAt = "2026-08-03T10:00:00.025Z";

function id(sequence: number): string {
	return `018f2db4-f9d3-7a22-8d18-${sequence.toString(16).padStart(12, "0")}`;
}

describe("prompt-pack retrieval ledger", () => {
	let directory: string;
	let storePath: string;
	let store: MemoryStore;
	let sessionId: number;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "codemem-prompt-pack-ledger-"));
		storePath = join(directory, "test.sqlite");
		const db = connect(storePath);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(storePath);
		sessionId = insertTestSession(store.db);
	});

	afterEach(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it("persists trace-derived selected exposures with hydrated snapshots and no sensitive text", () => {
		const memoryId = store.remember(
			sessionId,
			"decision",
			"PRIVATE TITLE MUST NOT PERSIST",
			"PRIVATE BODY MUST NOT PERSIST",
			0.9,
		);
		store.db
			.prepare("UPDATE memory_items SET import_key = ? WHERE id = ?")
			.run("/private/tmp/forbidden-import-key", memoryId);
		const artifacts = buildMemoryPackWithTrace(store, "PRIVATE PROMPT MUST NOT PERSIST", 10);

		const outcome = recordPromptPackArtifacts(
			store.db,
			{
				attemptId: id(1),
				startedAt,
				completedAt,
				source: "opencode",
				requestId: "request-1",
			},
			"PRIVATE PROMPT MUST NOT PERSIST",
			{
				project: "/private/tmp/forbidden-project",
				working_set_paths: [
					"./packages/core/src/pack.ts",
					"packages\\core\\src\\pack.ts",
					"/private/tmp/forbidden-working-set.ts",
				],
			},
			artifacts,
		);

		expect(outcome.ok).toBe(true);
		const attempt = getRetrievalAttempt(store.db, id(1));
		expect(attempt).toMatchObject({
			retrievalStatus: "succeeded",
			deliveryStatus: "not_attempted",
			traceVersion: 1,
			workingSetFileCount: 3,
			workingSetFiles: ["packages/core/src/pack.ts"],
			project: null,
			latencyMs: 25,
		});
		expect(attempt?.exposures.find((exposure) => exposure.memoryId === memoryId)).toMatchObject({
			disposition: "selected",
			memoryImportKey: null,
			memoryKind: "decision",
			memoryActive: true,
			handoffStatus: "not_attempted",
		});
		const persisted = JSON.stringify([
			store.db.prepare("SELECT * FROM retrieval_attempts WHERE attempt_id = ?").get(id(1)),
			store.db.prepare("SELECT * FROM retrieval_exposures WHERE attempt_id = ?").all(id(1)),
		]);
		for (const sensitive of [
			"PRIVATE TITLE MUST NOT PERSIST",
			"PRIVATE BODY MUST NOT PERSIST",
			"PRIVATE PROMPT MUST NOT PERSIST",
			"/private/tmp/forbidden-import-key",
			"/private/tmp/forbidden-project",
			"/private/tmp/forbidden-working-set.ts",
		]) {
			expect(persisted).not.toContain(sensitive);
		}
		expect(persisted).toContain("packages/core/src/pack.ts");
		expect(attempt?.exposures.flatMap((exposure) => exposure.reasonCodes ?? [])).toEqual(
			expect.arrayContaining([expect.stringMatching(/^[a-z0-9][a-z0-9._-]{0,63}$/)]),
		);
	});

	it("treats an exact caller retry as idempotent", () => {
		store.remember(sessionId, "feature", "Retry candidate", "retry body", 0.8);
		const artifacts = buildMemoryPackWithTrace(store, "retry candidate", 10);
		const metadata = {
			attemptId: id(10),
			startedAt,
			completedAt,
			source: "opencode",
			requestId: "stable-request-10",
		};

		const first = recordPromptPackArtifacts(
			store.db,
			metadata,
			"retry candidate",
			undefined,
			artifacts,
		);
		const retry = recordPromptPackArtifacts(
			store.db,
			metadata,
			"retry candidate",
			undefined,
			artifacts,
		);

		expect(first.ok && first.value.inserted).toBe(true);
		expect(retry.ok && retry.value.inserted).toBe(false);
		expect(
			store.db
				.prepare("SELECT COUNT(*) AS count FROM retrieval_attempts WHERE attempt_id = ?")
				.get(id(10)),
		).toEqual({ count: 1 });
	});

	it("reconciles persisted timing for an exact artifact retry with caller started_at drift", () => {
		store.remember(sessionId, "feature", "Timing retry candidate", "retry body", 0.8);
		const artifacts = buildMemoryPackWithTrace(store, "timing retry candidate", 10);
		const metadata = {
			attemptId: id(17),
			startedAt,
			completedAt,
			source: "opencode",
			requestId: "stable-request-17",
		};
		expect(
			recordPromptPackArtifacts(store.db, metadata, "timing retry candidate", undefined, artifacts)
				.ok,
		).toBe(true);

		const retry = recordPromptPackArtifacts(
			store.db,
			{
				...metadata,
				startedAt: "2026-08-03T10:00:01.000Z",
				completedAt: "2026-08-03T10:00:01.125Z",
			},
			"timing retry candidate",
			undefined,
			artifacts,
		);

		expect(retry.ok && retry.value.inserted).toBe(false);
		expect(getRetrievalAttempt(store.db, id(17))).toMatchObject({
			startedAt,
			completedAt,
			latencyMs: 25,
		});
	});

	it("reconciles persisted timing for an exact terminal retry with caller started_at drift", () => {
		const metadata = {
			attemptId: id(18),
			startedAt,
			completedAt,
			source: "opencode",
			requestId: "stable-request-18",
		};
		expect(
			recordPromptPackTerminal(store.db, metadata, "failed", "pack_command_failed", "transport").ok,
		).toBe(true);

		const retry = recordPromptPackTerminal(
			store.db,
			{
				...metadata,
				startedAt: "2026-08-03T10:00:01.000Z",
				completedAt: "2026-08-03T10:00:01.125Z",
			},
			"failed",
			"pack_command_failed",
			"transport",
		);

		expect(retry.ok && retry.value.inserted).toBe(false);
		expect(getRetrievalAttempt(store.db, id(18))).toMatchObject({
			startedAt,
			completedAt,
			latencyMs: 25,
		});
	});

	it("rejects changed artifacts after restart while exact persisted retries remain idempotent", () => {
		store.remember(sessionId, "feature", "Changing retry candidate", "first body", 0.8);
		const metadata = {
			attemptId: id(11),
			startedAt,
			completedAt,
			source: "opencode",
			requestId: "stable-request-11",
		};
		const firstArtifacts = buildMemoryPackWithTrace(store, "changing retry candidate", 10);
		expect(
			recordPromptPackArtifacts(
				store.db,
				metadata,
				"changing retry candidate",
				undefined,
				firstArtifacts,
			).ok,
		).toBe(true);
		store.close();
		store = new MemoryStore(storePath);
		const exactPersistedRetry = recordPromptPackArtifacts(
			store.db,
			metadata,
			"changing retry candidate",
			undefined,
			firstArtifacts,
		);
		expect(exactPersistedRetry.ok && exactPersistedRetry.value.inserted).toBe(false);

		store.remember(sessionId, "decision", "Changing retry candidate second", "second body", 0.9);
		const changedArtifacts = buildMemoryPackWithTrace(store, "changing retry candidate", 10);
		const retry = recordPromptPackArtifacts(
			store.db,
			{
				...metadata,
				startedAt: "2026-08-03T10:00:01.000Z",
				completedAt: "2026-08-03T10:00:01.125Z",
			},
			"changing retry candidate",
			undefined,
			changedArtifacts,
		);

		expect(retry).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "idempotency_conflict",
		});
	});

	it("distinguishes no-results from candidates trimmed to zero selections", () => {
		const emptyArtifacts = buildMemoryPackWithTrace(store, "nothing matches", 10);
		recordPromptPackArtifacts(
			store.db,
			{ attemptId: id(2), startedAt, completedAt, source: "opencode", requestId: "request-2" },
			"nothing matches",
			undefined,
			emptyArtifacts,
		);

		store.remember(sessionId, "feature", "Large candidate", "x".repeat(200), 0.8);
		const trimmedArtifacts = buildMemoryPackWithTrace(store, "large candidate", 10, 1);
		recordPromptPackArtifacts(
			store.db,
			{ attemptId: id(3), startedAt, completedAt, source: "opencode", requestId: "request-3" },
			"large candidate",
			undefined,
			trimmedArtifacts,
		);
		const fallbackTrimmedArtifacts = buildMemoryPackWithTrace(store, "zzz_nomatch_zzz", 10, 1);
		recordPromptPackArtifacts(
			store.db,
			{ attemptId: id(12), startedAt, completedAt, source: "opencode", requestId: "request-12" },
			"zzz_nomatch_zzz",
			undefined,
			fallbackTrimmedArtifacts,
		);

		expect(getRetrievalAttempt(store.db, id(2))?.retrievalStatus).toBe("no_results");
		expect(getRetrievalAttempt(store.db, id(3))).toMatchObject({
			retrievalStatus: "succeeded",
			candidateCount: 1,
			selectedCount: 0,
		});
		expect(getRetrievalAttempt(store.db, id(12))).toMatchObject({
			retrievalStatus: "succeeded",
			candidateCount: 1,
			selectedCount: 0,
		});
	});

	it("persists an injected summary fallback that is later trimmed by the budget", () => {
		const summaryId = store.remember(
			sessionId,
			"session_summary",
			"Latest unrelated summary",
			"A fallback summary that cannot fit into the one-token rendering budget.",
			0.9,
		);
		const resultId = store.remember(
			sessionId,
			"decision",
			"Pulsar retrieval result",
			"A matching result that also cannot fit into the one-token rendering budget.",
			0.8,
		);

		const artifacts = buildMemoryPackWithTrace(store, "pulsar retrieval", 10, 1);
		const candidateIds = artifacts.trace.retrieval.candidates.map((candidate) => candidate.id);

		expect(artifacts.response.items).toHaveLength(0);
		expect(artifacts.trace.retrieval.candidate_count).toBe(2);
		expect(candidateIds).toEqual([resultId, summaryId]);
		expect(new Set(candidateIds).size).toBe(2);
		expect(
			artifacts.trace.retrieval.candidates.every(
				(candidate) => candidate.disposition === "trimmed" && candidate.section === null,
			),
		).toBe(true);

		recordPromptPackArtifacts(
			store.db,
			{ attemptId: id(16), startedAt, completedAt, source: "opencode", requestId: "request-16" },
			"pulsar retrieval",
			undefined,
			artifacts,
		);
		const attempt = getRetrievalAttempt(store.db, id(16));
		expect(attempt).toMatchObject({
			retrievalStatus: "succeeded",
			candidateCount: 2,
			selectedCount: 0,
		});
		expect(attempt?.exposures.map((exposure) => exposure.memoryId)).toEqual(candidateIds);
		expect(
			attempt?.exposures.every(
				(exposure) =>
					exposure.disposition === "trimmed" &&
					exposure.reasonCodes?.includes("disposition.trimmed"),
			),
		).toBe(true);
	});

	it.each([
		["default", "lexical union needle"],
		["task", "next task lexical union needle"],
		["recall", "remember lexical union needle"],
	])("traces and persists the disjoint FTS-semantic union in %s mode", (_mode, query) => {
		// Arrange
		const ftsId = store.remember(
			sessionId,
			"discovery",
			"Lexical union needle",
			"The FTS-only candidate.",
			0.8,
		);
		const semanticId = store.remember(
			sessionId,
			"discovery",
			"Semantic-only candidate",
			"Unrelated text supplied through semantic retrieval.",
			0.9,
		);
		const semanticResults: MemoryResult[] = [
			{
				id: semanticId,
				kind: "discovery",
				title: "Semantic-only candidate",
				body_text: "Unrelated text supplied through semantic retrieval.",
				confidence: 0.9,
				created_at: "2026-08-03T09:00:00.000Z",
				updated_at: "2026-08-03T09:00:00.000Z",
				tags_text: "",
				score: 0.99,
				session_id: sessionId,
				metadata: {},
				narrative: null,
				facts: null,
			},
		];

		// Act
		const originalRecentByKinds = store.recentByKinds.bind(store);
		(store as unknown as { recentByKinds: typeof store.recentByKinds }).recentByKinds = () => [];
		const artifacts = (() => {
			try {
				return buildMemoryPackWithTrace(store, query, 1, null, undefined, semanticResults);
			} finally {
				(store as unknown as { recentByKinds: typeof store.recentByKinds }).recentByKinds =
					originalRecentByKinds;
			}
		})();
		const candidateIds = artifacts.trace.retrieval.candidates.map((candidate) => candidate.id);
		recordPromptPackArtifacts(
			store.db,
			{ attemptId: id(21), startedAt, completedAt, source: "opencode", requestId: "request-21" },
			query,
			undefined,
			artifacts,
		);
		const attempt = getRetrievalAttempt(store.db, id(21));

		// Assert
		expect(candidateIds).toEqual([ftsId, semanticId]);
		expect(
			artifacts.trace.retrieval.candidates.filter(
				(candidate) => candidate.disposition === "selected",
			),
		).toHaveLength(1);
		expect(attempt).toMatchObject({ candidateCount: 2, selectedCount: 1 });
		expect(attempt?.exposures.map((exposure) => exposure.memoryId)).toEqual([ftsId, semanticId]);
		expect(attempt?.exposures.some((exposure) => exposure.disposition === "dropped")).toBe(true);
	});

	it("persists a trimmed working-set file-ref candidate as an evaluated result", () => {
		const memoryId = store.remember(
			sessionId,
			"session_summary",
			"Working-set-only candidate",
			"This candidate is too large for the tight rendering budget. ".repeat(10),
			0.8,
			[],
			{ files_modified: ["packages/core/src/file-ref-only.ts"] },
		);
		const filters = { working_set_paths: ["packages/core/src/file-ref-only.ts"] };
		const artifacts = buildMemoryPackWithTrace(store, "zzz_nomatch_zzz", 10, 1, filters);

		expect(artifacts.response.items).toHaveLength(0);
		expect(artifacts.response.metrics).toMatchObject({ fallback_used: false, fallback: null });
		expect(artifacts.trace.retrieval.candidate_count).toBe(1);
		expect(artifacts.trace.retrieval.candidates).toEqual([
			expect.objectContaining({
				id: memoryId,
				rank: 1,
				disposition: "trimmed",
				section: null,
				reasons: expect.arrayContaining(["working-set overlap", "trimmed by token budget"]),
			}),
		]);

		recordPromptPackArtifacts(
			store.db,
			{ attemptId: id(14), startedAt, completedAt, source: "opencode", requestId: "request-14" },
			"zzz_nomatch_zzz",
			filters,
			artifacts,
		);
		const attempt = getRetrievalAttempt(store.db, id(14));
		expect(attempt).toMatchObject({
			retrievalStatus: "succeeded",
			candidateCount: 1,
			selectedCount: 0,
		});
		expect(attempt?.exposures).toEqual([
			expect.objectContaining({
				memoryId,
				rank: 1,
				disposition: "trimmed",
				reasonCodes: expect.arrayContaining(["disposition.trimmed", "match.working_set"]),
			}),
		]);
	});

	it("accounts for every timeline-expanded row before tight-budget trimming", () => {
		const insertTimelineMemory = (
			kind: string,
			title: string,
			createdAt: string,
			metadata: Record<string, unknown> = {},
		): number => {
			const info = store.db
				.prepare(
					`INSERT INTO memory_items(
						session_id, kind, title, body_text, confidence, tags_text, active,
						created_at, updated_at, metadata_json, rev, scope_id
					) VALUES (?, ?, ?, 'Timeline accounting body', 0.8, '', 1, ?, ?, ?, 1, 'local-default')`,
				)
				.run(sessionId, kind, title, createdAt, createdAt, JSON.stringify(metadata));
			return Number(info.lastInsertRowid);
		};
		const beforeOldestId = insertTimelineMemory(
			"discovery",
			"Before oldest",
			"2026-08-03T09:00:00.000Z",
		);
		const beforeNearestId = insertTimelineMemory(
			"decision",
			"Before nearest",
			"2026-08-03T09:01:00.000Z",
		);
		const anchorId = insertTimelineMemory(
			"bugfix",
			"Timeline trace quasarneedle anchor",
			"2026-08-03T09:02:00.000Z",
		);
		const afterNearestId = insertTimelineMemory(
			"change",
			"After nearest",
			"2026-08-03T09:03:00.000Z",
		);
		const afterNewestId = insertTimelineMemory(
			"feature",
			"After newest",
			"2026-08-03T09:04:00.000Z",
			{ files_modified: ["packages/core/src/timeline-trace.ts"] },
		);
		store.db
			.prepare(
				"INSERT INTO memory_file_refs(memory_id, file_path, relation) VALUES (?, ?, 'modified')",
			)
			.run(afterNewestId, "packages/core/src/timeline-trace.ts");
		const filters = { working_set_paths: ["packages/core/src/timeline-trace.ts"] };

		const artifacts = buildMemoryPackWithTrace(
			store,
			"what happened last time around quasarneedle",
			5,
			1,
			filters,
		);
		const expectedCandidateIds = [
			anchorId,
			afterNewestId,
			beforeOldestId,
			beforeNearestId,
			afterNearestId,
		];

		expect(artifacts.response.items).toHaveLength(0);
		expect(artifacts.response.metrics).toMatchObject({ fallback_used: false, fallback: null });
		expect(artifacts.trace.retrieval.candidate_count).toBe(5);
		expect(artifacts.trace.retrieval.candidates.map((candidate) => candidate.id)).toEqual(
			expectedCandidateIds,
		);
		expect(new Set(expectedCandidateIds).size).toBe(5);
		expect(
			artifacts.trace.retrieval.candidates.every(
				(candidate) => candidate.disposition === "trimmed" && candidate.section === null,
			),
		).toBe(true);

		recordPromptPackArtifacts(
			store.db,
			{ attemptId: id(15), startedAt, completedAt, source: "opencode", requestId: "request-15" },
			"what happened last time around quasarneedle",
			filters,
			artifacts,
		);
		const attempt = getRetrievalAttempt(store.db, id(15));
		expect(attempt).toMatchObject({
			retrievalStatus: "succeeded",
			candidateCount: 5,
			selectedCount: 0,
		});
		expect(attempt?.exposures.map((exposure) => exposure.memoryId)).toEqual(expectedCandidateIds);
		expect(
			attempt?.exposures.every(
				(exposure) =>
					exposure.disposition === "trimmed" &&
					exposure.reasonCodes?.includes("disposition.trimmed"),
			),
		).toBe(true);
	});

	it("traces initial recall rows replaced by a topical retry", () => {
		const initialId = store.remember(
			sessionId,
			"decision",
			"Remember",
			"Recall wording only.",
			0.9,
			[],
			{ files_modified: ["packages/core/src/auroraneedle.ts"] },
		);
		const topicalId = store.remember(
			sessionId,
			"feature",
			"Auroraneedle retrieval",
			"Topical retry result. ".repeat(30),
			0.8,
			[],
			{ files_modified: ["packages/core/src/auroraneedle.ts"] },
		);

		const originalRecentByKinds = store.recentByKinds.bind(store);
		(store as unknown as { recentByKinds: typeof store.recentByKinds }).recentByKinds = () => [];
		const artifacts = (() => {
			try {
				return buildMemoryPackWithTrace(store, "remember packages/core/src/auroraneedle.ts", 1);
			} finally {
				(store as unknown as { recentByKinds: typeof store.recentByKinds }).recentByKinds =
					originalRecentByKinds;
			}
		})();
		const candidateIds = artifacts.trace.retrieval.candidates.map((candidate) => candidate.id);

		expect(artifacts.response.item_ids).toContain(topicalId);
		expect(artifacts.response.item_ids).not.toContain(initialId);
		expect(artifacts.trace.retrieval.candidate_count).toBe(2);
		expect(candidateIds).toEqual([initialId, topicalId]);
		const initialCandidate = artifacts.trace.retrieval.candidates[0];
		const topicalCandidate = artifacts.trace.retrieval.candidates[1];
		expect(initialCandidate).toMatchObject({
			id: initialId,
			disposition: "dropped",
			scores: {
				text_overlap: 0,
				tag_overlap: 0,
				query_path_overlap: expect.any(Number),
			},
		});
		expect(initialCandidate?.scores.query_path_overlap).toBeGreaterThan(0);
		expect(initialCandidate?.reasons).toContain("matched file path hints");
		expect(initialCandidate?.reasons).not.toContain("matched query terms");
		expect(initialCandidate?.reasons).not.toContain("matched tag overlap");
		expect(topicalCandidate).toMatchObject({
			id: topicalId,
			scores: {
				text_overlap: expect.any(Number),
				tag_overlap: expect.any(Number),
				query_path_overlap: 0,
			},
		});
		expect(topicalCandidate?.scores.text_overlap).toBeGreaterThan(0);
		expect(topicalCandidate?.scores.tag_overlap).toBe(0);
		expect(topicalCandidate?.reasons).toContain("matched query terms");
		expect(topicalCandidate?.reasons).not.toContain("matched tag overlap");

		recordPromptPackArtifacts(
			store.db,
			{
				attemptId: id(19),
				startedAt,
				completedAt,
				source: "opencode",
				requestId: "request-19",
			},
			"remember packages/core/src/auroraneedle.ts",
			undefined,
			artifacts,
		);
		expect(getRetrievalAttempt(store.db, id(19))).toMatchObject({
			candidateCount: 2,
			selectedCount: 1,
		});
		expect(
			getRetrievalAttempt(store.db, id(19))?.exposures.map((exposure) => exposure.memoryId),
		).toEqual(candidateIds);
	});

	it("traces non-summary hint rows before recall filtering", () => {
		const summaryId = store.remember(
			sessionId,
			"session_summary",
			"Session summary recap",
			"Summary selected from the hint search.",
			0.9,
			["session", "summary", "recap"],
		);
		const filteredId = store.remember(
			sessionId,
			"discovery",
			"Previous work entity index",
			"A non-summary hint match that selection filters out.",
			0.8,
		);

		const originalRecentByKinds = store.recentByKinds.bind(store);
		(store as unknown as { recentByKinds: typeof store.recentByKinds }).recentByKinds = () => [];
		const artifacts = (() => {
			try {
				// "remember" enters recall mode without a timeline phrase ("last time" would
				// trigger timeline expansion and legitimately re-include the filtered row).
				return buildMemoryPackWithTrace(store, "remember zzzhintneedle", 10);
			} finally {
				(store as unknown as { recentByKinds: typeof store.recentByKinds }).recentByKinds =
					originalRecentByKinds;
			}
		})();
		const candidateIds = artifacts.trace.retrieval.candidates.map((candidate) => candidate.id);

		expect(artifacts.response.item_ids).toContain(summaryId);
		expect(artifacts.response.item_ids).not.toContain(filteredId);
		expect(artifacts.trace.retrieval.candidate_count).toBe(2);
		expect(candidateIds).toEqual(expect.arrayContaining([summaryId, filteredId]));
		expect(
			artifacts.trace.retrieval.candidates.find((candidate) => candidate.id === filteredId),
		).toMatchObject({
			disposition: "dropped",
			section: null,
		});
		const hintCandidate = artifacts.trace.retrieval.candidates.find(
			(candidate) => candidate.id === summaryId,
		);
		// Generic recall-hint tokens are excluded from overlap diagnostics, but the
		// originating hint query still enables recap-role scoring for this summary.
		expect(hintCandidate?.scores.text_overlap).toBe(0);
		expect(hintCandidate?.scores.tag_overlap).toBe(0);
		expect(hintCandidate?.scores.role_adjustment).toBeGreaterThan(0);
		expect(hintCandidate?.scores.recap_penalty).toBe(0);

		recordPromptPackArtifacts(
			store.db,
			{
				attemptId: id(20),
				startedAt,
				completedAt,
				source: "opencode",
				requestId: "request-20",
			},
			"last time zzzhintneedle",
			undefined,
			artifacts,
		);
		expect(
			getRetrievalAttempt(store.db, id(20))?.exposures.map((exposure) => exposure.memoryId),
		).toEqual(candidateIds);
	});

	it("deduplicates a recall row returned by both initial and topical searches", () => {
		const overlappingId = store.remember(
			sessionId,
			"session_summary",
			"Remember packages core src overlapneedle ts session summary",
			"The same summary matches both recall searches.",
			0.9,
			[],
			{ files_modified: ["packages/core/src/overlapneedle.ts"] },
		);

		const artifacts = buildMemoryPackWithTrace(
			store,
			"remember packages/core/src/overlapneedle.ts",
			10,
		);
		const candidateIds = artifacts.trace.retrieval.candidates.map((candidate) => candidate.id);

		expect(artifacts.trace.retrieval.candidate_count).toBe(1);
		expect(candidateIds).toEqual([overlappingId]);
		expect(new Set(candidateIds).size).toBe(candidateIds.length);
		expect(artifacts.trace.retrieval.candidates[0]?.scores.query_path_overlap).toBeGreaterThan(0);
		expect(artifacts.trace.retrieval.candidates[0]?.reasons).toContain("matched file path hints");
	});

	it("persists trimmed supplemental observation candidates without fallback inflation or duplicates", () => {
		const now = new Date().toISOString();
		const summaryInfo = store.db
			.prepare(
				`INSERT INTO memory_items(
					session_id, kind, title, body_text, confidence, tags_text, active,
					created_at, updated_at, metadata_json, rev, scope_id
				) VALUES (?, 'session_summary', ?, ?, 0.9, '', 1, ?, ?, '{}', 1, 'local-default')`,
			)
			.run(sessionId, "Supplemental needle recap", "Supplemental needle only", now, now);
		const summaryId = Number(summaryInfo.lastInsertRowid);
		const firstObservationId = store.remember(
			sessionId,
			"decision",
			"Unrelated recent decision",
			"Recent supplemental evidence",
			0.8,
		);
		const secondObservationId = store.remember(
			sessionId,
			"bugfix",
			"Unrelated recent fix",
			"More supplemental evidence",
			0.8,
		);
		const originalRecentByKinds = store.recentByKinds.bind(store);
		(store as unknown as { recentByKinds: typeof store.recentByKinds }).recentByKinds = (
			...args
		) => {
			const rows = originalRecentByKinds(...args);
			return rows[0] ? [rows[0], ...rows] : rows;
		};

		const artifacts = (() => {
			try {
				return buildMemoryPackWithTrace(store, "Supplemental needle recap", 10, 1);
			} finally {
				(store as unknown as { recentByKinds: typeof store.recentByKinds }).recentByKinds =
					originalRecentByKinds;
			}
		})();

		expect(artifacts.response.metrics.fallback_used).toBe(false);
		expect(artifacts.trace.retrieval.candidate_count).toBe(3);
		const candidateIds = artifacts.trace.retrieval.candidates.map((candidate) => candidate.id);
		expect(candidateIds[0]).toBe(summaryId);
		expect(candidateIds.slice(1)).toEqual(
			expect.arrayContaining([firstObservationId, secondObservationId]),
		);
		expect(new Set(candidateIds).size).toBe(3);
		expect(
			artifacts.trace.retrieval.candidates
				.filter((candidate) => candidate.id !== summaryId)
				.every((candidate) => candidate.disposition === "trimmed"),
		).toBe(true);

		recordPromptPackArtifacts(
			store.db,
			{ attemptId: id(13), startedAt, completedAt, source: "opencode", requestId: "request-13" },
			"Supplemental needle recap",
			undefined,
			artifacts,
		);
		const attempt = getRetrievalAttempt(store.db, id(13));
		expect(attempt).toMatchObject({ candidateCount: 3, selectedCount: 0 });
		expect(attempt?.exposures.map((exposure) => exposure.memoryId)).toEqual(candidateIds);
		expect(attempt?.exposures.every((exposure) => exposure.disposition === "trimmed")).toBe(true);
	});

	it("fingerprints the complete persisted artifact while keeping exact retries stable", () => {
		store.remember(sessionId, "feature", "Stable rendered pack", "stable body", 0.8);
		const artifacts = buildMemoryPackWithTrace(store, "stable rendered pack", 10);
		const exact = promptPackArtifactFingerprint(
			store.db,
			"stable rendered pack",
			{ working_set_paths: ["packages/core/src/pack.ts"] },
			artifacts,
		);
		const repeated = promptPackArtifactFingerprint(
			store.db,
			"stable rendered pack",
			{ working_set_paths: ["packages/core/src/pack.ts"] },
			artifacts,
		);
		const changedScores = structuredClone(artifacts);
		const candidate = changedScores.trace.retrieval.candidates[0];
		if (!candidate) throw new Error("expected a trace candidate");
		candidate.scores.working_set_overlap += 0.25;

		expect(repeated).toBe(exact);
		expect(changedScores.response.pack_text).toBe(artifacts.response.pack_text);
		expect(
			promptPackArtifactFingerprint(
				store.db,
				"stable rendered pack",
				{ working_set_paths: ["packages/core/src/pack.ts"] },
				changedScores,
			),
		).not.toBe(exact);
		expect(
			promptPackArtifactFingerprint(
				store.db,
				"stable rendered pack",
				{ working_set_paths: ["packages/core/src/store.ts"] },
				artifacts,
			),
		).not.toBe(exact);
	});

	it("bounds persisted exposures to 50 selected and 20 diagnostics", () => {
		store.remember(sessionId, "feature", "Bounded candidate", "bounded candidate body", 0.8);
		const artifacts = buildMemoryPackWithTrace(store, "bounded candidate", 10);
		const candidate = artifacts.trace.retrieval.candidates[0];
		if (!candidate) throw new Error("expected a trace candidate");
		artifacts.trace.retrieval.candidates = [
			...Array.from({ length: 55 }, (_, index) => ({
				...candidate,
				rank: index + 1,
				disposition: "selected" as const,
				section: "summary" as const,
			})),
			...Array.from({ length: 25 }, (_, index) => ({
				...candidate,
				rank: index + 56,
				disposition: "dropped" as const,
				section: null,
			})),
		];
		artifacts.trace.retrieval.candidate_count = 80;

		recordPromptPackArtifacts(
			store.db,
			{ attemptId: id(9), startedAt, completedAt, source: "opencode", requestId: "request-9" },
			"bounded candidate",
			undefined,
			artifacts,
		);

		const rows = getRetrievalAttempt(store.db, id(9))?.exposures ?? [];
		expect(getRetrievalAttempt(store.db, id(9))?.selectedCount).toBe(55);
		expect(rows.filter((row) => row.disposition === "selected")).toHaveLength(50);
		expect(rows.filter((row) => row.disposition !== "selected")).toHaveLength(20);
	});

	it("records skipped, failed, cached reuse, and delivery as distinct lifecycle states", () => {
		for (const [sequence, status, code] of [
			[4, "skipped", "injection_disabled"],
			[5, "skipped", "compaction_skipped"],
			[6, "failed", "pack_command_failed"],
		] as const) {
			recordPromptPackTerminal(
				store.db,
				{
					attemptId: id(sequence),
					startedAt,
					completedAt,
					source: "opencode",
					requestId: `request-${sequence}`,
				},
				status,
				code,
				status === "failed" ? "transport" : "policy",
			);
		}

		store.remember(sessionId, "feature", "Cached candidate", "cache bytes", 0.8);
		const artifacts = buildMemoryPackWithTrace(store, "cached candidate", 10);
		recordPromptPackArtifacts(
			store.db,
			{ attemptId: id(7), startedAt, completedAt, source: "opencode", requestId: "request-7" },
			"cached candidate",
			undefined,
			artifacts,
		);
		updateRetrievalDelivery(store.db, id(7), "handed_off");
		const cloned = clonePromptPackAttempt(store.db, id(7), {
			attemptId: id(8),
			startedAt,
			completedAt,
			source: "opencode",
			requestId: "request-8",
		});

		expect(cloned.ok).toBe(true);
		expect(getRetrievalAttempt(store.db, id(4))).toMatchObject({
			retrievalStatus: "skipped",
			failureCode: "injection_disabled",
		});
		expect(getRetrievalAttempt(store.db, id(5))?.failureCode).toBe("compaction_skipped");
		expect(getRetrievalAttempt(store.db, id(6))?.retrievalStatus).toBe("failed");
		expect(getRetrievalAttempt(store.db, id(7))?.deliveryStatus).toBe("handed_off");
		expect(getRetrievalAttempt(store.db, id(8))).toMatchObject({
			deliveryStatus: "not_attempted",
			queryHashSha256: getRetrievalAttempt(store.db, id(7))?.queryHashSha256,
			requestId: `cache_reuse:request-8:from:${id(7)}`,
		});
		expect(getRetrievalAttempt(store.db, id(8))?.exposures.map((row) => row.handoffStatus)).toEqual(
			getRetrievalAttempt(store.db, id(8))?.exposures.map(() => "not_attempted"),
		);
	});
});
