import { describe, expect, it } from "vitest";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	DEVICE_REJOIN_STATUS_MAX_BODY_BYTES,
	isFreshDeviceRejoinStatus,
	parseDeviceRejoinStatusBody,
} from "./coordinator-device-rejoin-status.js";
import { registerRejoinStatusTests } from "./coordinator-device-rejoin-status-test-harness.js";

describe.each(["SQLite", "D1"] as const)("%s rejoin status verification", (backend) => {
	const withFixture: Parameters<typeof registerRejoinStatusTests>[0] = async (run) => {
		const { db, store } = setupStore(backend);
		const d1 = sqliteD1(db);
		try {
			await run({
				first: <T>({ sql, values }: { sql: string; values: (string | number | null)[] }) => {
					// Every production read must also succeed with SQLite writes disabled.
					db.pragma("query_only = ON");
					try {
						if (backend === "D1")
							return d1
								.prepare(sql)
								.bind(...values)
								.first<T>();
						return Promise.resolve((db.prepare(sql).get(...values) as T | undefined) ?? null);
					} finally {
						db.pragma("query_only = OFF");
					}
				},
				run: async (sql, ...values) => db.prepare(sql).run(...values),
			});
		} finally {
			await store.close();
			if (db.open) db.close();
		}
	};
	registerRejoinStatusTests(withFixture);
});

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const body = { device_id: "device", timestamp_ms: 1_791_028_800_000, signature: "signature" };

describe("rejoin status body", () => {
	it("accepts only the three protocol fields", () => {
		expect(parseDeviceRejoinStatusBody(encode(body))).toEqual({
			ok: true,
			input: { deviceId: "device", timestampMs: body.timestamp_ms, signature: "signature" },
		});
	});
	it.each([
		null,
		[],
		"text",
		{},
		{ ...body, extra: true },
		{ ...body, public_key: "key" },
		{ ...body, completion: "secret" },
		{ ...body, device_id: "" },
		{ ...body, device_id: "device\n" },
		{ ...body, timestamp_ms: "1" },
		{ ...body, timestamp_ms: -1 },
		{ ...body, timestamp_ms: 1.5 },
		{ ...body, timestamp_ms: Number.MAX_SAFE_INTEGER + 1 },
		{ ...body, signature: null },
		{ device_id: "device", timestamp_ms: body.timestamp_ms },
	])("rejects invalid shape %j", (value) => {
		expect(parseDeviceRejoinStatusBody(encode(value))).toEqual({
			ok: false,
			error: "device_rejoin_invalid_input",
		});
	});
	it("rejects malformed JSON and UTF-8", () => {
		for (const raw of [new TextEncoder().encode("{"), new Uint8Array([0xff])])
			expect(parseDeviceRejoinStatusBody(raw)).toEqual({
				ok: false,
				error: "device_rejoin_invalid_input",
			});
	});
	it("bounds raw bytes before decoding and accepts the exact limit", () => {
		const raw = encode(body);
		const padded = new Uint8Array(DEVICE_REJOIN_STATUS_MAX_BODY_BYTES).fill(32);
		padded.set(raw);
		expect(parseDeviceRejoinStatusBody(padded).ok).toBe(true);
		expect(
			parseDeviceRejoinStatusBody(new Uint8Array(DEVICE_REJOIN_STATUS_MAX_BODY_BYTES + 1)),
		).toEqual({
			ok: false,
			error: "body_too_large",
		});
	});
	it.each([-300_001, -300_000, 0, 300_000, 300_001])("checks the clock boundary %i", (offset) => {
		expect(isFreshDeviceRejoinStatus(body.timestamp_ms + offset, body.timestamp_ms)).toBe(
			Math.abs(offset) <= 300_000,
		);
	});
	it.each([NaN, Infinity, -1, 1.5, "1", null, undefined, Number.MAX_SAFE_INTEGER + 1])(
		"refuses an invalid timestamp or clock %j",
		(value) => {
			expect(isFreshDeviceRejoinStatus(value, body.timestamp_ms)).toBe(false);
			expect(isFreshDeviceRejoinStatus(body.timestamp_ms, value)).toBe(false);
		},
	);
});
