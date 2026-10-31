import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type RelayAdmissionNonceAssociation,
	readRelayAdmissionNonceReceipt,
} from "./relay-admission-clock.js";
import {
	RELAY_CLOCK_TEST_INSERT_SQL,
	RELAY_CLOCK_TEST_ROWS_SQL,
	RELAY_CLOCK_TEST_SCHEMA_SQL,
} from "./relay-admission-clock-test-fixtures.js";

const association: RelayAdmissionNonceAssociation = {
	deviceId: "device-A",
	nonce: "a".repeat(32),
	attemptId: "b".repeat(32),
};
const validRow = () => ({
	...association,
	decidedAtMs: 129_999,
	createdAt: "1970-01-01T00:02:09.999Z",
});

afterEach(() => vi.restoreAllMocks());

describe("relay admission nonce receipt parser", () => {
	it("returns a fresh known-field snapshot without changing the input", () => {
		// Arrange: future SQL projections must not become receipt authority.
		const row = Object.freeze({ ...validRow(), readiness: "unrelated" });
		// Act
		const receipt = readRelayAdmissionNonceReceipt(row, association);
		// Assert
		expect(receipt).toEqual(validRow());
		expect(receipt).not.toBe(row);
		expect(row.readiness).toBe("unrelated");
	});

	it.each([0, 1, 129_001, 129_999, 130_000, 8_640_000_000_000_000])(
		"accepts a canonical UTC receipt at %i ms without checking JavaScript freshness",
		(decidedAtMs) => {
			// Arrange
			const row = { ...association, decidedAtMs, createdAt: new Date(decidedAtMs).toISOString() };
			vi.spyOn(Date, "now").mockImplementation(() => {
				throw new Error("no JS clock");
			});
			// Act
			const receipt = readRelayAdmissionNonceReceipt(row, association);
			// Assert
			expect(receipt).toEqual(row);
		},
	);

	it.each(["!", "~".repeat(64)])("accepts visible ASCII device boundary %s", (deviceId) => {
		// Arrange
		const expected = { ...association, deviceId };
		const row = { ...validRow(), deviceId };
		// Act
		const receipt = readRelayAdmissionNonceReceipt(row, expected);
		// Assert
		expect(receipt).toEqual(row);
	});

	it.each([
		null,
		undefined,
		true,
		1,
		"row",
		[],
		{},
		{ meta: { changes: 1 } },
		{ results: [validRow()], meta: { changes: 1 }, success: true },
	])("rejects absent rows and write-result envelopes (%j)", (row) => {
		// Arrange
		const expected = { ...association };
		// Act
		const receipt = readRelayAdmissionNonceReceipt(row, expected);
		// Assert
		expect(receipt).toBeNull();
	});

	it.each(["deviceId", "nonce", "attemptId", "decidedAtMs", "createdAt"])(
		"rejects a receipt missing %s",
		(field) => {
			// Arrange
			const row: Record<string, unknown> = validRow();
			delete row[field];
			// Act
			const receipt = readRelayAdmissionNonceReceipt(row, association);
			// Assert
			expect(receipt).toBeNull();
		},
	);

	it.each([{ deviceId: "other-device" }, { nonce: "c".repeat(32) }, { attemptId: "d".repeat(32) }])(
		"rejects another invocation's association %j",
		(change) => {
			// Arrange
			const row = { ...validRow(), ...change };
			// Act
			const receipt = readRelayAdmissionNonceReceipt(row, association);
			// Assert
			expect(receipt).toBeNull();
		},
	);

	it.each([
		{ deviceId: "" },
		{ deviceId: "x".repeat(65) },
		{ deviceId: "has space" },
		{ deviceId: "\u001f" },
		{ deviceId: "\u007f" },
		{ deviceId: "é" },
		{ nonce: "A".repeat(32) },
		{ nonce: "a".repeat(31) },
		{ nonce: "a".repeat(33) },
		{ nonce: "g".repeat(32) },
		{ attemptId: "B".repeat(32) },
		{ attemptId: "b".repeat(31) },
		{ attemptId: "b".repeat(33) },
		{ attemptId: "z".repeat(32) },
	])("rejects an invalid expected tuple even when the row matches %j", (change) => {
		// Arrange
		const expected = { ...association, ...change };
		const row = { ...validRow(), ...change };
		// Act
		const receipt = readRelayAdmissionNonceReceipt(row, expected);
		// Assert
		expect(receipt).toBeNull();
	});
});

