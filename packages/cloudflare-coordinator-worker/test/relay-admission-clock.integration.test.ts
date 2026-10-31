import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readRelayAdmissionNonceReceipt,
	type RelayAdmissionNonceAssociation,
	type RelayAdmissionNonceReceipt,
} from "../../core/src/relay-admission-clock.js";
import {
	RELAY_CLOCK_TEST_CLEAR_SQL,
	RELAY_CLOCK_TEST_INSERT_SQL,
	RELAY_CLOCK_TEST_ROWS_SQL,
	RELAY_CLOCK_TEST_SCHEMA_SQL,
} from "../../core/src/relay-admission-clock-test-fixtures.js";

const association: RelayAdmissionNonceAssociation = {
	deviceId: "device-A",
	nonce: "a".repeat(32),
	attemptId: "b".repeat(32),
};
const statement = (expected = association, deadline = Number.MAX_SAFE_INTEGER) =>
	env.COORDINATOR_DB.prepare(RELAY_CLOCK_TEST_INSERT_SQL).bind(
		expected.deviceId,
		expected.nonce,
		expected.attemptId,
		deadline,
	);
const rows = () => env.COORDINATOR_DB.prepare(RELAY_CLOCK_TEST_ROWS_SQL).all();

// The configured binding is a disposable local workerd D1 database, not the Node
// D1 shim. Only this test's table is created and its rows cleared here.
beforeEach(async () => {
	await env.COORDINATOR_DB.prepare(RELAY_CLOCK_TEST_SCHEMA_SQL).run();
	await env.COORDINATOR_DB.prepare(RELAY_CLOCK_TEST_CLEAR_SQL).run();
});
afterEach(async () => {
	await env.COORDINATOR_DB.prepare(RELAY_CLOCK_TEST_CLEAR_SQL).run();
});

describe("relay admission clock on local workerd D1", () => {
	it("first returns an inserted receipt with exact UTC milliseconds", async () => {
		// Arrange: host bounds only check this local runtime's clock sanity.
		const before = Date.now();
		// Act
		const row = await statement().first<RelayAdmissionNonceReceipt>();
		const after = Date.now();
		const receipt = readRelayAdmissionNonceReceipt(row, association);
		// Assert
		expect(receipt).not.toBeNull();
		expect(Number.isSafeInteger(receipt?.decidedAtMs)).toBe(true);
		expect(receipt?.decidedAtMs).toBeGreaterThanOrEqual(before);
		expect(receipt?.decidedAtMs).toBeLessThanOrEqual(after);
		expect(receipt?.createdAt).toBe(new Date(receipt?.decidedAtMs ?? -1).toISOString());
		expect((await rows()).results).toEqual([
			{ device_id: association.deviceId, nonce: association.nonce, created_at: receipt?.createdAt },
		]);
	});

	it("all exposes only inserted rows and rejects the whole D1 result as a receipt", async () => {
		// Arrange
		const retry = { ...association, attemptId: "c".repeat(32) };
		// Act
		const inserted = await statement().all<RelayAdmissionNonceReceipt>();
		const replay = await statement(retry).all<RelayAdmissionNonceReceipt>();
		// Assert
		expect(inserted.success).toBe(true);
		expect(inserted.results).toHaveLength(1);
		expect(readRelayAdmissionNonceReceipt(inserted.results[0], association)).not.toBeNull();
		expect(readRelayAdmissionNonceReceipt(inserted, association)).toBeNull();
		expect(inserted.meta.changes).toBe(1);
		expect(replay.results).toEqual([]);
		expect(replay.meta.changes).toBe(0);
		expect(readRelayAdmissionNonceReceipt(replay.results[0], retry)).toBeNull();
	});

	it("first returns null on replay and the old row cannot authorize a new attempt", async () => {
		// Arrange
		const original = await statement().first();
		const retry = { ...association, attemptId: "d".repeat(32) };
		// Act
		const replay = await statement(retry).first();
		// Assert
		expect(readRelayAdmissionNonceReceipt(original, association)).not.toBeNull();
		expect(replay).toBeNull();
		expect(readRelayAdmissionNonceReceipt(replay, retry)).toBeNull();
		expect(readRelayAdmissionNonceReceipt(original, retry)).toBeNull();
		expect((await rows()).results).toHaveLength(1);
	});

	it("an expired SQL predicate returns no row and writes no nonce", async () => {
		// Arrange
		const expired = statement(association, 0);
		// Act
		const row = await expired.first();
		// Assert
		expect(row).toBeNull();
		expect(readRelayAdmissionNonceReceipt(row, association)).toBeNull();
		expect((await rows()).results).toEqual([]);
	});

	it("concurrent inserts for one nonce have exactly one associated winner", async () => {
		// Arrange
		const attempts = [association, { ...association, attemptId: "e".repeat(32) }];
		// Act
		const returned = await Promise.all(attempts.map((attempt) => statement(attempt).first()));
		const receipts = attempts.map((attempt, index) =>
			readRelayAdmissionNonceReceipt(returned[index], attempt),
		);
		// Assert
		expect(returned.filter((row) => row !== null)).toHaveLength(1);
		expect(receipts.filter((receipt) => receipt !== null)).toHaveLength(1);
		expect(receipts.filter((receipt) => receipt === null)).toHaveLength(1);
		expect((await rows()).results).toHaveLength(1);
	});

	it("binds injection-shaped ledger input without accepting it as an association", async () => {
		// Arrange
		const input = {
			deviceId: "'); DROP TABLE relay_clock_test_nonces; --",
			nonce: "' OR 1=1 --",
			attemptId: association.attemptId,
		};
		// Act
		const row = await statement(input).first();
		// Assert
		expect(row).toMatchObject(input);
		expect(readRelayAdmissionNonceReceipt(row, input)).toBeNull();
		expect((await rows()).results).toEqual([
			expect.objectContaining({ device_id: input.deviceId, nonce: input.nonce }),
		]);
	});

	it("cannot recover positive insert evidence after discarding an acknowledgement", async () => {
		// Arrange: the first local write commits, but its receipt is deliberately discarded.
		await statement().first();
		const retry = { ...association, attemptId: "f".repeat(32) };
		// Act
		const result = await statement(retry).all();
		// Assert
		expect(result.results).toEqual([]);
		expect(readRelayAdmissionNonceReceipt(result.results[0], retry)).toBeNull();
		expect((await rows()).results).toHaveLength(1);
	});
});
