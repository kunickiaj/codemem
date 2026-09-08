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

let directory: string;
let store: MemoryStore;
let app: Hono;
function useTransportFixture() {
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
}
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
describe("automatic recall existing HTTP transport", () => {
	useTransportFixture();
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
});
describe("automatic request continuity", () => {
	useTransportFixture();
	it("carries automatic requester context into pack assembly without changing generic requests", async () => {
		const currentSessionId = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: "host-current",
			project: "continuity-project",
		});
		const foreignSessionId = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: "host-foreign",
			project: "continuity-project",
		});
		store.remember(
			currentSessionId,
			"session_summary",
			"Current transport summary",
			"current transport continuity",
			0.9,
		);
		store.remember(
			foreignSessionId,
			"session_summary",
			"Foreign transport summary",
			"foreign transport continuity",
			0.99,
		);
		store.remember(
			foreignSessionId,
			"decision",
			"Parallel transport fact",
			"durable transport continuity",
			0.8,
		);

		const automaticResponse = await post("/api/pack", {
			context: "transport continuity",
			project: "continuity-project",
			automatic_context: { source: "opencode", host_session_id: "host-current" },
		});
		const genericResponse = await post("/api/pack", {
			context: "transport continuity",
			project: "continuity-project",
		});
		const legacyPluginResponse = await post("/api/pack", {
			context: "transport continuity",
			project: "continuity-project",
			attempt: {
				attempt_id: "018f2db4-f9d3-7a22-8d18-000000000002",
				source: "opencode",
				source_session_id: "host-current",
			},
		});
		const automatic = (await automaticResponse.json()) as { pack_text: string };
		const generic = (await genericResponse.json()) as { pack_text: string };
		const legacyPlugin = (await legacyPluginResponse.json()) as { pack_text: string };

		expect(automaticResponse.status).toBe(200);
		expect(automatic.pack_text).toContain("Current transport summary");
		expect(automatic.pack_text).not.toContain("Foreign transport summary");
		expect(automatic.pack_text).toContain("Parallel transport fact");
		expect(generic.pack_text).toContain("Foreign transport summary");
		expect(legacyPluginResponse.status).toBe(200);
		expect(legacyPlugin.pack_text).toContain("Current transport summary");
		expect(legacyPlugin.pack_text).not.toContain("Foreign transport summary");
	});

	it("treats null or identity-less automatic metadata as unmapped", async () => {
		const unknownSessionId = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: "unknown",
			project: "continuity-project",
		});
		store.remember(
			unknownSessionId,
			"session_summary",
			"Anonymous transport summary",
			"anonymous transport continuity",
			0.9,
		);

		const explicitNull = await post("/api/pack", {
			context: "anonymous transport continuity",
			project: "continuity-project",
			automatic_context: null,
		});
		const legacyMissingIdentity = await post("/api/pack", {
			context: "anonymous transport continuity",
			project: "continuity-project",
			attempt: { attempt_id: "018f2db4-f9d3-7a22-8d18-000000000003" },
		});
		const explicitBody = (await explicitNull.json()) as { pack_text: string };
		const legacyBody = (await legacyMissingIdentity.json()) as { pack_text: string };

		expect(explicitNull.status).toBe(200);
		expect(legacyMissingIdentity.status).toBe(200);
		expect(explicitBody.pack_text).not.toContain("Anonymous transport summary");
		expect(legacyBody.pack_text).not.toContain("Anonymous transport summary");
	});
});
describe("automatic recall transport validation", () => {
	useTransportFixture();
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
});
describe("automatic recall delivery validation", () => {
	useTransportFixture();
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

it("returns the actual pre-policy generic Continue incident through the Viewer route", () =>
	verifyViewerIncident({ automatic: false }));

it("matches frozen Continue gold with current automatic policy in Viewer", () =>
	verifyViewerIncident({ automatic: true }));

async function verifyViewerIncident({ automatic }: { automatic: boolean }) {
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
				...(automatic
					? {
							automatic_context: {
								source: "opencode",
								host_session_id: fixture.requester_host_session_id,
							},
						}
					: {}),
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
		if (automatic) {
			for (const key of fixture.gold.generic_continue.required_keys) {
				const memory = fixture.sessions
					.flatMap((session) => session.memories)
					.find((item) => item.key === key);
				expect(body.pack_text).toContain(memory?.body);
			}
			expect(body.pack_text).not.toContain("ORCHID_UNRELATED_CONTINUITY");
		} else {
			expect(body.pack_text).toContain("ORCHID_UNRELATED_CONTINUITY");
		}
	} finally {
		store.close();
		vi.useRealTimers();
	}
}
