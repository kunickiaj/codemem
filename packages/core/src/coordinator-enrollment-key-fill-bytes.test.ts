import { expect, it } from "vitest";
import { DeviceRemovalOperations } from "./coordinator-device-removal.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { READINESS_GENERATION_PRESENT } from "./coordinator-readiness-invalidation.js";

type Read = { sql: string; values: (string | number | null)[] };
/** A backend whose database has migration 0056, so each fill batch has three statements. */
const migrated =
	(read: (statement: Read) => Promise<unknown>) =>
	async (statement: Read): Promise<unknown> =>
		statement.sql === READINESS_GENERATION_PRESENT
			? { results: [{ present: 1 }] }
			: read(statement);

it("fill consumes a contiguous byte-bounded prefix, skips individually oversized rows, and does not write an all-oversized page", async () => {
	const key = `${CANONICAL_PUBLIC_KEY} ${'é"\\\n'.repeat(62_000)}`;
	const oversized = `opaque ${'é"\\\n'.repeat(130_000)}`;
	const rows = [key, key, key, oversized, CANONICAL_PUBLIC_KEY].map((public_key, i) => ({
		row_id: i + 1,
		public_key,
	}));
	const written: { row_id: number; key_id: string; public_key: string }[][] = [];
	const store = new DeviceRemovalOperations({
		all: migrated(async ({ values }) => ({
			results: rows.filter((row) => row.row_id > Number(values[0])),
		})),
		batch: async (statements) => {
			const entries = JSON.parse(String(statements[0]?.values[0]));
			written.push(entries);
			return [
				{ meta: { changes: entries.length } },
				{ results: [{ blocked: 0 }] },
				{ meta: { changes: 0 } },
			];
		},
	});
	const one = await store.fillEnrollmentKeyIds({ limit: 5 });
	expect(one).toEqual({ filled: 2, blocked: 0, skipped: 0, remaining: true, next: 2 });
	const two = await store.fillEnrollmentKeyIds({ limit: 5, after: one.next });
	expect(two).toEqual({ filled: 2, blocked: 0, skipped: 1, remaining: false, next: 5 });
	expect(written.map((page) => page.map((row) => row.row_id))).toEqual([
		[1, 2],
		[3, 5],
	]);
	for (const page of written) {
		expect(page.every((row) => row.key_id === EXPECTED_KEY_ID)).toBe(true);
		expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
			1_000_000,
		);
	}
	let writes = 0;
	const largeOnly = new DeviceRemovalOperations({
		all: migrated(async () => ({ results: [rows[3]] })),
		batch: async () => {
			writes++;
			throw new Error("Must not write");
		},
	});
	expect(await largeOnly.fillEnrollmentKeyIds()).toEqual({
		filled: 0,
		blocked: 0,
		skipped: 1,
		remaining: false,
		next: 4,
	});
	expect(writes).toBe(0);
	expect(rows[3]?.public_key).toBe(oversized);
	// Exact boundary includes braces, field names, brackets and the empty key ID.
	const overhead = new TextEncoder().encode(
		JSON.stringify([{ row_id: 4, public_key: "", key_id: "" }]),
	).byteLength;
	const boundary = { row_id: 4, public_key: "x".repeat(1_000_000 - overhead) };
	let sent = 0;
	const bounded = new DeviceRemovalOperations({
		all: migrated(async () => ({ results: [boundary] })),
		batch: async (statements) => {
			sent++;
			expect(new TextEncoder().encode(String(statements[0]?.values[0])).byteLength).toBe(1_000_000);
			return [{ meta: { changes: 1 } }, { results: [{ blocked: 0 }] }, { meta: { changes: 0 } }];
		},
	});
	expect((await bounded.fillEnrollmentKeyIds()).filled).toBe(1);
	boundary.public_key += "x";
	expect((await bounded.fillEnrollmentKeyIds()).skipped).toBe(1);
	expect(sent).toBe(1);
});