describe("relay admission receipt clock validation and snapshots", () => {
	it.each([
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
		Number.MAX_SAFE_INTEGER,
		"129999",
		null,
		undefined,
	])("rejects invalid or unrenderable millisecond clocks %s", (decidedAtMs) => {
		// Arrange
		const row = { ...validRow(), decidedAtMs };
		// Act
		const receipt = readRelayAdmissionNonceReceipt(row, association);
		// Assert
		expect(receipt).toBeNull();
	});

	it.each([
		"1970-01-01T00:02:10.000Z",
		"1970-01-01T00:02:09.999+00:00",
		"1970-01-01 00:02:09.999Z",
		"1970-01-01T00:02:09.9990Z",
		"invalid",
		129999,
		null,
	])("rejects noncanonical or clock-mismatched timestamps %s", (createdAt) => {
		// Arrange
		const row = { ...validRow(), createdAt };
		// Act
		const receipt = readRelayAdmissionNonceReceipt(row, association);
		// Assert
		expect(receipt).toBeNull();
	});

	it("captures each required row getter once", () => {
		// Arrange: validate and return the same snapshot, even for changing getters.
		const original = validRow();
		const getters = Object.fromEntries(
			Object.entries(original).map(([key, value]) => [
				key,
				vi
					.fn()
					.mockReturnValueOnce(value)
					.mockImplementation(() => {
						throw new Error("second read");
					}),
			]),
		);
		const row = Object.defineProperties(
			{},
			Object.fromEntries(Object.entries(getters).map(([key, get]) => [key, { get }])),
		);
		// Act
		const receipt = readRelayAdmissionNonceReceipt(row, association);
		// Assert
		expect(receipt).toEqual(original);
		for (const get of Object.values(getters)) expect(get).toHaveBeenCalledTimes(1);
	});

	it("returns null without logging when a row getter throws", () => {
		// Arrange
		const row = Object.defineProperty(validRow(), "nonce", {
			get() {
				throw new Error("private value");
			},
		});
		const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
		// Act
		const receipt = readRelayAdmissionNonceReceipt(row, association);
		// Assert
		expect(receipt).toBeNull();
		for (const log of logs) expect(log).not.toHaveBeenCalled();
	});
});

