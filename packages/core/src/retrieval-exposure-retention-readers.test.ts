import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAttributionDiagnostics } from "./attribution-diagnostics.js";
import { automaticRecallHealth, recordAutomaticRecall } from "./automatic-recall.js";
import { clonePromptPackAttempt } from "./prompt-pack-ledger.js";
import {
	getRetrievalAttempt,
	queryRetrievalAttempts,
	recordRetrievalAttempt,
	updateRetrievalDelivery,
} from "./retrieval-ledger.js";
import { runLedgerRetentionPass } from "./retrieval-ledger-retention.js";
import { MemoryStore } from "./store.js";

const DAY = 86_400_000;
const NOW = new Date();
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const id = (n: number) => `018f2db4-f9d3-7a22-8d18-${n.toString(16).padStart(12, "0")}`;
const measurement = {
	v: 1,
	candidateItems: 1,
	duplicatesOmitted: 0,
	beforeTokens: 20,
	afterTokens: 20,
	missingRetainedMetadata: false,
	invalidRetainedMetadata: false,
	packMetadata: "valid",
};

let store: MemoryStore;

function memory(title: string): { memoryId: number; memoryImportKey: string } {
	const session = store.startSession({ cwd: "/fixture", project: "fixture", user: "fixture" });
	const memoryId = store.remember(session, "discovery", title, "Body");
	const row = store.db
		.prepare("SELECT import_key FROM memory_items WHERE id = ?")
		.get(memoryId) as {
		import_key: string;
	};
	return { memoryId, memoryImportKey: row.import_key };
}

/** A handed-off automatic prompt pack that selected one memory and dropped two others. */
function recordPack(n: number, startedAt: string): string {
	const [selected, trimmed, dropped] = ["selected", "trimmed", "dropped"].map((title) =>
		memory(`${title} ${n}`),
	);
	const attemptId = id(n);
	recordRetrievalAttempt(store.db, {
		attemptId,
		startedAt,
		completedAt: startedAt,
		source: "opencode",
		requestId: `request-${n}`,
		surface: "prompt_pack",
		trigger: "automatic",
		recorderVersion: "test",
		retrievalStatus: "succeeded",
		deliveryStatus: "not_attempted",
		candidateCount: 3,
		selectedCount: 1,
		outputTokens: 20,
		exposures: [
			{ rank: 1, disposition: "selected", handoffStatus: "not_attempted", ...selected },
			{ rank: 2, disposition: "trimmed", handoffStatus: "not_attempted", ...trimmed },
			{ rank: 3, disposition: "dropped", handoffStatus: "not_attempted", ...dropped },
		],
	});
	updateRetrievalDelivery(store.db, attemptId, "handed_off");
	const recall = recordAutomaticRecall(store.db, attemptId, String(n).repeat(64), measurement);
	if (!recall.ok) throw new Error(`fixture measurement: ${JSON.stringify(recall)}`);
	return attemptId;
}

function readers(attemptId: string) {
	const { generatedAt: _generated, ...diagnostics } = getAttributionDiagnostics(store.db) as {
		generatedAt?: unknown;
	} & Record<string, unknown>;
	return {
		diagnostics,
		recall: automaticRecallHealth(
			store.db,
			{ actorId: store.actorId, deviceId: store.deviceId },
			NOW,
		),
		attempts: queryRetrievalAttempts(store.db, {}).map((attempt) => ({
			attemptId: attempt.attemptId,
			candidateCount: attempt.candidateCount,
			selectedCount: attempt.selectedCount,
			persistedCandidateCount: attempt.persistedCandidateCount,
			selected: attempt.exposures.filter((exposure) => exposure.disposition === "selected"),
		})),
		attempt: getRetrievalAttempt(store.db, attemptId)?.exposures.filter(
			(exposure) => exposure.disposition === "selected",
		),
	};
}

beforeEach(() => {
	store = new MemoryStore(":memory:");
});

afterEach(() => store.close());

describe("readers of an attempt whose non-selected candidates were removed", () => {
	it("read it without error and report the same selected rows and counts", async () => {
		// Arrange: one pack past the 14-day window and one inside it.
		const old = recordPack(1, daysAgo(20));
		recordPack(2, daysAgo(3));
		const before = readers(old);

		// Act
		const pass = await runLedgerRetentionPass(store.db);

		// Assert: two rows of the old pack went; nothing any reader shows changed.
		expect(pass.nonSelectedExposuresPurged).toBe(2);
		expect(readers(old)).toEqual(before);
		const trimmed = getRetrievalAttempt(store.db, old);
		expect(trimmed).toMatchObject({
			candidateCount: 3,
			selectedCount: 1,
			persistedCandidateCount: 3,
			nonSelectedExposuresRemoved: true,
		});
		expect(trimmed?.exposures.map((exposure) => exposure.disposition)).toEqual(["selected"]);
		expect(getRetrievalAttempt(store.db, id(2))?.nonSelectedExposuresRemoved).toBe(false);
		expect(before.recall.freshEvaluations).toBe(2);
	});

	it("records no cache copy of a trimmed attempt, and still copies a whole one", async () => {
		// Arrange
		const old = recordPack(1, daysAgo(20));
		const recent = recordPack(2, daysAgo(3));
		await runLedgerRetentionPass(store.db);
		const metadata = (n: number) => ({
			attemptId: id(n),
			startedAt: NOW.toISOString(),
			completedAt: NOW.toISOString(),
			source: "opencode",
			requestId: `reuse-${n}`,
			recorderVersion: "test",
		});

		// Act
		const fromTrimmed = clonePromptPackAttempt(store.db, old, metadata(10));
		const fromWhole = clonePromptPackAttempt(store.db, recent, metadata(11));

		// Assert
		expect(fromTrimmed).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "attempt_incomplete",
		});
		expect(getRetrievalAttempt(store.db, id(10))).toBeNull();
		expect(fromWhole.ok).toBe(true);
		expect(getRetrievalAttempt(store.db, id(11))?.exposures).toHaveLength(3);
	});
});
