import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readRelayAdmissionNonceReceipt } from "../../core/src/relay-admission-clock.js";
import {
	RELAY_CLOCK_TEST_CLEAR_SQL,
	RELAY_CLOCK_TEST_ROWS_SQL,
	RELAY_CLOCK_TEST_SCHEMA_SQL,
} from "../../core/src/relay-admission-clock-test-fixtures.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "../../core/src/relay-admission-metadata-schema.js";
import {
	METADATA_ASSOCIATION,
	METADATA_INSERT_SQL,
	METADATA_POLICY_INSERT,
	METADATA_READINESS_INSERT,
	metadataBindings,
	metadataSeed,
	type MetadataSeedOptions,
} from "../../core/src/relay-admission-metadata-test-fixtures.js";
import { readRelayAdmissionReadinessStamp } from "../../core/src/relay-admission-readiness.js";

let sequence = 0;
let authority: string;
const db = env.COORDINATOR_DB;
async function seed(options: MetadataSeedOptions = {}) {
	const now = Date.now();
	await db.batch(
		metadataSeed({ authority, authorityObserved: now, realmObserved: now, ...options })
			.map(({ sql, values }) => db.prepare(sql).bind(...values)),
	);
}
const insert = (policyRevision = 1) => db.prepare(METADATA_INSERT_SQL)
	.bind(...metadataBindings({ authority, policyRevision }));

it("fails closed before private metadata is installed in local D1", async () => {
	// Arrange: run before the nested suite installs its private test schema.
	await db.prepare(RELAY_CLOCK_TEST_SCHEMA_SQL).run();
	// Act
	const attempt = () => db.prepare(METADATA_INSERT_SQL).bind(...metadataBindings()).first();
	// Assert
	await expect(attempt()).rejects.toThrow(/no such table/i);
	expect((await db.prepare(RELAY_CLOCK_TEST_ROWS_SQL).all()).results).toEqual([]);
});

