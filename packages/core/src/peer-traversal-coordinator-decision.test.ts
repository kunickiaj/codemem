import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type WriteDatabase,
	type WriteSeedOptions,
	writeFixture,
} from "./peer-traversal-coordinator-attempt-write-test-fixtures.js";
import {
	decideTraversalSignal,
	type TraversalSignalDeviceReservation,
	type TraversalSignalIngressReservation,
} from "./peer-traversal-coordinator-decision.js";
import {
	type Bindings,
	decisionHarness,
	decisionOptions,
	isNonceSql,
	nonceRows,
	rawRow,
	registerDecisionScenarios,
	stateRows,
} from "./peer-traversal-coordinator-decision-test-fixtures.js";
import { TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS } from "./peer-traversal-coordinator-schema.js";
import type { Value } from "./peer-traversal-coordinator-schema-common-test-fixtures.js";
import { RELAY_ADMISSION_CLOCK_SQL } from "./relay-admission-clock.js";
import { PARTICIPANT_TEST_SCHEMA_SQL } from "./relay-admission-participant-nonce-test-fixtures.js";

const databases: Database.Database[] = [];
let sequence = 0x780000;
async function create(options: WriteSeedOptions = {}) {
	const native = new Database(":memory:");
	databases.push(native);
	native.pragma("foreign_keys=ON");
	native.exec(PARTICIPANT_TEST_SCHEMA_SQL);
	const clock = { now: 1_800_000_000_000 as number | string | null };
	native.function("decision_test_clock", () => {
		if (typeof clock.now === "number" && Number.isInteger(clock.now)) return BigInt(clock.now);
		return clock.now;
	});
	native.function("strftime", (format, when) => {
		if (format !== "%Y-%m-%dT%H:%M:%fZ" || when !== "now")
			throw new Error("unexpected clock format");
		if (typeof clock.now !== "number" || !Number.isSafeInteger(clock.now)) return null;
		return new Date(clock.now).toISOString();
	});
	const sql = (text: string) => text.replaceAll(RELAY_ADMISSION_CLOCK_SQL, "decision_test_clock()");
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
	vi.restoreAllMocks();
});
registerDecisionScenarios(create);

describe("decision clock and crypto ordering", () => {
	it("reserves ingress before all database/hash work and verifies exactly one signature before the device budget", async () => {
		const f = await create();
		const h = decisionHarness(f);
		const digest = vi.spyOn(crypto.subtle, "digest");
		const verify = vi.spyOn(crypto.subtle, "verify");
		const ingress = h.deps.budgets.reserveIngress.getMockImplementation();
		const device = h.deps.budgets.reserveVerifiedDevice.getMockImplementation();
		if (!ingress || !device) throw new Error("missing test budgets");
		h.deps.budgets.reserveIngress.mockImplementation(
			async (reservation: TraversalSignalIngressReservation) => {
				expect(digest).not.toHaveBeenCalled();
				expect(h.deps.database.query).not.toHaveBeenCalled();
				return ingress(reservation);
			},
		);
		h.deps.budgets.reserveVerifiedDevice.mockImplementation(
			async (reservation: TraversalSignalDeviceReservation) => {
				expect(verify).toHaveBeenCalledTimes(1);
				return device(reservation);
			},
		);

		const result = await decideTraversalSignal(decisionOptions(f), h.deps);

		expect(result).not.toBeNull();
		expect(verify).toHaveBeenCalledTimes(1);
	});
	it.each(["budget", "preflight"] as const)(
		"does no key hashing after %s denial",
		async (stage) => {
			const f = await create(stage === "preflight" ? { omit: "realmHealth" } : {});
			const h = decisionHarness(f);
			if (stage === "budget") h.deps.budgets.reserveIngress.mockResolvedValue("denied");
			const digest = vi.spyOn(crypto.subtle, "digest");

			const result = await decideTraversalSignal(decisionOptions(f), h.deps);

			expect(result).toBeNull();
			expect(digest).not.toHaveBeenCalled();
			expect(h.deps.database.writeReturning).not.toHaveBeenCalled();
		},
	);
	it.each([null, -1, 1.5, "1800000000000", Number.MAX_SAFE_INTEGER + 1])(
		"denies invalid preflight SQL clock %s",
		async (now) => {
			const f = await create();
			const h = decisionHarness(f);
			f.clock.now = now;

			const result = await decideTraversalSignal(decisionOptions(f), h.deps);

			expect(result).toBeNull();
			expect(h.deps.database.writeReturning).not.toHaveBeenCalled();
			expect(h.deps.budgets.reserveVerifiedDevice).not.toHaveBeenCalled();
		},
	);
	it("uses the final SQL clock and current health observation instead of the earlier nonce receipt", async () => {
		const f = await create();
		const h = decisionHarness(f);
		const write = h.deps.database.writeReturning.getMockImplementation();
		if (!write) throw new Error("missing test writer");
		h.deps.database.writeReturning.mockImplementation(async (sql: string, values: Bindings) => {
			if (!isNonceSql(sql)) {
				f.clock.now = f.now + 1234;
				await f.db.run(
					"UPDATE traversal_readiness SET revision=2,observed_at_ms=?2 WHERE authority_id=?1 AND scope='authority'",
					[f.authority, f.now + 1000],
				);
				await f.db.run(
					"UPDATE traversal_readiness SET revision=2,observed_at_ms=?2 WHERE authority_id=?1 AND scope='realm'",
					[f.authority, f.now + 1000],
				);
			}
			return write(sql, values);
		});

		const result = await decideTraversalSignal(decisionOptions(f), h.deps);

		expect(result).toMatchObject({
			decidedAtMs: f.now + 1234,
			readyObservedAtMs: f.now + 1000,
			remainingMs: f.options.proof.value.attemptNotAfter * 1000 - f.now - 1234,
		});
	});
	it.each([null, "1800000000000", 1.5, 30000])(
		"denies an unknown or expired final clock %s after consuming the nonce",
		async (now) => {
			const f = await create();
			const h = decisionHarness(f);
			const write = h.deps.database.writeReturning.getMockImplementation();
			if (!write) throw new Error("missing test writer");
			h.deps.database.writeReturning.mockImplementation(async (sql: string, values: Bindings) => {
				if (!isNonceSql(sql)) f.clock.now = now === 30000 ? f.now + now : now;
				return write(sql, values);
			});

			const result = await decideTraversalSignal(decisionOptions(f), h.deps);

			expect(result).toBeNull();
			expect(await nonceRows(f)).toHaveLength(1);
			expect(await stateRows(f)).toEqual([]);
		},
	);
});