describe("relay admission clock on disposable in-memory SQLite", () => {
	let db: Database.Database;
	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(RELAY_CLOCK_TEST_SCHEMA_SQL);
	});
	afterEach(() => db.close());
	const insert = (expected = association, admitBeforeMs = Number.MAX_SAFE_INTEGER) =>
		db.prepare(RELAY_CLOCK_TEST_INSERT_SQL).get({
			1: expected.deviceId,
			2: expected.nonce,
			3: expected.attemptId,
			4: admitBeforeMs,
		});

	it("returns the actual inserted row with the same UTC clock in predicate and receipt", () => {
		// Arrange: host bounds are a local sanity check, not a remote clock SLO.
		const before = Date.now();
		// Act
		const row = insert();
		const after = Date.now();
		const receipt = readRelayAdmissionNonceReceipt(row, association);
		// Assert
		expect(receipt).not.toBeNull();
		expect(Number.isSafeInteger(receipt?.decidedAtMs)).toBe(true);
		expect(receipt?.decidedAtMs).toBeGreaterThanOrEqual(before);
		expect(receipt?.decidedAtMs).toBeLessThanOrEqual(after);
		expect(receipt?.createdAt).toBe(new Date(receipt?.decidedAtMs ?? -1).toISOString());
		expect(db.prepare(RELAY_CLOCK_TEST_ROWS_SQL).all()).toEqual([
			{ device_id: association.deviceId, nonce: association.nonce, created_at: receipt?.createdAt },
		]);
	});

	it.each([
		{
			seconds: "129",
			fraction: "09.999",
			iso: "1970-01-01T00:02:09.999Z",
			ms: 129999,
			deadline: 130000,
			accepted: true,
		},
		{
			seconds: "130",
			fraction: "10.001",
			iso: "1970-01-01T00:02:10.001Z",
			ms: 130001,
			deadline: 130002,
			accepted: true,
		},
		{
			seconds: "130",
			fraction: "10.000",
			iso: "1970-01-01T00:02:10.000Z",
			ms: 130000,
			deadline: 130000,
			accepted: false,
		},
		{
			seconds: "-1",
			fraction: "59.999",
			iso: "1969-12-31T23:59:59.999Z",
			ms: -1,
			deadline: 130000,
			accepted: false,
		},
	])("preserves exact millisecond deadline behavior %j", (clock) => {
		// Arrange: override SQLite's clock only in this disposable connection.
		db.function("strftime", (format, when) => {
			expect(when).toBe("now");
			if (format === "%s") return clock.seconds;
			if (format === "%f") return clock.fraction;
			if (format === "%Y-%m-%dT%H:%M:%fZ") return clock.iso;
			throw new Error(`Unexpected format: ${format}`);
		});
		// Act
		const row = insert(association, clock.deadline);
		const receipt = readRelayAdmissionNonceReceipt(row, association);
		// Assert
		if (clock.accepted)
			expect(receipt).toEqual({ ...association, decidedAtMs: clock.ms, createdAt: clock.iso });
		else {
			expect(row).toBeUndefined();
			expect(receipt).toBeNull();
		}
		expect(db.prepare(RELAY_CLOCK_TEST_ROWS_SQL).all()).toHaveLength(Number(clock.accepted));
	});

	it("returns no receipt on replay despite a stored nonce and a new attempt token", () => {
		// Arrange
		const first = insert();
		const retry = { ...association, attemptId: "c".repeat(32) };
		// Act
		const replay = insert(retry);
		// Assert
		expect(readRelayAdmissionNonceReceipt(first, association)).not.toBeNull();
		expect(replay).toBeUndefined();
		expect(readRelayAdmissionNonceReceipt(replay, retry)).toBeNull();
		expect(readRelayAdmissionNonceReceipt(first, retry)).toBeNull();
		expect(db.prepare(RELAY_CLOCK_TEST_ROWS_SQL).all()).toHaveLength(1);
	});

	it("leaves no nonce when the SQL deadline has expired", () => {
		// Arrange
		const deadline = 0;
		// Act
		const row = insert(association, deadline);
		// Assert
		expect(row).toBeUndefined();
		expect(readRelayAdmissionNonceReceipt(row, association)).toBeNull();
		expect(db.prepare(RELAY_CLOCK_TEST_ROWS_SQL).all()).toEqual([]);
	});

	it("stores injection-shaped inputs as bound ledger text without changing the table", () => {
		// Arrange: these deliberately invalid identities test SQL binding only.
		const input = {
			deviceId: "'); DROP TABLE relay_clock_test_nonces; --",
			nonce: "' OR 1=1 --",
			attemptId: association.attemptId,
		};
		// Act
		const row = insert(input);
		// Assert
		expect(row).toMatchObject(input);
		expect(readRelayAdmissionNonceReceipt(row, input)).toBeNull();
		expect(db.prepare(RELAY_CLOCK_TEST_ROWS_SQL).all()).toEqual([
			expect.objectContaining({ device_id: input.deviceId, nonce: input.nonce }),
		]);
	});

	it("cannot recreate a positive receipt after discarding an inserted acknowledgement", () => {
		// Arrange: commit locally, then discard the response instead of fabricating success.
		insert();
		const retry = { ...association, attemptId: "d".repeat(32) };
		// Act
		const rows = db
			.prepare(RELAY_CLOCK_TEST_INSERT_SQL)
			.all({ 1: retry.deviceId, 2: retry.nonce, 3: retry.attemptId, 4: Number.MAX_SAFE_INTEGER });
		// Assert
		expect(rows).toEqual([]);
		expect(readRelayAdmissionNonceReceipt(rows[0], retry)).toBeNull();
		expect(db.prepare(RELAY_CLOCK_TEST_ROWS_SQL).all()).toHaveLength(1);
	});
});
