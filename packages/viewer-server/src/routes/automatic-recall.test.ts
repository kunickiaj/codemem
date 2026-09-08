import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@codemem/core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../../scripts/eval/fixtures/automatic-recall-pre-policy.json";
import { insertTestSession } from "../../../core/src/test-utils.js";
import { packTransportRoutes } from "./pack.js";
import { statsRoutes } from "./stats.js";

const attemptId = "018f2db4-f9d3-7a22-8d18-000000000001";
const empty = {
	v: 1,
	candidateItems: 0,
	duplicatesOmitted: 0,
	beforeTokens: 0,
	afterTokens: 0,
	missingRetainedMetadata: false,
	invalidRetainedMetadata: false,
	packMetadata: "valid",
};

function seedRecallFixture(store: MemoryStore) {
	for (const session of fixture.sessions) {
		const sessionId = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: session.host_session_id,
			project: fixture.project,
			startedAt: session.started_at,
		});
		for (const memory of session.memories) {
			const id = store.remember(
				sessionId,
				memory.kind,
				memory.title,
				memory.body,
				memory.confidence,
				memory.tags,
				memory.metadata,
			);
			store.db
				.prepare("UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?")
				.run(memory.created_at, memory.created_at, id);
		}
	}
}

describe("automatic recall existing HTTP transport", () => {
	let directory: string;
	let store: MemoryStore;
	let app: Hono;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "recall-api-"));
		store = new MemoryStore(join(directory, "test.sqlite"));
		app = new Hono()
			.route(
				"/",
				packTransportRoutes(() => store),
			)
			.route(
				"/",
				statsRoutes(() => store),
			);
	});
	afterEach(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});
	const post = (path: string, body: unknown) =>
		app.request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	async function pack(id = attemptId) {
		const response = await post("/api/pack", {
			context: "recall candidate",
			all_projects: true,
			token_budget: 795,
			attempt: { attempt_id: id, source: "opencode", request_id: `api-request-${id}` },
		});
		expect(response.status).toBe(200);
		return response.json() as Promise<{ pack_text: string; metrics: { total_items: number } }>;
	}
	it("persists delivery measurements once and serves a bounded count-only Health summary", async () => {
		store.remember(
			insertTestSession(store.db),
			"decision",
			"recall candidate",
			"private fixture body",
			0.9,
		);
		const response = await pack();
		const measurement = {
			...empty,
			candidateItems: response.metrics.total_items,
			duplicatesOmitted: response.metrics.total_items,
			beforeTokens: Math.ceil(`[codemem context]\n${response.pack_text}`.length / 4),
		};
		const payload = {
			action: "delivery",
			attempt_id: attemptId,
			delivery_status: "unknown",
			automatic_recall: measurement,
			evaluation_key: "a".repeat(64),
		};
		expect((await post("/api/prompt-pack-ledger", payload)).status).toBe(200);
		expect((await post("/api/prompt-pack-ledger", payload)).status).toBe(200);
		const stats = await (await app.request("/api/stats")).json();
		expect(stats.automatic_recall).toMatchObject({
			availability: "available",
			freshEvaluations: 1,
			evaluationsWithDuplicates: 1,
			estimatedTokensAvoided: measurement.beforeTokens,
			captureVersion: "opencode-retained-v1",
		});
		expect(JSON.stringify(stats.automatic_recall)).not.toMatch(
			/private|api-request|attempt_id|memory_id/,
		);
	});
	it("records an empty evaluation without delivery and rejects spoofed counts or target mismatch", async () => {
		await pack();
		const payload = {
			action: "recall",
			attempt_id: attemptId,
			automatic_recall: empty,
			evaluation_key: "b".repeat(64),
		};
		expect(
			(
				await post("/api/prompt-pack-ledger", {
					...payload,
					db_path: join(directory, "other.sqlite"),
				})
			).status,
		).toBe(409);
		for (const automatic_recall of [
			{ ...empty, candidateItems: 10 },
			{ ...empty, beforeTokens: 999, afterTokens: 999 },
			{ ...empty, memory_ids: [1] },
		]) {
			expect((await post("/api/prompt-pack-ledger", { ...payload, automatic_recall })).status).toBe(
				400,
			);
		}
		expect((await post("/api/prompt-pack-ledger", payload)).status).toBe(200);
		const stats = await (await app.request("/api/stats")).json();
		expect(stats.automatic_recall).toMatchObject({
			freshEvaluations: 1,
			estimatedTokensAvoided: 0,
		});
		expect(
			store.db
				.prepare("SELECT delivery_status FROM retrieval_attempts WHERE attempt_id = ?")
				.get(attemptId),
		).toEqual({ delivery_status: "not_attempted" });
	});
	it.each(["missing", "invalid", "no_results", "downgrade"])(
		"does not persist measurements for rejected %s delivery",
		async (scenario) => {
			if (scenario !== "no_results") {
				store.remember(
					insertTestSession(store.db),
					"decision",
					"recall candidate",
					"bounded fixture body",
					0.9,
				);
			}
			const response = await pack();
			const payload = {
				action: "delivery",
				attempt_id: attemptId,
				delivery_status: "handed_off",
			};
			if (scenario === "downgrade") {
				expect((await post("/api/prompt-pack-ledger", payload)).status).toBe(200);
			}
			const before = store.db.prepare("SELECT * FROM retrieval_attempts").all();
			let deliveryStatus: string | undefined = "failed";
			if (scenario === "missing") deliveryStatus = undefined;
			if (scenario === "invalid") deliveryStatus = "invalid";
			const rejected = await post("/api/prompt-pack-ledger", {
				...payload,
				delivery_status: deliveryStatus,
				evaluation_key: "d".repeat(64),
				automatic_recall: {
					...empty,
					candidateItems: response.metrics.total_items,
					duplicatesOmitted: response.metrics.total_items,
					beforeTokens:
						scenario === "no_results"
							? 0
							: Math.ceil(`[codemem context]\n${response.pack_text}`.length / 4),
				},
			});
			expect(rejected.status).toBe(400);
			expect(store.db.prepare("SELECT * FROM retrieval_attempts").all()).toEqual(before);
			const stats = await (await app.request("/api/stats")).json();
			expect(stats.automatic_recall).toMatchObject({
				freshEvaluations: 0,
				estimatedTokensAvoided: 0,
			});
		},
	);
	it("keeps delivery validation authoritative when diagnostics fail", async () => {
		store.remember(
			insertTestSession(store.db),
			"decision",
			"recall candidate",
			"bounded fixture body",
			0.9,
		);
		await pack();
		const invalidDiagnostic = {
			action: "delivery",
			attempt_id: attemptId,
			delivery_status: "handed_off",
			automatic_recall: { ...empty, private_field: "rejected" },
			evaluation_key: "c".repeat(64),
		};
		expect((await post("/api/prompt-pack-ledger", invalidDiagnostic)).status).toBe(200);
		expect(
			store.db
				.prepare("SELECT delivery_status FROM retrieval_attempts WHERE attempt_id = ?")
				.get(attemptId),
		).toEqual({ delivery_status: "handed_off" });
		expect(
			(await post("/api/prompt-pack-ledger", { ...invalidDiagnostic, delivery_status: "invalid" }))
				.status,
		).toBe(400);
		expect(
			(
				await post("/api/prompt-pack-ledger", {
					...invalidDiagnostic,
					db_path: join(directory, "other.sqlite"),
				})
			).status,
		).toBe(409);

		const secondAttempt = "018f2db4-f9d3-7a22-8d18-000000000002";
		await pack(secondAttempt);
		store.db.exec("ALTER TABLE retrieval_attempts DROP COLUMN automatic_recall_json");
		expect(
			(
				await post("/api/prompt-pack-ledger", {
					...invalidDiagnostic,
					attempt_id: secondAttempt,
					automatic_recall: empty,
				})
			).status,
		).toBe(200);
		expect(
			store.db
				.prepare("SELECT delivery_status FROM retrieval_attempts WHERE attempt_id = ?")
				.get(secondAttempt),
		).toEqual({ delivery_status: "handed_off" });
	});
});

it(
	"returns the actual pre-policy generic Continue incident through the Viewer route",
	verifyViewerBaseline,
);

async function verifyViewerBaseline() {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(fixture.clock));
	const store = new MemoryStore(":memory:");
	try {
		// Arrange
		seedRecallFixture(store);
		const app = new Hono().route(
			"/",
			packTransportRoutes(() => store),
		);

		// Act
		const response = await app.request("/api/pack", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				context: fixture.query,
				project: fixture.project,
				limit: fixture.limit,
				token_budget: fixture.core_token_budget,
			}),
		});
		const body = (await response.json()) as {
			pack_text: string;
			metrics: { mode: string };
		};

		// Assert
		expect(response.status).toBe(200);
		expect(body.metrics.mode).toBe("task");
		expect(body.pack_text).toContain("QUARTZ_DURABLE_FACT");
		expect(body.pack_text).toContain("ORCHID_UNRELATED_CONTINUITY");
	} finally {
		store.close();
		vi.useRealTimers();
	}
}
