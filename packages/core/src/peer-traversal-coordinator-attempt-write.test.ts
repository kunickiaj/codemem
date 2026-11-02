import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	BUILDERS,
	compileWrites,
	registerWriteScenarios,
	type WriteDatabase,
	type WriteSeedOptions,
	writeFixture,
} from "./peer-traversal-coordinator-attempt-write-test-fixtures.js";
import { TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS } from "./peer-traversal-coordinator-schema.js";
import type { Value } from "./peer-traversal-coordinator-schema-common-test-fixtures.js";
import { RELAY_ADMISSION_CLOCK_SQL } from "./relay-admission-clock.js";
import { PARTICIPANT_TEST_SCHEMA_SQL } from "./relay-admission-participant-nonce-test-fixtures.js";

const databases: Database.Database[] = [];
let sequence = 0;
async function create(options: WriteSeedOptions = {}) {
	const native = new Database(":memory:");
	databases.push(native);
	native.pragma("foreign_keys=ON");
	native.exec(PARTICIPANT_TEST_SCHEMA_SQL);
	const clock = { now: 1_800_000_000_000 as number | string | null };
	native.function("prepare_write_clock", () => {
		if (typeof clock.now === "number" && Number.isInteger(clock.now)) return BigInt(clock.now);
		return clock.now;
	});
	native.function("strftime", (format, when) => {
		if (format !== "%Y-%m-%dT%H:%M:%fZ" || when !== "now")
			throw new Error("unexpected clock format");
		if (typeof clock.now !== "number" || !Number.isSafeInteger(clock.now)) return null;
		return new Date(clock.now).toISOString();
	});
	const sql = (text: string) => text.replaceAll(RELAY_ADMISSION_CLOCK_SQL, "prepare_write_clock()");
	for (const text of TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS) native.exec(sql(text));
	const bindings = (values: readonly Value[]) =>
		Object.fromEntries(values.map((value, index) => [index + 1, value]));
	const run = (text: string, values: readonly Value[] = []) =>
		native.prepare(sql(text)).run(bindings(values));
	const db: WriteDatabase = {
		run: async (text, values) => run(text, values),
		all: async (text, values = []) =>
			native.prepare(sql(text)).all(bindings(values)) as Record<string, Value>[],
		batch: async (statements) =>
			native.transaction(() => {
				for (const entry of statements) run(entry.sql, entry.values);
			})(),
		returning: async (statement) =>
			native.prepare(sql(statement.sql)).get(bindings(statement.bindings)) ?? null,
	};
	return { ...(await writeFixture(db, Number(clock.now), ++sequence, options)), clock };
}
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
registerWriteScenarios(create);

describe("PREPARE SQL clock boundaries", () => {
	it.each([
		[-5001, false],
		[-5000, true],
		[29999, true],
		[30000, false],
		[55000, false],
	] as const)(
		"checks creation lead, admit-before and deadline at offset %s",
		async (offset, allowed) => {
			const f = await create();
			const { nonce, state } = await compileWrites(f);
			f.clock.now = f.now + offset;

			const results = await Promise.all([f.db.returning(nonce), f.db.returning(state)]);

			expect(results.map((row) => row !== null)).toEqual([allowed, allowed]);
		},
	);
	it.each([
		[-49999, true],
		[-50000, false],
		[10000, true],
		[10001, false],
	] as const)("checks readiness expiry and future lead at offset %s", async (offset, allowed) => {
		const f = await create({ authorityHealthOffset: offset, realmHealthOffset: offset });
		const { nonce, state } = await compileWrites(f);

		const results = await Promise.all([f.db.returning(nonce), f.db.returning(state)]);

		expect(results.map((row) => row !== null)).toEqual([allowed, allowed]);
	});
	it.each([null, -1, 1.5, "1800000000000", Number.MAX_SAFE_INTEGER + 1])(
		"denies both writes for invalid SQL clock %s",
		async (now) => {
			const f = await create();
			const { nonce, state } = await compileWrites(f);
			f.clock.now = now;

			const results = await Promise.all([f.db.returning(nonce), f.db.returning(state)]);

			expect(results).toEqual([null, null]);
			expect(await f.db.all("SELECT * FROM request_nonces")).toEqual([]);
			expect(await f.db.all("SELECT * FROM traversal_attempts")).toEqual([]);
		},
	);
});

describe("PREPARE compilation captures caller inputs", () => {
	it.each(BUILDERS)(
		"captures all mutable %s inputs before its first asynchronous hash",
		async (_name, build) => {
			const f = await create();
			const input = {
				...f.options,
				proof: structuredClone(f.options.proof),
				namespace: { ...f.options.namespace },
			};
			const expected = await build(input);

			const pending = build(input);
			input.proof.bodyBytes.fill(0);
			Object.assign(input.proof.value, { groupId: "changed", messageADigest: "0".repeat(64) });
			Object.assign(input.proof.signer, {
				deviceId: "changed",
				publicKey: "changed",
				keyId: "0".repeat(64),
			});
			Object.assign(input.proof, { packetDigest: "0".repeat(64), nonce: "0".repeat(32) });
			Object.assign(input.namespace, { authorityId: "0".repeat(64), groupId: "changed" });
			Object.assign(input, { participants: null, policyRevision: 2, execId: f.session(200) });
			const result = await pending;

			expect(expected).not.toBeNull();
			expect(result).toEqual(expected);
		},
	);
	it.each(BUILDERS)(
		"does not repair an initially invalid %s digest after the call yields",
		async (_name, build) => {
			const f = await create();
			const validDigest = f.options.proof.packetDigest;
			Object.assign(f.options.proof, { packetDigest: "0".repeat(64) });

			const pending = build(f.options);
			Object.assign(f.options.proof, { packetDigest: validDigest });
			const result = await pending;

			expect(result).toBeNull();
		},
	);
});
