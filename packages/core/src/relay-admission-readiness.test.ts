import { afterEach, describe, expect, it, vi } from "vitest";
import { readRelayAdmissionNonceReceipt } from "./relay-admission-clock.js";
import {
	RELAY_READINESS_MAX_LEAD_MS,
	RELAY_READINESS_VALIDITY_MS,
	readRelayAdmissionReadinessStamp,
} from "./relay-admission-readiness.js";

const METADATA_ASSOCIATION = {
	deviceId: "device-A",
	nonce: "b".repeat(32),
	attemptId: "c".repeat(32),
};
const METADATA_NOW = 130_000;
afterEach(() => vi.restoreAllMocks());

const rawStamp = () => ({
	...METADATA_ASSOCIATION,
	decidedAtMs: METADATA_NOW,
	createdAt: "1970-01-01T00:02:10.000Z",
	policyRevision: 1,
	readinessRevision: 2,
	readinessObservedAtMs: 129000,
});
describe("readiness stamp shape validation, not grant authorization", () => {
	it.each([null, undefined, [], { results: [rawStamp()] }, { meta: { changes: 1 } }])(
		"rejects missing rows and result envelopes %j",
		(row) => {
			// Arrange
			const receipt = rawStamp();
			// Act
			const stamp = readRelayAdmissionReadinessStamp(row, receipt);
			// Assert
			expect(stamp).toBeNull();
		},
	);
	it("returns only stamp fields without a JavaScript clock or input mutation", () => {
		// Arrange
		const row = Object.freeze({ ...rawStamp(), extra: "ignored" });
		const receipt = readRelayAdmissionNonceReceipt(row, METADATA_ASSOCIATION);
		if (!receipt) throw new Error("missing validated clock receipt");
		Object.freeze(receipt);
		vi.spyOn(Date, "now").mockImplementation(() => {
			throw new Error("no application clock");
		});
		// Act
		const stamp = readRelayAdmissionReadinessStamp(row, receipt);
		// Assert
		expect([RELAY_READINESS_VALIDITY_MS, RELAY_READINESS_MAX_LEAD_MS]).toEqual([50000, 10000]);
		expect(stamp).toEqual({
			revision: 2,
			state: "ready",
			observedAtMs: 129000,
			validUntilMs: 179000,
		});
		expect(stamp).not.toBe(row);
	});
	it("rejects a stale attempt using the caller's fresh association before reading a stamp", () => {
		// Arrange: shape alone cannot associate a row with the current execution.
		const row = rawStamp();
		const expected = { ...METADATA_ASSOCIATION, attemptId: "d".repeat(32) };
		const readStamp = vi.fn(readRelayAdmissionReadinessStamp);
		// Act
		const receipt = readRelayAdmissionNonceReceipt(row, expected);
		if (receipt) readStamp(row, receipt);
		// Assert
		expect(receipt).toBeNull();
		expect(readStamp).not.toHaveBeenCalled();
	});
	it.each([
		{ policyRevision: 0 },
		{ policyRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ policyRevision: 1.5 },
		{ readinessRevision: 0 },
		{ readinessRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ readinessRevision: "2" },
		{ readinessObservedAtMs: -1 },
		{ readinessObservedAtMs: 1.5 },
		{ readinessObservedAtMs: Number.MAX_SAFE_INTEGER - 49999 },
		{ readinessObservedAtMs: 80000 },
		{ readinessObservedAtMs: 140001 },
		{ attemptId: "d".repeat(32) },
		{ nonce: "e".repeat(32) },
		{ deviceId: "other" },
		{ decidedAtMs: 130001 },
		{ createdAt: "1970-01-01T00:02:10Z" },
	])("rejects invalid raw stamp or clock association %j", (change) => {
		// Arrange
		const row = { ...rawStamp(), ...change };
		// Act
		const stamp = readRelayAdmissionReadinessStamp(row, rawStamp());
		// Assert
		expect(stamp).toBeNull();
	});
	it.each(Object.keys(rawStamp()))("requires raw row field %s", (key) => {
		// Arrange
		const row: Record<string, unknown> = rawStamp();
		delete row[key];
		// Act
		const stamp = readRelayAdmissionReadinessStamp(row, rawStamp());
		// Assert
		expect(stamp).toBeNull();
	});
	it("snapshots required raw and receipt getters exactly once", () => {
		// Arrange
		const original = rawStamp();
		const validated = readRelayAdmissionNonceReceipt(original, METADATA_ASSOCIATION);
		if (!validated) throw new Error("missing validated clock receipt");
		const getters: ReturnType<typeof vi.fn>[] = [];
		const snapshot = <T extends object>(fields: T): T =>
			Object.defineProperties(
				{ ...fields },
				Object.fromEntries(
					Object.entries(fields).map(([key, value]) => {
						const get = vi
							.fn()
							.mockReturnValueOnce(value)
							.mockImplementation(() => {
								throw new Error("reread");
							});
						getters.push(get);
						return [key, { get }];
					}),
				),
			);
		const row = snapshot(original);
		const receipt = snapshot(validated);
		// Act
		const stamp = readRelayAdmissionReadinessStamp(row, receipt);
		// Assert
		expect(stamp).not.toBeNull();
		expect(getters).toHaveLength(13);
		for (const get of getters) expect(get).toHaveBeenCalledTimes(1);
	});
	it("returns null without logging when a private getter throws", () => {
		// Arrange
		const row = Object.defineProperty(rawStamp(), "readinessRevision", {
			get() {
				throw new Error("private");
			},
		});
		const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
		// Act
		const stamp = readRelayAdmissionReadinessStamp(row, rawStamp());
		// Assert
		expect(stamp).toBeNull();
		for (const log of logs) expect(log).not.toHaveBeenCalled();
	});
});
