import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { readTraversalStateReceipt } from "./peer-traversal-coordinator-attempt-write.js";
import {
	BUILDERS,
	type WriteDatabase,
	type WriteSeedOptions,
	writeFixture,
} from "./peer-traversal-coordinator-attempt-write-test-fixtures.js";
import {
	phaseChain,
	phaseProof,
	phaseStatements,
	registerPhaseScenarios,
} from "./peer-traversal-coordinator-phase-write-test-fixtures.js";
import { TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS } from "./peer-traversal-coordinator-schema.js";
import type { Value } from "./peer-traversal-coordinator-schema-common-test-fixtures.js";
import {
	RELAY_ADMISSION_CLOCK_SQL,
	readRelayAdmissionNonceReceipt,
} from "./relay-admission-clock.js";
import { PARTICIPANT_TEST_SCHEMA_SQL } from "./relay-admission-participant-nonce-test-fixtures.js";

const databases: Database.Database[] = [];
let sequence = 0x760000;
async function create(options: WriteSeedOptions = {}) {
	const native = new Database(":memory:");
	databases.push(native);
	native.pragma("foreign_keys=ON");
	native.exec(PARTICIPANT_TEST_SCHEMA_SQL);
	const clock = { now: 1_800_000_000_000 };
	native.function("phase_test_clock", () => BigInt(clock.now));
	native.function("strftime", (format, when) => {
		if (format !== "%Y-%m-%dT%H:%M:%fZ" || when !== "now")
			throw new Error("unexpected clock format");
		return new Date(clock.now).toISOString();
	});
	const sql = (text: string) => text.replaceAll(RELAY_ADMISSION_CLOCK_SQL, "phase_test_clock()");
	for (const text of TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS) native.exec(sql(text));
	const bind = (values: readonly Value[]) =>
		Object.fromEntries(values.map((value, index) => [index + 1, value]));
	const run = (text: string, values: readonly Value[] = []) =>
		native.prepare(sql(text)).run(bind(values));
	const db: WriteDatabase = {
		run: async (text, values) => run(text, values),
		all: async (text, values = []) =>
			native.prepare(sql(text)).all(bind(values)) as Record<string, Value>[],
		batch: async (statements) =>
			native.transaction(() => {
				for (const statement of statements) run(statement.sql, statement.values);
			})(),
		returning: async (statement) =>
			native.prepare(sql(statement.sql)).get(bind(statement.bindings)) ?? null,
	};
	return { ...(await writeFixture(db, clock.now, ++sequence, options)), clock };
}
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
registerPhaseScenarios(create);

describe("CAS SQL clocks and async capture", () => {
	it("uses each final state SQL clock rather than the earlier nonce or PREPARE clock", async () => {
		const f = await create();
		const chain = await phaseChain(f);

		for (const [index, proof] of chain.entries()) {
			const { nonce, state } = await phaseStatements(f, proof);
			const receipt = readRelayAdmissionNonceReceipt(
				await f.db.returning(nonce),
				nonce.association,
			);
			f.clock.now = f.now + (index + 1) * 1000;
			const parsed = readTraversalStateReceipt(await f.db.returning(state), state);

			expect(receipt).not.toBeNull();
			expect(parsed).not.toBeNull();
			expect(parsed?.updatedAtMs).toBe(f.clock.now);
			expect(parsed?.receipt.decidedAtMs).toBe(f.clock.now);
			expect(parsed?.receipt.decidedAtMs).not.toBe(receipt?.decidedAtMs);
		}
	});
	it.each([2, 4])(
		"captures phase %s descriptions, chain digests, signer and options before hashing yields",
		async (phase) => {
			const f = await create();
			const chain = await phaseChain(f);
			for (const [, build] of BUILDERS) {
				const input = {
					...f.options,
					proof: structuredClone(phaseProof(chain, phase)),
					namespace: { ...f.options.namespace },
				};
				const expected = await build(input);

				const pending = build(input);
				input.proof.bodyBytes.fill(0);
				if ("descriptionBytes" in input.proof.value) input.proof.value.descriptionBytes.fill(0);
				Object.assign(input.proof.value, {
					prepareDigest: "0".repeat(64),
					messageADigest: "0".repeat(64),
				});
				Object.assign(input.proof.signer, {
					deviceId: "foreign",
					publicKey: "foreign",
					keyId: "0".repeat(64),
				});
				Object.assign(input.proof, { packetDigest: "0".repeat(64), nonce: f.session(900) });
				Object.assign(input.namespace, { groupId: "foreign", authorityId: "0".repeat(64) });
				Object.assign(input, { participants: null, execId: f.session(901), policyRevision: 2 });
				const actual = await pending;

				expect(expected).not.toBeNull();
				expect(actual).toEqual(expected);
			}
		},
	);
});
