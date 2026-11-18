import { expect, it } from "vitest";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { DeviceRemovalOperations } from "./coordinator-device-removal.js";
import { removalCommitStatements } from "./coordinator-device-removal-commit.js";
import {
	type DeviceRemovalTarget,
	deviceRemovalDigest,
} from "./coordinator-device-removal-target.js";

const OP = {
	removalId: "b0b2b292-bec4-4d16-a583-3a18950f0810",
	actorId: null,
	now: "2026-11-18T00:00:00Z",
};
function target(count: number, publicKey = "opaque"): DeviceRemovalTarget {
	const rows = Array.from({ length: count }, (_, i) => ({
		group_id: `g${String(i).padStart(2, "0")}`,
		device_id: "d1",
		public_key: publicKey,
		fingerprint: "fp",
		key_id: "",
		identity_id: null,
		display_name: null,
	}));
	return {
		deviceIds: ["d1"],
		keyId: null,
		rows,
		bound: false,
		tuples: rows.map((row) => [row.group_id, row.device_id, row.public_key, row.fingerprint, null]),
	};
}

it("the 50-enrollment batch has 12 statements, at most five parameters each, and binds full tuples only once", () => {
	const captured = target(50, "é".repeat(9_000));
	const statements = removalCommitStatements(captured, OP, "1");
	const tuples = JSON.stringify(captured.tuples);
	expect(statements).toHaveLength(12);
	expect(statements.map((statement) => statement.values.length)).toEqual([
		5, 2, 2, 2, 5, 3, 3, 3, 4, 3, 2, 2,
	]);
	for (const [i, statement] of statements.entries()) {
		expect(statement.sql.match(/\?/gu)?.length).toBe(statement.values.length);
		expect(new TextEncoder().encode(statement.sql).byteLength).toBeLessThan(100_000);
		expect(statement.values.filter((value) => value === OP.removalId)).toHaveLength(1);
		expect(statement.values.includes(tuples)).toBe(i === 0);
		for (const value of statement.values)
			if (typeof value === "string")
				expect(new TextEncoder().encode(value).byteLength).toBeLessThan(2_000_000);
	}
	expect(new TextEncoder().encode(tuples).byteLength).toBeLessThanOrEqual(1_000_000);
	expect(new TextEncoder().encode(String(statements[1]?.values[0])).byteLength).toBeLessThan(1_000);
	expect(() => removalCommitStatements(target(2, "é".repeat(260_000)), OP, "1")).toThrow(
		"removal_target_too_large",
	);
});

it("every own-tombstone read uses pair index lookups followed by primary-key seeks, without scanning history", async () => {
	const f = setupStore("SQLite");
	try {
		const statements = removalCommitStatements(target(50), OP, "1");
		for (const statement of statements.slice(1, 11)) {
			const plans = f.db
				.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
				.all(...statement.values) as { detail: string }[];
			const details = plans.map(({ detail }) => detail);
			expect(
				details.some((detail) =>
					detail.includes(
						"SEARCH owned USING INDEX idx_coordinator_device_removals_active (group_id=? AND device_id=?)",
					),
				),
			).toBe(true);
			const accesses = details.filter((detail) => /SEARCH t|SCAN t/u.test(detail));
			expect(accesses.length).toBeGreaterThan(0);
			for (const detail of accesses) expect(detail).toMatch(/^SEARCH t .*\browid=\?/u);
			expect(details.filter((detail) => /^SCAN (owned|t)\b/u.test(detail))).toEqual([]);
		}
	} finally {
		await f.store.close();
	}
});

function successfulResults() {
	const write = (changes: number) => ({ meta: { changes } });
	return [
		write(1),
		write(0),
		write(0),
		write(1),
		write(0),
		write(0),
		write(0),
		write(0),
		write(0),
		{ results: [{ complete: 1 }] },
		{ results: [{ group_id: "g00", device_id: "d1", removal_seq: 1 }] },
		{ results: [{ available: 1 }] },
	];
}

it("A6 malformed commit receipts and backend failures report device_removal_incomplete", async () => {
	const captured = target(1);
	const request = { deviceIds: ["d1"], expectedDigest: await deviceRemovalDigest(captured) };
	const malformed: (() => unknown[])[] = [
		() => successfulResults().slice(1),
		() => {
			const rows = successfulResults();
			rows[10] = { results: [] };
			return rows;
		},
		() => {
			const rows = successfulResults();
			rows[10] = { results: [{ group_id: "wrong", device_id: "d1", removal_seq: 1 }] };
			return rows;
		},
		() => {
			const rows = successfulResults();
			rows[0] = { meta: { changes: 0 } };
			return rows;
		},
		() => {
			throw new Error("transport failure");
		},
	];
	for (const results of malformed) {
		const operations = new DeviceRemovalOperations({
			all: async () => ({ results: [] }),
			batch: async (statements) => {
				if (statements.length === 12) return results();
				return [
					{
						results: [
							{ available: 1, named: 1, canonical_keys: 0, opaque_texts: 1, targets: 1, bound: 0 },
						],
					},
					{ results: captured.rows },
				];
			},
		});
		await expect(operations.removeDeviceEnrollments(request)).rejects.toThrow(
			"device_removal_incomplete",
		);
	}
});
