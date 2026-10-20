import { expect, it } from "vitest";
import {
	normalizeDefinitions,
	type SchemaFixture,
} from "./coordinator-auth-browser-migration-test-harness.js";
import { COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL } from "./coordinator-owner-enrollment-schema.js";
import {
	finalizedOwner,
	insertOwner,
	OWNER_TABLE,
	ownerDefinitions,
	ownerRows,
	pendingOwner,
} from "./coordinator-owner-enrollment-test-harness.js";

export const ATTEMPT_MIGRATION = "0036_add_owner_attempt_qualification_pin.sql";
export type AttemptMigrationFixture = SchemaFixture & {
	// Implementations MUST enclose the whole list in one transaction / D1 batch.
	apply: (queries: string[]) => Promise<void>;
	queries: string[];
};
export function attemptMigrationHarness(
	fixture: (use: (f: AttemptMigrationFixture) => Promise<void>) => Promise<void>,
) {
	return it.extend<{ fixture: AttemptMigrationFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}
type Test = ReturnType<typeof attemptMigrationHarness>;
export function normalizeOwnerDefinitions(rows: Record<string, unknown>[]) {
	// ALTER TABLE RENAME quotes only the table declaration; retain all constraint/trigger text.
	return normalizeDefinitions(rows).map((row) => ({
		...row,
		sql: row.sql.replace(
			'CREATE TABLE "coordinator_owner_enrollment_attempts"',
			`CREATE TABLE ${OWNER_TABLE}`,
		),
	}));
}
const qualified = {
	...finalizedOwner,
	state: "oidc_verified",
	loopback_redirect: pendingOwner.loopback_redirect,
	confirmation_hash: null,
	completion_secret_hash: null,
	final_key_proof_hash: null,
	finalized_at_ms: null,
	binding_id: null,
	audit_event_id: null,
	final_outcome_json: null,
	link_controller_attestation_id: null,
	owner_qualification_id: "qualification-Ω",
};
const claimed = {
	...pendingOwner,
	state: "browser_claimed",
	browser_transaction_hash: finalizedOwner.browser_transaction_hash,
	browser_binder_hash: finalizedOwner.browser_binder_hash,
};
async function setOwner(f: SchemaFixture, values: Record<string, string | number | null>) {
	const entries = Object.entries(values);
	await f.exec(
		`UPDATE ${OWNER_TABLE} SET ${entries.map(([key]) => `${key} = ?`).join(",")}`,
		...entries.map(([, value]) => value),
	);
}

// Include storage class AND hex bytes: JSON decoding alone hides NULL/BLOB/text changes.
async function snapshot(f: SchemaFixture) {
	const columns = await f.query(
		`SELECT name FROM pragma_table_info('${OWNER_TABLE}') WHERE name <> 'owner_qualification_id' ORDER BY cid`,
	);
	const expressions = columns.flatMap(({ name }) => [
		`typeof(${name}) AS ${name}_type`,
		`hex(${name}) AS ${name}_bytes`,
	]);
	return {
		rows: await f.query(
			`SELECT rowid, ${expressions.join(",")} FROM ${OWNER_TABLE} ORDER BY rowid`,
		),
		guarded: await f.query(
			"SELECT rowid, typeof(value) AS type, hex(value) AS bytes FROM attempt_copy_guarded ORDER BY rowid",
		),
	};
}
async function seed(f: SchemaFixture) {
	const states = [
		"pending",
		"browser_claimed",
		"oidc_verified",
		"confirmed",
		"finalized",
		"expired",
		"failed",
		"retired",
	];
	for (const [index, state] of states.entries()) {
		const hash = (offset: number) => (index + offset).toString(16).padStart(64, "0");
		const row: Record<string, string | number | null> = {
			...pendingOwner,
			state,
			rowid: 101 + index * 17,
		};
		if (state === "browser_claimed") Object.assign(row, claimed);
		if (["oidc_verified", "confirmed", "finalized"].includes(state))
			Object.assign(row, finalizedOwner, { state });
		if (["oidc_verified", "confirmed"].includes(state))
			Object.assign(row, {
				loopback_redirect: pendingOwner.loopback_redirect,
				finalized_at_ms: null,
				binding_id: null,
				audit_event_id: null,
				final_outcome_json: null,
				final_key_proof_hash: null,
			});
		if (state === "oidc_verified")
			Object.assign(row, { confirmation_hash: null, completion_secret_hash: null });
		// Restore uniqueness after stage templates; preserve varied old nullable admission pins.
		Object.assign(row, {
			attempt_id: `attempt-${index}`,
			browser_start_hash: hash(1),
			admission_owner_hash: index % 2 ? hash(20) : null,
		});
		if (["browser_claimed", "oidc_verified", "confirmed", "finalized"].includes(state))
			Object.assign(row, { browser_transaction_hash: hash(40), browser_binder_hash: hash(60) });
		if (["confirmed", "finalized"].includes(state))
			Object.assign(row, { completion_secret_hash: hash(80), confirmation_hash: hash(100) });
		await insertOwner(f, row);
	}
	await f.exec("CREATE TABLE attempt_copy_guarded (value)");
	await f.exec(
		"INSERT INTO attempt_copy_guarded(rowid,value) VALUES (7,NULL),(19,x'00ff80'),(43,' Ω  exact ') ",
	);
	await f.exec(
		"CREATE TRIGGER attempt_copy_guard BEFORE DELETE ON attempt_copy_guarded BEGIN SELECT RAISE(ABORT,'retain_fixture'); END",
	);
}
async function schemaSnapshot(f: SchemaFixture) {
	return f.query(
		"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name",
	);
}

export function registerAttemptMigrationTests(test: Test) {
	test("populated rebuild preserves every old cell, storage class, rowid, hash and exact receipt; fresh DDL matches", async ({
		fixture: f,
	}) => {
		// Arrange: all eight states, sparse rowids, NULL pins, immutable receipt and guarded BLOBs.
		await seed(f);
		const before = await snapshot(f);
		const guards = await f.query(ownerDefinitions);
		// Act: no individual DDL call is assumed atomic.
		await f.apply(f.queries);
		// Assert
		expect(await snapshot(f)).toEqual(before);
		expect(await f.query(`SELECT owner_qualification_id FROM ${OWNER_TABLE}`)).toEqual(
			Array.from({ length: 8 }, () => ({ owner_qualification_id: null })),
		);
		const migrated = normalizeOwnerDefinitions(await f.query(ownerDefinitions));
		expect(
			(await f.query(ownerDefinitions)).filter(
				({ type, name }) =>
					type !== "table" && !String(name).startsWith("owner_enrollment_authority_"),
			),
		).toEqual(guards.filter(({ type }) => type !== "table"));
		await f.exec(`DROP TABLE ${OWNER_TABLE}`);
		// This source contains only CREATE statements; do not split trigger-body semicolons.
		const fresh = COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL.replace(/^--.*$/gm, "")
			.trim()
			.split(/\n(?=CREATE )/)
			.map((sql) => sql.trim());
		expect(fresh).toHaveLength(14);
		await f.apply(fresh);
		expect(normalizeOwnerDefinitions(await f.query(ownerDefinitions))).toEqual(migrated);
		expect(await ownerRows(f)).toEqual([]);
	});
	registerRollbackTests(test);
	registerIncompatibleTests(test);
	registerAuthorityTests(test);
	registerInvalidAuthorityTests(test);
	registerAuthorityCollisionTests(test);
	registerQualifiedReceiptTests(test);
	registerPreCopyGuardTests(test);
}

function registerPreCopyGuardTests(test: Test) {
	test.for(["canonical", "altered"] as const)(
		"%s predecessor guards are checked before reaching the data-copy boundary",
		async (kind, { fixture: f }) => {
			// Arrange: a same-named altered guard must not pass the closed predecessor preflight.
			await seed(f);
			if (kind === "altered") {
				await f.exec("DROP TRIGGER owner_enrollment_pins_update");
				await f.exec(
					`CREATE TRIGGER owner_enrollment_pins_update BEFORE UPDATE ON ${OWNER_TABLE} BEGIN SELECT 1; END`,
				);
			}
			const before = await snapshot(f);
			const schema = await schemaSnapshot(f);
			const queries = [...f.queries];
			const copy = queries.findIndex((sql) => /INSERT INTO owner_attempt_0036_rebuild/.test(sql));
			expect(copy).toBeGreaterThanOrEqual(0);
			// A sentinel error identifies whether preflight reached the first INSERT of old rows.
			queries.splice(copy, 0, "SELECT * FROM owner_attempt_copy_boundary_reached");
			// Act / Assert: canonical guards reach copy; altered guards must fail before it.
			const expected =
				kind === "canonical"
					? /no such table: owner_attempt_copy_boundary_reached/
					: /CHECK constraint failed/;
			await expect(f.apply(queries)).rejects.toThrow(expected);
			expect(await snapshot(f)).toEqual(before);
			expect(await schemaSnapshot(f)).toEqual(schema);
		},
	);
}

function registerRollbackTests(test: Test) {
	test.for(["during-copy", "after-copy", "after-drop", "after-check"] as const)(
		"one enclosing transaction rolls back injected %s failure without losing old rows or guards",
		async (stage, { fixture: f }) => {
			// Arrange
			await seed(f);
			const before = await snapshot(f);
			const schema = await schemaSnapshot(f);
			const queries = [...f.queries];
			const positions = {
				"during-copy": queries.findIndex((sql) =>
					/INSERT INTO owner_attempt_0036_rebuild/.test(sql),
				),
				"after-copy": queries.findIndex((sql) =>
					/INSERT INTO owner_attempt_0036_rebuild/.test(sql),
				),
				"after-drop": queries.findIndex((sql) =>
					/DROP TABLE coordinator_owner_enrollment_attempts/.test(sql),
				),
				"after-check": queries.findLastIndex((sql) =>
					/INSERT INTO owner_attempt_0036_preflight/.test(sql),
				),
			};
			expect(positions[stage]).toBeGreaterThanOrEqual(0);
			if (stage === "during-copy") {
				const columns = await f.query(
					`SELECT name FROM pragma_table_info('${OWNER_TABLE}') ORDER BY cid`,
				);
				const projection = columns
					.map(({ name }) =>
						name === "purpose"
							? "CASE WHEN state = 'retired' THEN 'invalid' ELSE purpose END"
							: name,
					)
					.join(",");
				const original = queries[positions[stage]];
				if (!original) throw new Error("Missing migration copy statement");
				queries[positions[stage]] = original.replace(
					"SELECT rowid, * FROM",
					`SELECT rowid, ${projection} FROM`,
				);
				expect(queries[positions[stage]]).not.toBe(original);
			} else {
				queries.splice(
					positions[stage] + 1,
					0,
					"INSERT INTO owner_attempt_0036_preflight VALUES (0)",
				);
			}
			// Act / Assert: the fault must be reached, not an earlier schema error.
			await expect(f.apply(queries)).rejects.toThrow(/CHECK constraint failed/);
			expect(await snapshot(f)).toEqual(before);
			expect(await schemaSnapshot(f)).toEqual(schema);
			await f.apply(f.queries);
			expect(await snapshot(f)).toEqual(before);
		},
	);
}

function registerIncompatibleTests(test: Test) {
	test.for([
		["extra-column", `ALTER TABLE ${OWNER_TABLE} ADD COLUMN unexpected TEXT`],
		["changed-table-check"],
		["missing-guard", "DROP TRIGGER owner_enrollment_pins_update"],
		[
			"altered-guard",
			"DROP TRIGGER owner_enrollment_pins_update",
			`CREATE TRIGGER owner_enrollment_pins_update BEFORE UPDATE ON ${OWNER_TABLE} BEGIN SELECT 1; END`,
		],
		[
			"foreign-key",
			`CREATE TABLE attempt_child (coordinator_id TEXT, attempt_id TEXT, FOREIGN KEY(coordinator_id,attempt_id) REFERENCES ${OWNER_TABLE}(coordinator_id,attempt_id) ON DELETE CASCADE)`,
			"INSERT INTO attempt_child VALUES ('coordinator-a','attempt-4')",
		],
		["external-view", `CREATE VIEW attempt_view AS SELECT * FROM ${OWNER_TABLE}`],
		[
			"external-trigger",
			`CREATE TRIGGER attempt_external AFTER INSERT ON attempt_copy_guarded BEGIN SELECT count(*) FROM ${OWNER_TABLE}; END`,
		],
		[
			"reserved-guard",
			"CREATE TRIGGER owner_enrollment_authority_update BEFORE UPDATE ON attempt_copy_guarded BEGIN SELECT 1; END",
		],
	])(
		"rejects incompatible %s without changing rows, foreign-key children or schema",
		async ([kind, ...changes], { fixture: f }) => {
			// Arrange
			if (kind === "changed-table-check") await alterPredecessorCheck(f);
			await seed(f);
			for (const sql of changes) await f.exec(sql);
			const before = await snapshot(f);
			const schema = await schemaSnapshot(f);
			const children = await f.query("SELECT name FROM sqlite_master WHERE name = 'attempt_child'");
			// Act / Assert
			await expect(f.apply(f.queries)).rejects.toThrow(/CHECK constraint failed/);
			expect(await snapshot(f)).toEqual(before);
			expect(await schemaSnapshot(f)).toEqual(schema);
			if (children.length)
				expect(await f.query("SELECT * FROM attempt_child")).toEqual([
					{ coordinator_id: "coordinator-a", attempt_id: "attempt-4" },
				]);
		},
	);
}

async function alterPredecessorCheck(f: AttemptMigrationFixture) {
	const definitions = await f.query(ownerDefinitions);
	const table = definitions.find(({ type }) => type === "table");
	if (!table) throw new Error("Missing predecessor table");
	const sql = String(table.sql);
	const altered = sql.replace(
		"CHECK (purpose = 'owner_enroll')",
		"CHECK (purpose IN ('owner_enroll','signin'))",
	);
	expect(altered).not.toBe(sql);
	await f.exec(`DROP TABLE ${OWNER_TABLE}`);
	await f.apply([
		altered,
		...definitions.filter(({ type }) => type !== "table").map(({ sql }) => String(sql)),
	]);
}

function registerAuthorityTests(test: Test) {
	test.for(["controller", "qualification"])(
		"accepts exactly the %s authority branch and permits initial resolve only",
		async (branch, { fixture: f }) => {
			// Arrange
			await f.apply(f.queries);
			await insertOwner(f, claimed);
			const resolved = {
				...qualified,
				owner_qualification_id:
					branch === "qualification" ? qualified.owner_qualification_id : null,
				link_controller_attestation_id:
					branch === "controller" ? finalizedOwner.link_controller_attestation_id : null,
			};
			// Act
			await setOwner(f, resolved);
			const before = await ownerRows(f);
			await setOwner(f, resolved);
			// Assert: exact retries work; neither switching authority nor clearing/refilling does.
			expect(await ownerRows(f)).toEqual(before);
			for (const patch of [
				{ owner_qualification_id: null, link_controller_attestation_id: null },
				{ owner_qualification_id: "other", link_controller_attestation_id: null },
				{ owner_qualification_id: null, link_controller_attestation_id: "other" },
			]) {
				await expect(setOwner(f, patch)).rejects.toThrow(/owner_enrollment_pins_immutable/);
				expect(await ownerRows(f)).toEqual(before);
			}
		},
	);
}

function registerInvalidAuthorityTests(test: Test) {
	test.for([
		{ ...qualified, link_controller_attestation_id: "controller-a" },
		{ ...qualified, owner_qualification_id: null },
		{ ...pendingOwner, owner_qualification_id: "qualification-a" },
		...["", " ", "\t\n\r", " padded", "padded ", "a\0b", "x".repeat(257)].map(
			(owner_qualification_id) => ({ ...qualified, owner_qualification_id }),
		),
	])(
		"rejects illegal XOR, unresolved or malformed qualification %j",
		async (row, { fixture: f }) => {
			// Arrange
			await f.apply(f.queries);
			// Act / Assert
			await expect(insertOwner(f, row)).rejects.toThrow(/CHECK constraint failed/);
			expect(await ownerRows(f)).toEqual([]);
			await insertOwner(f, qualified);
			expect(await ownerRows(f)).toEqual([expect.objectContaining(qualified)]);
		},
	);
}

function registerAuthorityCollisionTests(test: Test) {
	test.for([
		"attempt_id",
		"browser_start_hash",
		"browser_transaction_hash",
		"completion_secret_hash",
		"rowid",
	])(
		"replacement and upsert cannot change authority through %s collision",
		async (column, { fixture: f }) => {
			// Arrange
			await f.apply(f.queries);
			const row = {
				...qualified,
				state: "confirmed",
				rowid: 51,
				confirmation_hash: finalizedOwner.confirmation_hash,
				completion_secret_hash: finalizedOwner.completion_secret_hash,
			};
			await insertOwner(f, row);
			const before = await ownerRows(f);
			await insertOwner(f, row, { mode: "INSERT OR IGNORE" });
			expect(await ownerRows(f)).toEqual(before);
			const collision = {
				...row,
				attempt_id: "collision",
				browser_start_hash: "9".repeat(64),
				browser_transaction_hash: "7".repeat(64),
				completion_secret_hash: "6".repeat(64),
				rowid: 90,
				owner_qualification_id: "replacement",
				[column]: row[column as keyof typeof row],
			};
			// Act / Assert
			await expect(insertOwner(f, collision, { mode: "INSERT OR REPLACE" })).rejects.toThrow(
				/owner_enrollment_pins_immutable/,
			);
			expect(await ownerRows(f)).toEqual(before);
			const entries = Object.entries({ ...row, owner_qualification_id: "replacement" });
			await expect(
				f.exec(
					`INSERT INTO ${OWNER_TABLE} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")}) ON CONFLICT DO UPDATE SET owner_qualification_id = excluded.owner_qualification_id`,
					...entries.map(([, value]) => value),
				),
			).rejects.toThrow(/owner_enrollment_pins_immutable/);
			expect(await ownerRows(f)).toEqual(before);
		},
	);
}

function registerQualifiedReceiptTests(test: Test) {
	test("qualified confirmation and finalization retain admission, completion and immutable receipt checks", async ({
		fixture: f,
	}) => {
		// Arrange
		await f.apply(f.queries);
		const admission_owner_hash = "2".repeat(64);
		await insertOwner(f, { ...qualified, admission_owner_hash });
		const initial = await ownerRows(f);
		// Act / Assert: adding a completion secret early or changing admission remains forbidden.
		await expect(
			setOwner(f, { completion_secret_hash: finalizedOwner.completion_secret_hash }),
		).rejects.toThrow(/owner_enrollment_pins_immutable/);
		for (const value of [null, "3".repeat(64)])
			await expect(setOwner(f, { admission_owner_hash: value })).rejects.toThrow(
				/owner_enrollment_admission_immutable/,
			);
		expect(await ownerRows(f)).toEqual(initial);
		await setOwner(f, {
			state: "confirmed",
			confirmation_hash: finalizedOwner.confirmation_hash,
			completion_secret_hash: finalizedOwner.completion_secret_hash,
		});
		const confirmed = await ownerRows(f);
		for (const column of ["confirmation_hash", "completion_secret_hash"]) {
			for (const value of [null, "3".repeat(64)])
				await expect(setOwner(f, { [column]: value })).rejects.toThrow(
					/owner_enrollment_pins_immutable/,
				);
		}
		const receipt = {
			...finalizedOwner,
			admission_owner_hash,
			link_controller_attestation_id: null,
			owner_qualification_id: qualified.owner_qualification_id,
		};
		await expect(setOwner(f, { ...receipt, final_outcome_json: null })).rejects.toThrow(
			/CHECK constraint failed/,
		);
		expect(await ownerRows(f)).toEqual(confirmed);
		await setOwner(f, receipt);
		const final = await ownerRows(f);
		expect(final).toEqual([expect.objectContaining(receipt)]);
		for (const sql of [
			`UPDATE ${OWNER_TABLE} SET state = 'confirmed'`,
			`DELETE FROM ${OWNER_TABLE}`,
		])
			await expect(f.exec(sql)).rejects.toThrow(/owner_enrollment_receipt_immutable/);
		await expect(insertOwner(f, receipt, { mode: "INSERT OR REPLACE" })).rejects.toThrow(
			/owner_enrollment_receipt_immutable/,
		);
		expect(await ownerRows(f)).toEqual(final);
	});
}
