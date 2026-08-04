import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	explicitFeedbackEvidence,
	getSchemaVersion,
	MemoryStore,
	recordAttributionAssessment,
	recordOutcomeEvidence,
	recordRetrievalAttempt,
	SCHEMA_VERSION,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statsCommand } from "./stats.js";

function id(sequence: number): string {
	return `018f2db4-f9d3-7a22-8d18-${sequence.toString(16).padStart(12, "0")}`;
}

describe("stats command", () => {
	let tmpDir: string;
	let prevCodememConfig: string | undefined;

	beforeEach(() => {
		prevCodememConfig = process.env.CODEMEM_CONFIG;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-stats-command-"));
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
	});

	afterEach(() => {
		if (prevCodememConfig === undefined) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevCodememConfig;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("auto-initializes a fresh database before reporting stats", async () => {
		const dbPath = join(tmpDir, "fresh.sqlite");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await statsCommand.parseAsync(["--db-path", dbPath, "--json"], { from: "user" });

			const output = logSpy.mock.calls.at(-1)?.[0];
			expect(typeof output).toBe("string");
			const result = JSON.parse(String(output));
			expect(result.database.path).toBe(dbPath);
			expect(result.database.memory_items).toBe(0);

			const db = connect(dbPath);
			try {
				expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
			} finally {
				db.close();
			}
		} finally {
			logSpy.mockRestore();
		}
	});

	it("reports memory counts through the local scope visibility gate", async () => {
		const dbPath = join(tmpDir, "scoped.sqlite");
		const store = new MemoryStore(dbPath);
		try {
			const now = "2026-01-01T00:00:00Z";
			for (const scopeId of ["authorized-team", "unauthorized-team"]) {
				store.db
					.prepare(
						`INSERT INTO replication_scopes(
							scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
						 ) VALUES (?, ?, 'team', 'coordinator', 1, 'active', ?, ?)`,
					)
					.run(scopeId, scopeId, now, now);
			}
			store.db
				.prepare(
					`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
					 VALUES ('authorized-team', ?, 'member', 'active', 1, ?)`,
				)
				.run(store.deviceId, now);

			const sessionId = store.startSession({ cwd: process.cwd(), project: "scope-test" });
			store.db
				.prepare(
					`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, scope_id)
					 VALUES (?, 'discovery', 'Visible stats', 'Visible body', ?, ?, ?)`,
				)
				.run(sessionId, now, now, "authorized-team");
			store.db
				.prepare(
					`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, scope_id)
					 VALUES (?, 'discovery', 'Hidden stats', 'Hidden body', ?, ?, ?)`,
				)
				.run(sessionId, now, now, "unauthorized-team");
		} finally {
			store.close();
		}

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await statsCommand.parseAsync(["--db-path", dbPath, "--json"], { from: "user" });

			const output = logSpy.mock.calls.at(-1)?.[0];
			expect(typeof output).toBe("string");
			const result = JSON.parse(String(output));
			expect(result.database.memory_items).toBe(1);
			expect(result.database.active_memory_items).toBe(1);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("emits bounded machine-readable and concise attribution diagnostics without sensitive content", async () => {
		const dbPath = join(tmpDir, "attribution.sqlite");
		const store = new MemoryStore(dbPath);
		try {
			const sessionId = store.startSession({ cwd: process.cwd(), project: "diagnostics" });
			const evidenceId = "018f2db4-f9d3-7a22-8d18-000000000302";
			const attemptId = "018f2db4-f9d3-7a22-8d18-000000000301";
			recordRetrievalAttempt(store.db, {
				attemptId,
				surface: "mcp_search",
				trigger: "explicit",
				startedAt: "2026-08-03T12:00:00Z",
				completedAt: "2026-08-03T12:00:00.012Z",
				retrievalStatus: "succeeded",
				deliveryStatus: "handed_off",
				candidateCount: 1,
				selectedCount: 1,
				recorderVersion: "stats-test-v1",
				sessionId,
				latencyMs: 12,
				exposures: [
					{
						memoryImportKey: "safe-memory-id",
						rank: 1,
						disposition: "selected",
						handoffStatus: "handed_off",
					},
				],
			});
			recordOutcomeEvidence(
				store.db,
				explicitFeedbackEvidence({
					evidenceId,
					observedAt: "2026-08-03T12:01:00Z",
					producer: "feedback-action",
					producerVersion: "v1",
					feedback: "helpful",
					actionId: "feedback-1",
					gate: "structured_action",
					referenceCodes: [`attempt:${attemptId}`],
					correlation: { sessionId },
				}),
			);
			recordAttributionAssessment(store.db, {
				assessmentId: "018f2db4-f9d3-7a22-8d18-000000000303",
				attemptId,
				dimension: "feedback",
				impactLabel: "helpful",
				basis: "explicit_reference",
				confidenceLevel: "medium",
				method: "stats-test",
				methodVersion: "v1",
				createdAt: "2026-08-03T12:02:00Z",
				evidenceIds: [evidenceId],
			});

			const cappedAttemptId = id(350);
			const cappedEvidenceId = id(351);
			recordRetrievalAttempt(store.db, {
				attemptId: cappedAttemptId,
				surface: "mcp_search",
				trigger: "explicit",
				startedAt: "2026-08-03T12:00:00Z",
				completedAt: "2026-08-03T12:00:00.012Z",
				retrievalStatus: "succeeded",
				deliveryStatus: "handed_off",
				candidateCount: 1,
				selectedCount: 1,
				recorderVersion: "stats-test-v1",
				sessionId,
				latencyMs: 8,
				exposures: [
					{
						memoryImportKey: "capped-memory-id",
						rank: 1,
						disposition: "selected",
						handoffStatus: "handed_off",
					},
				],
			});
			recordOutcomeEvidence(
				store.db,
				explicitFeedbackEvidence({
					evidenceId: cappedEvidenceId,
					observedAt: "2026-08-03T12:01:00Z",
					producer: "feedback-action",
					producerVersion: "v1",
					feedback: "helpful",
					actionId: "feedback-capped",
					gate: "structured_action",
					referenceCodes: [`attempt:${cappedAttemptId}`],
					correlation: { sessionId },
				}),
			);
			recordAttributionAssessment(store.db, {
				assessmentId: id(352),
				attemptId: cappedAttemptId,
				dimension: "feedback",
				impactLabel: "helpful",
				basis: "explicit_reference",
				confidenceLevel: "medium",
				method: "stats-test",
				methodVersion: "v1",
				createdAt: "2026-08-03T12:02:00Z",
				evidenceIds: [cappedEvidenceId],
			});
			for (let sequence = 400; sequence < 500; sequence += 1) {
				recordAttributionAssessment(store.db, {
					assessmentId: id(sequence),
					attemptId,
					dimension: "feedback",
					impactLabel: "helpful",
					basis: "explicit_reference",
					confidenceLevel: "medium",
					method: "stats-test",
					methodVersion: "v1",
					createdAt: "2026-08-03T12:03:00Z",
					evidenceIds: [evidenceId],
				});
			}
		} finally {
			store.close();
		}

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await statsCommand.parseAsync(["--db-path", dbPath, "--attribution", "--json"], {
				from: "user",
			});
			const json = String(logSpy.mock.calls.at(-1)?.[0]);
			const report = JSON.parse(json);
			expect(report.lifecycle).toMatchObject({
				requestedAttempts: 2,
				selectedAttempts: 2,
				handedOffAttempts: 2,
			});
			expect(report.evidenceCompleteness).toMatchObject({
				assessedAttempts: 1,
				unassessedAttempts: 0,
				assessmentStatusIndeterminateAttempts: 1,
				assessmentDetailsIncompleteAttempts: 1,
				assessmentRowsOmittedByLimit: 2,
			});
			expect(json).not.toContain(process.cwd());
			expect(json).not.toMatch(/prompt|query|body_text|pack_text|caused|productivity_score/i);

			await statsCommand.parseAsync(["--db-path", dbPath, "--attribution"], { from: "user" });
			const text = String(logSpy.mock.calls.at(-1)?.[0]);
			expect(text).toContain("2 requested, 2 selected, 2 handed off");
			expect(text).toContain("0 known, 0 unknown");
			expect(text).toContain("1 status indeterminate, 1 details incomplete");
			expect(text).toContain("Limitations:");
			expect(text.length).toBeLessThan(1200);
		} finally {
			logSpy.mockRestore();
		}
	});
});
