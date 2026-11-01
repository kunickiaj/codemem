import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_ADMISSION_CLOCK_SQL } from "../../core/src/relay-admission-clock.js";
import { encodeRelayCheckPacket } from "../../core/src/relay-admission-codec.js";
import {
	decideRelayAdmission,
	type RelayAdmissionDecisionDependencies,
} from "../../core/src/relay-admission-decision.js";
import {
	decisionFixture,
	decisionSeed,
} from "../../core/src/relay-admission-decision-test-fixtures.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "../../core/src/relay-admission-metadata-schema.js";
import { PARTICIPANT_REVOCATION_INSERT } from "../../core/src/relay-admission-participant-nonce-test-fixtures.js";

// This file uses the existing migrated local D1 binding, never a remote database.
const db = env.COORDINATOR_DB;
let sequence = 0;
const ledger = async () => (await db.prepare("SELECT * FROM request_nonces").all()).results;

async function setup(role: "source" | "relay" | "responder" | "registration" = "source") {
	const clock = await db
		.prepare(`SELECT ${RELAY_ADMISSION_CLOCK_SQL} AS now`)
		.first<{ now: number }>();
	if (!clock) throw new Error("local SQL clock unavailable");
	const f = await decisionFixture({
		role,
		createdAt: Math.floor(clock.now / 1000),
		authorityId: (++sequence).toString(16).padStart(64, "0"),
		groupId: `decision-${sequence}`,
	});
	await db.batch(
		decisionSeed(f, clock.now).map(({ sql, values }) => db.prepare(sql).bind(...values)),
	);
	const deps = {
		database: {
			query: vi.fn(
				async (sql: string, bindings: readonly (string | number | null)[]) =>
					(
						await db
							.prepare(sql)
							.bind(...bindings)
							.all()
					).results,
			),
			insertReturning: vi.fn(async (sql: string, bindings: readonly (string | number | null)[]) =>
				db
					.prepare(sql)
					.bind(...bindings)
					.first(),
			),
		},
		budgets: {
			reserveIngress: vi.fn(async () => "reserved" as const),
			reserveVerifiedDevice: vi.fn(async () => "reserved" as const),
		},
	} satisfies RelayAdmissionDecisionDependencies;
	return { f, deps };
}

describe("private relay admission on native local D1", () => {
	beforeAll(async () => {
		for (const sql of RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS) await db.prepare(sql).run();
	});
	beforeEach(async () => {
		await db.batch([
			db.prepare("DELETE FROM request_nonces"),
			db.prepare("DELETE FROM coordinator_device_revocations"),
			db.prepare("DELETE FROM enrolled_devices"),
			db.prepare("DELETE FROM groups"),
		]);
	});

	it.each(["registration", "source", "relay", "responder"] as const)(
		"verifies a real source signature for %s",
		async (role) => {
			// Arrange
			const { f, deps } = await setup(role);
			// Act
			const result = await decideRelayAdmission(f.request, deps);
			const replay = await decideRelayAdmission(f.request, deps);
			// Assert: first() returns a singular row from the current gated insert.
			expect(result).toMatchObject({
				kind: role === "registration" ? "registration" : "admission",
				proof: { signer: { deviceId: "source", keyId: f.sourceKeyId } },
				receipt: { deviceId: "source", nonce: f.nonce },
				readiness: { state: "ready", revision: 1 },
			});
			if (role === "registration") expect(result).toMatchObject({ socketExpiresInMs: 900_000 });
			expect(replay).toBeNull();
			expect(await ledger()).toHaveLength(1);
		},
	);

	it("denies invalid crypto before reserving a verified-device budget", async () => {
		// Arrange
		const { f, deps } = await setup();
		f.request.packet = encodeRelayCheckPacket({
			bodyBytes: f.bodyBytes,
			timestamp: String(f.createdAt),
			nonce: f.nonce,
			signatureBytes: new Uint8Array(64),
		});
		// Act
		const result = await decideRelayAdmission(f.request, deps);
		// Assert
		expect(result).toBeNull();
		expect(deps.budgets.reserveVerifiedDevice).not.toHaveBeenCalled();
		expect(deps.database.insertReturning).not.toHaveBeenCalled();
		expect(await ledger()).toEqual([]);
	});

	it.each(["target", "policy", "readiness", "revocation"])(
		"rejects a %s race after proof verification",
		async (change) => {
			// Arrange
			const { f, deps } = await setup();
			deps.budgets.reserveVerifiedDevice.mockImplementation(async () => {
				if (change === "target")
					await db.prepare("UPDATE enrolled_devices SET enabled=0 WHERE device_id='target'").run();
				if (change === "policy")
					await db
						.prepare(
							"UPDATE relay_admission_authority_policy SET policy_revision=2 WHERE authority_id=?1",
						)
						.bind(f.request.namespace.authorityId)
						.run();
				if (change === "readiness")
					await db
						.prepare(
							"UPDATE relay_admission_readiness SET state='paused',revision=2 WHERE authority_id=?1 AND scope='authority'",
						)
						.bind(f.request.namespace.authorityId)
						.run();
				if (change === "revocation")
					await db.prepare(PARTICIPANT_REVOCATION_INSERT).bind("device_id", "source").run();
				return "reserved";
			});
			// Act
			const result = await decideRelayAdmission(f.request, deps);
			// Assert
			expect(result).toBeNull();
			expect(deps.budgets.reserveVerifiedDevice).toHaveBeenCalledOnce();
			expect(deps.database.insertReturning).toHaveBeenCalledOnce();
			expect(await ledger()).toEqual([]);
		},
	);

	it("gives concurrent attempts one decision and one nonce", async () => {
		// Arrange
		const { f, deps } = await setup();
		// Act
		const results = await Promise.all([
			decideRelayAdmission(f.request, deps),
			decideRelayAdmission(f.request, deps),
		]);
		// Assert
		expect(results.filter((result) => result !== null)).toHaveLength(1);
		expect(await ledger()).toHaveLength(1);
	});

	it("denies a replaced attempt receipt even after the native insert commits", async () => {
		// Arrange
		const { f, deps } = await setup();
		const insert = deps.database.insertReturning.getMockImplementation();
		if (!insert) throw new Error("missing insert fixture");
		deps.database.insertReturning.mockImplementation(async (...args) => {
			const row = await insert(...args);
			return { ...row, attemptId: "0".repeat(32) };
		});
		// Act
		const result = await decideRelayAdmission(f.request, deps);
		// Assert
		expect(result).toBeNull();
		expect(deps.database.insertReturning).toHaveBeenCalledOnce();
		expect(await ledger()).toHaveLength(1);
	});
});
