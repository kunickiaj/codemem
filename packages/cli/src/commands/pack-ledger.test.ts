import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryPackWithTrace, connect, getRetrievalAttempt, MemoryStore } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTestSchema, insertTestSession } from "../../../core/src/test-utils.js";
import {
	handleInstrumentedPackLedger,
	handlePromptPackLedger,
	parseInternalLedgerPayload,
} from "./pack.js";

function id(sequence: number): string {
	return `018f2db4-f9d3-7a22-8d18-${sequence.toString(16).padStart(12, "0")}`;
}

describe("prompt-pack ledger transport", () => {
	let directory: string;
	let store: MemoryStore;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "codemem-cli-pack-ledger-"));
		const path = join(directory, "test.sqlite");
		const db = connect(path);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(path);
	});

	afterEach(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it("handles failure recording, successful delivery retry, and cache reuse", () => {
		const record = parseInternalLedgerPayload(
			JSON.stringify({
				action: "record",
				attempt_id: id(1),
				started_at: "2026-08-03T10:00:00.000Z",
				source: "opencode",
				request_id: "record-request",
				retrieval_status: "skipped",
				failure_code: "injection_disabled",
				failure_stage: "policy",
			}),
		);
		expect(handlePromptPackLedger(store.db, record)).toMatchObject({ inserted: true });

		const sessionId = insertTestSession(store.db);
		store.remember(sessionId, "decision", "Delivery candidate", "bounded body", 0.9);
		const artifacts = buildMemoryPackWithTrace(store, "Delivery candidate", 10);
		const successful = parseInternalLedgerPayload(
			JSON.stringify({
				attempt_id: id(3),
				started_at: "2026-08-03T10:00:00.500Z",
				source: "opencode",
				request_id: "delivery-request",
			}),
		);
		expect(
			handleInstrumentedPackLedger(store.db, successful, "Delivery candidate", {}, artifacts),
		).toMatchObject({ ok: true, value: { inserted: true } });

		const delivery = parseInternalLedgerPayload(
			JSON.stringify({
				action: "delivery",
				attempt_id: id(3),
				delivery_status: "handed_off",
			}),
		);
		expect(handlePromptPackLedger(store.db, delivery)).toMatchObject({ changed: true });
		expect(handlePromptPackLedger(store.db, delivery)).toMatchObject({ changed: false });

		const cacheReuse = parseInternalLedgerPayload(
			JSON.stringify({
				action: "cache_reuse",
				attempt_id: id(2),
				started_at: "2026-08-03T10:00:01.000Z",
				source: "opencode",
				request_id: "cache-request",
				original_attempt_id: id(3),
			}),
		);
		expect(handlePromptPackLedger(store.db, cacheReuse)).toMatchObject({ inserted: true });
		expect(handlePromptPackLedger(store.db, cacheReuse)).toMatchObject({ inserted: false });
		expect(getRetrievalAttempt(store.db, id(2))).toMatchObject({
			attemptId: id(2),
			deliveryStatus: "not_attempted",
			requestId: `cache_reuse:cache-request:from:${id(3)}`,
		});
	});

	it("records an instrumented combined pack through the CLI boundary", () => {
		const sessionId = insertTestSession(store.db);
		store.remember(sessionId, "decision", "CLI boundary candidate", "bounded body", 0.9);
		const artifacts = buildMemoryPackWithTrace(store, "CLI boundary candidate", 10);
		const payload = parseInternalLedgerPayload(
			JSON.stringify({
				attempt_id: id(3),
				started_at: "2026-08-03T10:00:00.000Z",
				source: "opencode",
				request_id: "pack-request",
			}),
		);

		expect(
			handleInstrumentedPackLedger(
				store.db,
				payload,
				"CLI boundary candidate",
				{ working_set_paths: ["packages/core/src/pack.ts"] },
				artifacts,
			),
		).toMatchObject({ ok: true, value: { inserted: true } });
		expect(getRetrievalAttempt(store.db, id(3))).toMatchObject({
			retrievalStatus: "succeeded",
			workingSetFiles: ["packages/core/src/pack.ts"],
			traceVersion: 1,
		});
	});

	it("surfaces a changed-artifact idempotency conflict after caller cache loss", () => {
		const sessionId = insertTestSession(store.db);
		store.remember(sessionId, "feature", "Restart candidate", "first artifact", 0.8);
		const payload = parseInternalLedgerPayload(
			JSON.stringify({
				attempt_id: id(4),
				started_at: "2026-08-03T10:00:00.000Z",
				source: "opencode",
				request_id: "restart-request",
			}),
		);
		const first = buildMemoryPackWithTrace(store, "Restart candidate", 10);
		expect(
			handleInstrumentedPackLedger(store.db, payload, "Restart candidate", {}, first),
		).toMatchObject({
			ok: true,
		});

		store.remember(sessionId, "decision", "Restart candidate changed", "second artifact", 0.9);
		const changed = buildMemoryPackWithTrace(store, "Restart candidate", 10);

		expect(
			handleInstrumentedPackLedger(store.db, payload, "Restart candidate", {}, changed),
		).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "idempotency_conflict",
		});
		expect(getRetrievalAttempt(store.db, id(4))).toMatchObject({
			deliveryStatus: "not_attempted",
			selectedCount: 1,
		});
	});

	it("delegates UUID and timestamp validation without echoing rejected values", () => {
		const malformed = parseInternalLedgerPayload(
			JSON.stringify({
				action: "record",
				attempt_id: "private-invalid-attempt-value",
				started_at: "private-invalid-timestamp-value",
				source: "opencode",
				request_id: "malformed-request",
				retrieval_status: "failed",
				failure_code: "pack_command_failed",
				failure_stage: "transport",
			}),
		);

		expect(() => handlePromptPackLedger(store.db, malformed)).toThrow("invalid_input");
		try {
			handlePromptPackLedger(store.db, malformed);
		} catch (error) {
			expect(String(error)).not.toContain("private-invalid-attempt-value");
			expect(String(error)).not.toContain("private-invalid-timestamp-value");
		}
	});
});
