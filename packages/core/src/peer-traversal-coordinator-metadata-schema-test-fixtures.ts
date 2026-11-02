import { describe, expect, it } from "vitest";
import {
	type CreateFixture,
	HEALTH,
	POLICY,
	REALM,
	seed,
	type Value,
} from "./peer-traversal-coordinator-schema-common-test-fixtures.js";

export function registerMetadataScenarios(create: CreateFixture) {
	describe("metadata publication constraints", () => {
		registerPolicyPublication(create);
		registerStalePublication(create);
		registerCurrentChildren(create);
		registerInitialRootRevisions(create);
		registerAuthorityShapes(create);
		registerFixedMetadataKeys(create);
		registerRevisionMutations(create);
		registerMetadataShapes(create);
		registerMissingParents(create);
		registerPermanentMetadata(create);
	});
}

function registerPolicyPublication(create: CreateFixture) {
	it("starts disabled and permits an atomic fixed successor with child changes", async () => {
		const f = await create();
		await seed(f);
		const before = await f.db.all(
			"SELECT operator_state FROM traversal_authority_policy WHERE authority_id=?1",
			[f.authority],
		);

		await f.db.batch([
			{
				sql: "UPDATE traversal_authority_policy SET policy_revision=2,operator_state='enabled' WHERE authority_id=?1",
				values: [f.authority],
			},
			{
				sql: "UPDATE traversal_realms SET changed_revision=2,operator_state='enabled' WHERE authority_id=?1",
				values: [f.authority],
			},
		]);

		expect(before).toEqual([{ operator_state: "disabled" }]);
		expect(
			await f.db.all(
				"SELECT operator_state,changed_revision FROM traversal_realms WHERE authority_id=?1",
				[f.authority],
			),
		).toEqual([{ operator_state: "enabled", changed_revision: 2 }]);
	});
}

function registerStalePublication(create: CreateFixture) {
	it("aborts a stale fixed successor and its otherwise valid child batch", async () => {
		// No old-revision WHERE filter. Zero-row updates cannot prove child provenance.
		const f = await create();
		await seed(f);
		await f.db.run(
			"UPDATE traversal_authority_policy SET policy_revision=2 WHERE authority_id=?1",
			[f.authority],
		);

		const result = f.db.batch([
			{
				sql: "UPDATE traversal_authority_policy SET policy_revision=2 WHERE authority_id=?1",
				values: [f.authority],
			},
			{
				sql: "UPDATE traversal_realms SET changed_revision=2,operator_state='enabled' WHERE authority_id=?1",
				values: [f.authority],
			},
		]);

		await expect(result).rejects.toThrow();
		expect(
			await f.db.all(
				"SELECT operator_state,changed_revision FROM traversal_realms WHERE authority_id=?1",
				[f.authority],
			),
		).toEqual([{ operator_state: "disabled", changed_revision: 1 }]);
	});
}

function registerCurrentChildren(create: CreateFixture) {
	it("initializes new realm policy and health at current root revisions above one", async () => {
		const f = await create();
		await seed(f);
		await f.db.run(
			"UPDATE traversal_authority_policy SET policy_revision=2 WHERE authority_id=?1",
			[f.authority],
		);
		await f.db.run(
			"UPDATE traversal_readiness SET revision=2 WHERE authority_id=?1 AND scope='authority'",
			[f.authority],
		);

		await f.db.run(REALM, [f.authority, "é".repeat(64), 2]);
		await f.db.run(HEALTH, [f.authority, "realm", "é".repeat(64), 2, "ready", f.now]);
		await f.db.run(
			"UPDATE traversal_readiness SET revision=2,state='ready',observed_at_ms=?2 WHERE authority_id=?1 AND scope='realm' AND group_id='group'",
			[f.authority, f.now],
		);

		expect(
			await f.db.all(
				"SELECT revision FROM traversal_readiness WHERE authority_id=?1 AND scope='realm'",
				[f.authority],
			),
		).toEqual([{ revision: 2 }, { revision: 2 }]);
	});
}

function registerInitialRootRevisions(create: CreateFixture) {
	it.each([0, 2, 1.5, Number.MAX_SAFE_INTEGER + 1, null])(
		"rejects root initial revision %s",
		async (revision) => {
			const f = await create();

			const result = f.db.run(POLICY, [f.authority, revision]);

			await expect(result).rejects.toThrow();
		},
	);
}

