import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1DatabaseLike } from "../../core/src/d1-coordinator-store.js";
import {
	RELAY_CLOCK_TEST_CLEAR_SQL,
	RELAY_CLOCK_TEST_SCHEMA_SQL,
} from "../../core/src/relay-admission-clock-test-fixtures.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "../../core/src/relay-admission-metadata-schema.js";
import {
	METADATA_CONTEXT,
	METADATA_INSERT_SQL,
	metadataBindings,
	metadataSeed,
} from "../../core/src/relay-admission-metadata-test-fixtures.js";
import { d1RelayHealthPublisher } from "../../core/src/relay-health-storage.js";

const db = env.COORDINATOR_DB;
let sequence = 0;
let authorityId: string;
let observedAtMs: number;
async function seed(omit?: "realmHealth") {
	await db.batch(
		metadataSeed({
			authority: authorityId,
			authorityObserved: observedAtMs,
			realmObserved: observedAtMs,
			omit,
		}).map(({ sql, values }) => db.prepare(sql).bind(...values)),
	);
}
function rows() {
	return db
		.prepare(
			"SELECT scope,revision,state,observed_at_ms FROM relay_admission_readiness WHERE authority_id=? ORDER BY scope",
		)
		.bind(authorityId)
		.all();
}
function nonce(nonceValue: string) {
	const values = metadataBindings({ authority: authorityId });
	values[1] = nonceValue;
	return db
		.prepare(METADATA_INSERT_SQL)
		.bind(...values)
		.first();
}
describe("health publications on native local D1", () => {
	beforeAll(async () => {
		for (const sql of RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS) await db.prepare(sql).run();
		await db.prepare(RELAY_CLOCK_TEST_SCHEMA_SQL).run();
	});
	beforeEach(async () => {
		authorityId = `e${(++sequence).toString(16).padStart(63, "0")}`;
		observedAtMs = Date.now();
		await db.prepare(RELAY_CLOCK_TEST_CLEAR_SQL).run();
	});
	it("returns native batch receipts and changes the actual nonce condition from ready to tripped", async () => {
		// Arrange
		await seed();
		const publish = d1RelayHealthPublisher(db, { authorityId, groupId: METADATA_CONTEXT.group });
		// Act
		const readyRevision = await publish({ state: "ready", observedAtMs });
		const readyRows = await rows();
		const allowed = await nonce("1".repeat(32));
		const trippedRevision = await publish({ state: "tripped", observedAtMs: null });
		const denied = await nonce("2".repeat(32));
		// Assert
		expect(readyRevision).toBe(2);
		expect(readyRows.results).toEqual(
			["authority", "realm"].map((scope) => ({
				scope,
				revision: 2,
				state: "ready",
				observed_at_ms: observedAtMs,
			})),
		);
		expect(allowed).toMatchObject({ readinessRevision: 2, readinessObservedAtMs: observedAtMs });
		expect(trippedRevision).toBe(3);
		expect(denied).toBeNull();
		expect((await rows()).results).toEqual(
			["authority", "realm"].map((scope) => ({
				scope,
				revision: 3,
				state: "tripped",
				observed_at_ms: null,
			})),
		);
	});
	it("does not update the authority or admit a nonce when its realm row is missing", async () => {
		// Arrange
		await seed("realmHealth");
		const publish = d1RelayHealthPublisher(db, { authorityId, groupId: METADATA_CONTEXT.group });
		// Act
		const revision = await publish({ state: "ready", observedAtMs });
		const denied = await nonce("3".repeat(32));
		// Assert
		expect(revision).toBeNull();
		expect(denied).toBeNull();
		expect((await rows()).results).toEqual([
			{ scope: "authority", revision: 1, state: "ready", observed_at_ms: observedAtMs },
		]);
	});
	it("rolls back a native stale-revision batch after another publisher commits", async () => {
		// Arrange: only interleave real native batches. Do not replace their receipts.
		await seed();
		const namespace = { authorityId, groupId: METADATA_CONTEXT.group };
		const competingPublish = d1RelayHealthPublisher(db, namespace);
		let competingRevision: number | null = null;
		const interleaved: D1DatabaseLike = {
			prepare: (sql) => db.prepare(sql),
			batch: async (statements) => {
				competingRevision = await competingPublish({ state: "ready", observedAtMs });
				return db.batch(statements as D1PreparedStatement[]);
			},
		};
		// Act
		const revision = await d1RelayHealthPublisher(
			interleaved,
			namespace,
		)({ state: "tripped", observedAtMs: null });
		// Assert
		expect(competingRevision).toBe(2);
		expect(revision).toBeNull();
		expect((await rows()).results).toEqual(
			["authority", "realm"].map((scope) => ({
				scope,
				revision: 2,
				state: "ready",
				observed_at_ms: observedAtMs,
			})),
		);
	});
});