describe("relay metadata on disposable local workerd D1", () => {
	beforeAll(async () => {
		for (const sql of RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS) await db.prepare(sql).run();
		await db.prepare(RELAY_CLOCK_TEST_SCHEMA_SQL).run();
	});
	beforeEach(async () => {
		// Protected rows cannot be deleted. Each case uses a new authority in the
		// disposable local binding and clears only the test nonce ledger.
		authority = (++sequence).toString(16).padStart(64, "0");
		await db.prepare(RELAY_CLOCK_TEST_CLEAR_SQL).run();
	});
	it("returns scalar metadata projections alongside the actual inserted clock receipt", async () => {
		// Arrange
		await seed();
		// Act
		const result = await insert().all<Record<string, unknown>>();
		const row = result.results[0];
		const receipt = readRelayAdmissionNonceReceipt(row, METADATA_ASSOCIATION);
		// Assert
		expect(result.results).toHaveLength(1);
		expect(row).toMatchObject({ policyRevision: 1, readinessRevision: 1 });
		expect(receipt).not.toBeNull();
		if (!receipt) throw new Error("missing inserted receipt");
		expect(readRelayAdmissionReadinessStamp(row, receipt)).toMatchObject({ revision: 1, state: "ready" });
		expect(readRelayAdmissionReadinessStamp(result, receipt)).toBeNull();
		expect(await insert().first()).toBeNull();
	});
	it.each([2, Number.MAX_SAFE_INTEGER])("rejects initial policy and authority readiness revision %i", async (revision) => {
		// Arrange: use otherwise valid enabled/ready rows so counter exhaustion is the cause.
		await db.prepare(METADATA_POLICY_INSERT).bind(authority, 1, "enabled").run();
		const health = db.prepare(METADATA_READINESS_INSERT)
			.bind(authority, "authority", "", revision, "ready", Date.now());
		const freshAuthority = "f" + authority.slice(1);
		// Act: policy needs a fresh key to avoid mistaking a collision for counter rejection.
		const freshPolicy = db.prepare(METADATA_POLICY_INSERT).bind(freshAuthority, revision, "enabled");
		const results = await Promise.allSettled([freshPolicy.run(), health.run()]);
		// Assert
		expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
		expect(await db.prepare("SELECT policy_revision FROM relay_admission_authority_policy WHERE authority_id=?1")
			.bind(freshAuthority).first()).toBeNull();
		expect(await db.prepare("SELECT revision FROM relay_admission_readiness WHERE authority_id=?1")
			.bind(authority).first()).toBeNull();
	});

	it.each([
		{ omit: "realmHealth" }, { operatorState: "disabled" },
		{ audienceState: "revoked" }, { healthState: "tripped" }, { authorityObserved: 0 },
	] satisfies MetadataSeedOptions[])("denies unavailable or disabled metadata %j", async (options) => {
		// Arrange
		await seed(options);
		// Act
		const row = await insert().first();
		// Assert
		expect(row).toBeNull();
		expect((await db.prepare(RELAY_CLOCK_TEST_ROWS_SQL).all()).results).toEqual([]);
	});

	it("denies a captured policy revision after an atomic operator publication", async () => {
		// Arrange
		await seed();
		// Act: a fixed captured successor makes a stale root update abort the batch.
		await db.batch([
			db.prepare("UPDATE relay_admission_authority_policy SET policy_revision=2 WHERE authority_id=?1")
				.bind(authority),
			db.prepare("UPDATE relay_admission_realms SET changed_revision=2 WHERE authority_id=?1")
				.bind(authority),
		]);
		const stale = await insert().first();
		const current = await insert(2).first();
		// Assert
		expect(stale).toBeNull();
		expect(current).toMatchObject({ policyRevision: 2 });
	});

	it("aborts a stale root batch before its otherwise-valid realm change commits", async () => {
		// Arrange: the realm still has revision 1 after an independent root publication.
		await seed({ realmState: "disabled" });
		await db.prepare("UPDATE relay_admission_authority_policy SET policy_revision=2 WHERE authority_id=?1")
			.bind(authority).run();
		// Act: revision 2 is the stale publisher's captured successor, not an increment.
		const publication = db.batch([
			db.prepare("UPDATE relay_admission_authority_policy SET policy_revision=2 WHERE authority_id=?1")
				.bind(authority),
			db.prepare("UPDATE relay_admission_realms SET operator_state='enabled',changed_revision=2 WHERE authority_id=?1")
				.bind(authority),
		]);
		// Assert
		await expect(publication).rejects.toThrow();
		expect(await db.prepare("SELECT policy_revision FROM relay_admission_authority_policy WHERE authority_id=?1")
			.bind(authority).first()).toEqual({ policy_revision: 2 });
		expect(await db.prepare("SELECT operator_state,changed_revision FROM relay_admission_realms WHERE authority_id=?1")
			.bind(authority).first()).toEqual({ operator_state: "disabled", changed_revision: 1 });
	});

	it("rejects replacement, ignored duplicates, deletes and invalid revision updates natively", async () => {
		// Arrange
		await seed();
		const statements = [
			"DELETE FROM relay_admission_authority_policy WHERE authority_id=?1",
			"INSERT OR REPLACE INTO relay_admission_authority_policy VALUES (?1,1,'enabled')",
			"INSERT INTO relay_admission_authority_policy VALUES (?1,1,'enabled') ON CONFLICT DO NOTHING",
			"UPDATE relay_admission_authority_policy SET policy_revision=3 WHERE authority_id=?1",
			"UPDATE relay_admission_readiness SET revision=revision WHERE authority_id=?1 AND scope='authority'",
		];
		// Act
		const attempts = statements.map((sql) => () => db.prepare(sql).bind(authority).run());
		// Assert
		for (const attempt of attempts) await expect(attempt()).rejects.toThrow();
		expect(await insert().first()).not.toBeNull();
	});

	it("publishes readiness in one batch without enabling an operator-disabled realm", async () => {
		// Arrange
		await seed({ realmState: "disabled" });
		// Act
		await db.batch([
			db.prepare("UPDATE relay_admission_readiness SET revision=2 WHERE authority_id=?1 AND scope='authority'")
				.bind(authority),
			db.prepare("UPDATE relay_admission_readiness SET revision=2 WHERE authority_id=?1 AND scope='realm'")
				.bind(authority),
		]);
		const row = await insert().first();
		// Assert
		expect(row).toBeNull();
		expect(await db.prepare("SELECT operator_state FROM relay_admission_realms WHERE authority_id=?1")
			.bind(authority).first()).toEqual({ operator_state: "disabled" });
	});
});