function registerAuthorityShapes(create: CreateFixture) {
	it.each(["A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(63)}\0`])(
		"rejects malformed metadata authority %s",
		async (authority) => {
			const f = await create();

			const result = f.db.run(POLICY, [authority, 1]);

			await expect(result).rejects.toThrow();
		},
	);
}

function registerFixedMetadataKeys(create: CreateFixture) {
	it.each([
		"UPDATE traversal_realms SET group_id='other',changed_revision=2 WHERE authority_id=?1",
		"UPDATE traversal_realms SET authority_id=?2,changed_revision=2 WHERE authority_id=?1",
		"UPDATE traversal_readiness SET scope='realm',group_id='group',revision=2 WHERE authority_id=?1 AND scope='authority'",
		"UPDATE traversal_readiness SET group_id='other',revision=2 WHERE authority_id=?1 AND scope='realm'",
		"UPDATE traversal_readiness SET authority_id=?2,revision=2 WHERE authority_id=?1",
	])("keeps metadata keys fixed when revisions could advance: %s", async (sql) => {
		const f = await create();
		await seed(f);
		await f.db.run(
			"UPDATE traversal_authority_policy SET policy_revision=2 WHERE authority_id=?1",
			[f.authority],
		);
		await f.db.run(
			"UPDATE traversal_readiness SET revision=2 WHERE authority_id=?1 AND scope='authority'",
			[f.authority],
		);

		const result = f.db.run(
			sql,
			sql.includes("?2") ? [f.authority, "a".repeat(64)] : [f.authority],
		);

		await expect(result).rejects.toThrow();
	});
}

function registerRevisionMutations(create: CreateFixture) {
	it.each([
		"UPDATE traversal_authority_policy SET policy_revision=1 WHERE authority_id=?1",
		"UPDATE traversal_authority_policy SET policy_revision=3 WHERE authority_id=?1",
		"UPDATE traversal_authority_policy SET authority_id=replace(authority_id,'0','a'),policy_revision=2 WHERE authority_id=?1",
		"UPDATE traversal_realms SET changed_revision=2 WHERE authority_id=?1",
		"UPDATE traversal_realms SET changed_revision=1 WHERE authority_id=?1",
		"UPDATE traversal_readiness SET revision=3 WHERE authority_id=?1 AND scope='authority'",
		"UPDATE traversal_readiness SET revision=1 WHERE authority_id=?1 AND scope='authority'",
		"UPDATE traversal_readiness SET revision=2 WHERE authority_id=?1 AND scope='realm'",
		"UPDATE traversal_readiness SET revision=1 WHERE authority_id=?1 AND scope='realm'",
	])("rejects stale or skipped revision: %s", async (sql) => {
		const f = await create();
		await seed(f);

		const result = f.db.run(sql, [f.authority]);

		await expect(result).rejects.toThrow();
	});
}

function registerMetadataShapes(create: CreateFixture) {
	it.each([
		[REALM, ["group", 2]],
		[REALM, ["", 1]],
		[REALM, ["é".repeat(65), 1]],
		[REALM, ["a\0b", 1]],
		[HEALTH, ["authority", "", 2, "ready", 0]],
		[HEALTH, ["authority", "", 1, "ready", null]],
		[HEALTH, ["authority", "", 1, "ready", -1]],
		[HEALTH, ["authority", "", 1, "ready", 0.5]],
		[HEALTH, ["authority", "", 1, "ready", Number.MAX_SAFE_INTEGER + 1]],
		[HEALTH, ["authority", "bad", 1, "ready", 0]],
		[HEALTH, ["other", "", 1, "paused", null]],
		[HEALTH, ["realm", "missing", 1, "ready", 0]],
		[HEALTH, ["authority", "", 1, "enabled", 0]],
	] satisfies [string, Value[]][])("rejects invalid metadata shape %#", async (sql, values) => {
		const f = await create();
		await f.db.run(POLICY, [f.authority, 1]);

		const result = f.db.run(sql, [f.authority, ...values]);

		await expect(result).rejects.toThrow();
	});
}

function registerMissingParents(create: CreateFixture) {
	it.each([REALM, HEALTH])("rejects children or health without root metadata: %s", async (sql) => {
		const f = await create();
		const values =
			sql === REALM
				? [f.authority, "group", 1]
				: [f.authority, "realm", "group", 1, "ready", f.now];

		const result = f.db.run(sql, values);

		await expect(result).rejects.toThrow();
	});
}

function registerPermanentMetadata(create: CreateFixture) {
	it.each(["traversal_authority_policy", "traversal_realms", "traversal_readiness"] as const)(
		"keeps %s permanent and rejects all collision paths",
		async (table) => {
			// Table identifiers and column lists are a literal allowlist.
			const f = await create();
			await seed(f);
			const definitions = {
				traversal_authority_policy: {
					columns: "authority_id,policy_revision",
					values: [f.authority, 1],
				},
				traversal_realms: {
					columns: "authority_id,group_id,changed_revision",
					values: [f.authority, "group", 1],
				},
				traversal_readiness: {
					columns: "authority_id,scope,group_id,revision,state,observed_at_ms",
					values: [f.authority, "authority", "", 1, "paused", null],
				},
			};
			const { columns, values } = definitions[table];
			const base = `INTO ${table}(${columns}) VALUES (${values.map((_, i) => `?${i + 1}`).join(",")})`;

			// Rejection must occur even when SQLite would otherwise ignore the conflict.
			for (const sql of [
				`DELETE FROM ${table} WHERE authority_id=?1`,
				`INSERT OR REPLACE ${base}`,
				`INSERT OR IGNORE ${base}`,
				`INSERT ${base} ON CONFLICT DO NOTHING`,
				`INSERT ${base} ON CONFLICT DO UPDATE SET authority_id=excluded.authority_id`,
			]) {
				await expect(
					f.db.run(sql, sql.startsWith("DELETE") ? [f.authority] : values),
				).rejects.toThrow();
			}
		},
	);
}
