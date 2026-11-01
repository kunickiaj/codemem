import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	RELAY_ADMISSION_CLOCK_SQL,
	readRelayAdmissionNonceReceipt,
} from "../../core/src/relay-admission-clock.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "../../core/src/relay-admission-metadata-schema.js";
import {
	metadataSeed,
	type MetadataSeedOptions,
} from "../../core/src/relay-admission-metadata-test-fixtures.js";
import {
	PARTICIPANT_CREATED_AT,
	PARTICIPANT_DEVICE_INSERT,
	PARTICIPANT_GROUP_INSERT,
	PARTICIPANT_KEYS,
	PARTICIPANT_REVOCATION_INSERT,
	participantFixture,
	type ParticipantFixtureOptions,
} from "../../core/src/relay-admission-participant-nonce-test-fixtures.js";
import { buildRelayAdmissionNonceStatement } from "../../core/src/relay-admission-participant-nonce.js";
import { readRelayAdmissionReadinessStamp } from "../../core/src/relay-admission-readiness.js";

// Actual migrated, disposable local D1. No coordinator constructor or SQL shim.
const db = env.COORDINATOR_DB;
let sequence = 0;
let authorityId: string;
let groupId: string;
type Fixture = Awaited<ReturnType<typeof participantFixture>>;
const prepare = (f: Fixture) => db.prepare(f.statement.sql).bind(...f.statement.bindings);
const ledger = async () => (await db.prepare("SELECT * FROM request_nonces").all()).results;

async function seed(options: ParticipantFixtureOptions = {}, metadata: MetadataSeedOptions = {}) {
	// The same backend supplies the packet's seconds and health observation.
	// Boundary arithmetic is deterministic in Node tests with a controlled SQL clock.
	const clock = await db
		.prepare(`SELECT ${RELAY_ADMISSION_CLOCK_SQL} AS now`)
		.first<{ now: number }>();
	if (!clock) throw new Error("local SQL clock unavailable");
	const f = await participantFixture({
		authorityId,
		groupId,
		createdAt: Math.floor(clock.now / 1000),
		...options,
	});
	await db.batch([
		db.prepare(PARTICIPANT_GROUP_INSERT).bind(groupId, PARTICIPANT_CREATED_AT),
		...f.rows.map((row) =>
			db.prepare(PARTICIPANT_DEVICE_INSERT).bind(...Object.values(row), PARTICIPANT_CREATED_AT),
		),
		...metadataSeed({
			authority: authorityId,
			group: groupId,
			authorityObserved: clock.now,
			realmObserved: clock.now,
			...metadata,
		}).map(({ sql, values }) => db.prepare(sql).bind(...values)),
	]);
	return f;
}