describe("decision owns inputs and ports before yielding", () => {
	it("keeps original packet, namespace, actor, path and bound capabilities across ingress await", async () => {
		const f = await create();
		const h = decisionHarness(f);
		const input = decisionOptions(f);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const ingress = h.deps.budgets.reserveIngress.getMockImplementation();
		if (!ingress) throw new Error("missing ingress fixture");
		h.deps.budgets.reserveIngress.mockImplementationOnce(
			async (reservation: TraversalSignalIngressReservation) => {
				await ingress(reservation);
				entered.resolve();
				await release.promise;
				return "reserved";
			},
		);

		const pending = decideTraversalSignal(input, h.deps);
		await entered.promise;
		Object.assign(rawRow(input.packet), {
			body: "changed",
			signature: "changed",
			nonce: "changed",
		});
		Object.assign(input.namespace, { authorityId: "0".repeat(64), groupId: "changed" });
		Object.assign(input, {
			expectedPhase: "answer",
			deviceHeader: "changed",
			externalPathname: "/changed",
			ingressKey: "changed",
		});
		Reflect.set(
			h.deps.database,
			"query",
			vi.fn(async () => {
				throw new Error("changed private query");
			}),
		);
		Reflect.set(
			h.deps.database,
			"writeReturning",
			vi.fn(async () => {
				throw new Error("changed private writer");
			}),
		);
		Reflect.set(
			h.deps.budgets,
			"reserveVerifiedDevice",
			vi.fn(async () => "denied"),
		);
		release.resolve();
		const result = await pending;

		expect(result).toMatchObject({
			phase: "prepare",
			sessionId: f.options.proof.value.sessionId,
			packetDigest: f.options.proof.packetDigest,
			requestNonce: f.options.proof.nonce,
		});
		expect(h.trace).toEqual(["ingress", "preflight", "participants", "verified", "nonce", "state"]);
	});
	it("never repairs a captured invalid signature after ingress yields", async () => {
		const f = await create();
		const h = decisionHarness(f);
		const input = decisionOptions(f);
		const packet = input.packet;
		if (!packet || typeof packet !== "object") throw new Error("missing packet fixture");
		const validSignature = Reflect.get(packet, "signature");
		Object.assign(packet, { signature: `v2:${btoa(String.fromCharCode(...new Uint8Array(64)))}` });
		h.deps.budgets.reserveIngress.mockImplementationOnce(async () => {
			Object.assign(packet, { signature: validSignature });
			return "reserved";
		});

		const result = await decideTraversalSignal(input, h.deps);

		expect(result).toBeNull();
		expect(h.deps.budgets.reserveVerifiedDevice).not.toHaveBeenCalled();
		expect(h.deps.database.writeReturning).not.toHaveBeenCalled();
	});
	it("accepts a trusted base-path prefix at the ingress gate without pretending the existing signature covers it", async () => {
		const f = await create();
		const h = decisionHarness(f);
		const input = decisionOptions(f);
		Object.assign(input, { externalPathname: "/trusted/base/v1/traversal/signal" });
		h.deps.budgets.reserveIngress.mockResolvedValue("denied");

		const result = await decideTraversalSignal(input, h.deps);

		expect(result).toBeNull();
		expect(h.deps.budgets.reserveIngress).toHaveBeenCalledTimes(1);
		expect(h.deps.database.query).not.toHaveBeenCalled();
	});
});