describe("relay participant nonce compiler on native local D1", () => {
	beforeAll(async () => {
		// Opt-in fixtures only. Protected metadata rows are never removed or replaced.
		for (const sql of RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS) await db.prepare(sql).run();
	});
	beforeEach(async () => {
		authorityId = (++sequence).toString(16).padStart(64, "0");
		groupId = `participant-nonce-${sequence}`;
		await db.batch([
			db.prepare("DELETE FROM request_nonces"),
			db.prepare("DELETE FROM coordinator_device_revocations"),
			db.prepare("DELETE FROM enrolled_devices"),
			db.prepare("DELETE FROM groups"),
		]);
	});

	it.each(["registration", "source", "relay", "responder"] as const)(
		"returns only its own inserted %s receipt",
		async (role) => {
			// Arrange: a synthetic 64-byte signature satisfies format only.
			const f = await seed({ role, sourceDeviceId: "source'\\;--" });
			// Act
			const result = await prepare(f).all<Record<string, unknown>>();
			const receipt = readRelayAdmissionNonceReceipt(result.results[0], f.statement.association);
			const next = buildRelayAdmissionNonceStatement({ ...f.input, attemptId: "d".repeat(32) })!;
			const replay = await db
				.prepare(next.sql)
				.bind(...next.bindings)
				.first();
			// Assert: SQL insertion is not a budget-authorized grant.
			expect(result.results).toHaveLength(1);
			expect(receipt).not.toBeNull();
			expect(readRelayAdmissionReadinessStamp(result.results[0], receipt!)).toMatchObject({
				state: "ready",
				revision: 1,
			});
			expect(readRelayAdmissionNonceReceipt(result.results[0], next.association)).toBeNull();
			expect(replay).toBeNull();
			expect(await ledger()).toHaveLength(1);
		},
	);

	it("returns a first() receipt and gives simultaneous fresh attempts one insertion only", async () => {
		// Arrange
		const f = await seed();
		const other = buildRelayAdmissionNonceStatement({ ...f.input, attemptId: "d".repeat(32) })!;
		// Act
		const rows = await Promise.all([
			prepare(f).first(),
			db
				.prepare(other.sql)
				.bind(...other.bindings)
				.first(),
		]);
		// Assert
		expect(rows.filter((row) => row !== null)).toHaveLength(1);
		expect(await ledger()).toHaveLength(1);
		for (const [index, row] of rows.entries()) {
			if (row !== null)
				expect(
					readRelayAdmissionNonceReceipt(row, [f.statement, other][index].association),
				).not.toBeNull();
		}
	});

	it.each(
		["source", "target"].flatMap((deviceId) =>
			[
				["public_key", PARTICIPANT_KEYS[deviceId === "source" ? 1 : 0].publicKey],
				["fingerprint", "changed"],
				["identity_id", "linked-after-capture"],
				["enabled", 0],
				["group_id", "other"],
				["device_id", "replacement"],
			].map(([column, value]) => ({ deviceId, column, value })),
		),
	)(
		"denies changed $deviceId.$column using native JSON comparisons",
		async ({ deviceId, column, value }) => {
			// Arrange
			const f = await seed();
			// Act: column names are a static test allowlist.
			await db
				.prepare(`UPDATE enrolled_devices SET ${column}=?1 WHERE device_id=?2`)
				.bind(value, deviceId)
				.run();
			const row = await prepare(f).first();
			// Assert
			expect(row).toBeNull();
			expect(await ledger()).toEqual([]);
		},
	);

	it.each(
		["source", "target"].flatMap((deviceId) =>
			["device_id", "ed25519_key"].map((kind) => ({ deviceId, kind })),
		),
	)("denies global $kind revocation for $deviceId", async ({ deviceId, kind }) => {
		// Arrange
		const f = await seed();
		const value =
			kind === "device_id" ? deviceId : PARTICIPANT_KEYS[deviceId === "source" ? 0 : 1].keyId;
		// Act: the evidence group deliberately differs from the requested group.
		await db.prepare(PARTICIPANT_REVOCATION_INSERT).bind(kind, value).run();
		const row = await prepare(f).first();
		// Assert
		expect(row).toBeNull();
		expect(await ledger()).toEqual([]);
	});

	it.each([
		{ operatorState: "disabled" },
		{ realmState: "disabled" },
		{ audienceState: "revoked" },
		{ authorityObserved: 0 },
		{ omit: "realmHealth" },
	] satisfies MetadataSeedOptions[])("denies metadata %j at insertion", async (metadata) => {
		// Arrange
		const f = await seed({}, metadata);
		// Act
		const row = await prepare(f).first();
		// Assert
		expect(row).toBeNull();
		expect(await ledger()).toEqual([]);
	});

	it.each(["archive", "policy revision", "expired", "future"])(
		"denies %s before creating a nonce",
		async (change) => {
			// Arrange
			let createdAt: number | undefined;
			if (change === "expired") createdAt = 0;
			if (change === "future") createdAt = 9_999_999_900;
			const f = await seed(createdAt === undefined ? {} : { createdAt });
			// Act
			if (change === "archive")
				await db
					.prepare("UPDATE groups SET archived_at='archived' WHERE group_id=?1")
					.bind(groupId)
					.run();
			if (change === "policy revision")
				await db
					.prepare(
						"UPDATE relay_admission_authority_policy SET policy_revision=2 WHERE authority_id=?1",
					)
					.bind(authorityId)
					.run();
			const row = await prepare(f).first();
			// Assert
			expect(row).toBeNull();
			expect(await ledger()).toEqual([]);
		},
	);
});
