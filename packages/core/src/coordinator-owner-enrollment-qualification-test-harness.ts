import { expect, it } from "vitest";
import type { SchemaFixture } from "./coordinator-auth-browser-migration-test-harness.js";
import type { CoordinatorOwnerEnrollmentQualificationRow } from "./coordinator-owner-enrollment-qualification-schema.js";

export const QUALIFICATION_TABLE = "coordinator_owner_enrollment_qualifications";
export const qualificationDefinitions = `SELECT type,name,sql FROM sqlite_master WHERE tbl_name = '${QUALIFICATION_TABLE}' AND sql IS NOT NULL ORDER BY type,name`;
// Synthetic row data only: these strings are not reviewed evidence or authority.
export const qualification = {
	qualification_id: "qualification-a",
	coordinator_id: "coordinator-a",
	link_id: "link-a",
	device_claim_id: "claim-a",
	identity_id: "identity-a",
	source_group_id: "group-a",
	device_id: "device-a",
	public_key: "dummy-public-key",
	fingerprint: "a".repeat(64),
	key_id: "b".repeat(64),
	controller_attestation_id: "controller-a",
	controller_attestation_revision: 1,
	controller_attestation_created_at: "2026-01-01T00:00:00.000Z",
	review_receipt_id: "review-a",
	evidence_digest: "c".repeat(64),
	enrollment_identity_id: "enrollment-a",
	link_attempt_id: "attempt-a",
	link_auth_config_revision: "d".repeat(64),
	link_created_at_ms: 100,
	created_at_ms: 200,
	revoked_at_ms: null,
} satisfies CoordinatorOwnerEnrollmentQualificationRow;
type Value = string | number | null;
const birth = Object.entries(qualification).filter(([column]) => column !== "revoked_at_ms");
const MAX = Number.MAX_SAFE_INTEGER;
export function insertQualification(
	f: SchemaFixture,
	row: Record<string, Value> = qualification,
	{ mode = "INSERT", suffix = "" }: { mode?: string; suffix?: string } = {},
) {
	const entries = Object.entries(row);
	return f.exec(
		`${mode} INTO ${QUALIFICATION_TABLE} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")}) ${suffix}`,
		...entries.map(([, value]) => value),
	);
}
export function qualificationRows(f: SchemaFixture) {
	return f.query(`SELECT * FROM ${QUALIFICATION_TABLE} ORDER BY qualification_id`);
}
async function seedQualification(
	f: SchemaFixture,
	row: CoordinatorOwnerEnrollmentQualificationRow,
) {
	await insertQualification(f, { ...row, revoked_at_ms: null });
	if (row.revoked_at_ms !== null)
		await f.exec(
			`UPDATE ${QUALIFICATION_TABLE} SET revoked_at_ms = ? WHERE qualification_id = ?`,
			row.revoked_at_ms,
			row.qualification_id,
		);
}
export function qualificationHarness(
	fixture: (use: (f: SchemaFixture) => Promise<void>) => Promise<void>,
) {
	return it.extend<{ fixture: SchemaFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}
type Test = ReturnType<typeof qualificationHarness>;
async function unchangedAfterFailure(f: SchemaFixture, action: () => Promise<void>) {
	const before = await qualificationRows(f);
	await expect(action()).rejects.toThrow();
	expect(await qualificationRows(f)).toEqual(before);
}
export function registerQualificationSchemaTests(test: Test) {
	registerBirth(test);
	registerCollisions(test);
	registerValidation(test);
	registerRevocation(test);
	registerRetention(test);
	registerWithoutRowid(test);
	test.for([null, 300])(
		"denies DELETE for revocation %s",
		async (revoked_at_ms, { fixture: f }) => {
			// Arrange
			await seedQualification(f, { ...qualification, revoked_at_ms });
			const before = await qualificationRows(f);
			// Act: an exact update remains legal, but deleting history does not.
			await f.exec(`UPDATE ${QUALIFICATION_TABLE} SET revoked_at_ms = ?`, revoked_at_ms);
			// Assert
			expect(await qualificationRows(f)).toEqual(before);
			await unchangedAfterFailure(f, () => f.exec(`DELETE FROM ${QUALIFICATION_TABLE}`));
		},
	);
	test("allows dangling provenance without FKs or raw subject/email fields", async ({
		fixture: f,
	}) => {
		// Arrange: no parent rows exist for this synthetic evidence.
		const columns = await f.query(`PRAGMA table_info(${QUALIFICATION_TABLE})`);
		// Act
		await insertQualification(f);
		// Assert: the complete row is data, not an authority lookup or parent requirement.
		expect((await qualificationRows(f))[0]).toMatchObject(qualification);
		expect(columns.map((c) => c.name)).toEqual(Object.keys(qualification));
		expect(columns.some((c) => /subject|email/i.test(String(c.name)))).toBe(false);
		expect(await f.query(`PRAGMA foreign_key_list(${QUALIFICATION_TABLE})`)).toEqual([]);
	});
}
function registerRetention(test: Test) {
	test("retains qualification when old device and controller rows are deleted", async ({
		fixture: f,
	}) => {
		// Arrange: SQLite's isolated fixture needs only these legacy table shapes; D1 has the official tables.
		await f.exec(
			"CREATE TABLE IF NOT EXISTS enrolled_devices (group_id TEXT,device_id TEXT,public_key TEXT,fingerprint TEXT,created_at TEXT)",
		);
		await f.exec(
			"CREATE TABLE IF NOT EXISTS coordinator_auth_controller_attestations (attestation_id TEXT,coordinator_id TEXT,identity_id TEXT,group_id TEXT,device_id TEXT,public_key TEXT,fingerprint TEXT,review_receipt_id TEXT,evidence_digest TEXT,enrollment_identity_id TEXT,revision INTEGER,created_at TEXT)",
		);
		const q = qualification;
		await f.exec(
			"INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,created_at) VALUES (?,?,?,?,?)",
			q.source_group_id,
			q.device_id,
			q.public_key,
			q.fingerprint,
			q.controller_attestation_created_at,
		);
		await f.exec(
			"INSERT INTO coordinator_auth_controller_attestations (attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,review_receipt_id,evidence_digest,enrollment_identity_id,revision,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
			q.controller_attestation_id,
			q.coordinator_id,
			q.identity_id,
			q.source_group_id,
			q.device_id,
			q.public_key,
			q.fingerprint,
			q.review_receipt_id,
			q.evidence_digest,
			q.enrollment_identity_id,
			1,
			q.controller_attestation_created_at,
		);
		await seedQualification(f, { ...q, revoked_at_ms: 300 });
		const before = await qualificationRows(f);
		// Act
		await f.exec("DELETE FROM enrolled_devices WHERE device_id = ?", q.device_id);
		await f.exec(
			"DELETE FROM coordinator_auth_controller_attestations WHERE attestation_id = ?",
			q.controller_attestation_id,
		);
		// Assert
		expect(await f.query("SELECT * FROM enrolled_devices")).toEqual([]);
		expect(await f.query("SELECT * FROM coordinator_auth_controller_attestations")).toEqual([]);
		expect(await qualificationRows(f)).toEqual(before);
		await unchangedAfterFailure(f, () => f.exec(`DELETE FROM ${QUALIFICATION_TABLE}`));
	});
}
function registerBirth(test: Test) {
	test.for(birth)(
		"pins birth fact %j against value, NULL and BLOB updates",
		async ([column, value], { fixture: f }) => {
			// Arrange
			await insertQualification(f);
			const before = await qualificationRows(f);
			// Act: same-value UPDATE is the only permitted birth-field retry.
			await f.exec(`UPDATE ${QUALIFICATION_TABLE} SET ${column} = ?`, value);
			// Assert
			expect(await qualificationRows(f)).toEqual(before);
			for (const replacement of [changedBirthValue(column, value), null])
				await unchangedAfterFailure(f, () =>
					f.exec(`UPDATE ${QUALIFICATION_TABLE} SET ${column} = ?`, replacement),
				);
			await unchangedAfterFailure(f, () =>
				f.exec(`UPDATE ${QUALIFICATION_TABLE} SET ${column} = CAST(? AS BLOB)`, value),
			);
		},
	);
	test("pins nullable enrollment identity at NULL as well as a recorded identity", async ({
		fixture: f,
	}) => {
		// Arrange
		await insertQualification(f, { ...qualification, enrollment_identity_id: null });
		const before = await qualificationRows(f);
		// Act
		await f.exec(`UPDATE ${QUALIFICATION_TABLE} SET enrollment_identity_id = NULL`);
		// Assert
		expect(await qualificationRows(f)).toEqual(before);
		await unchangedAfterFailure(f, () =>
			f.exec(`UPDATE ${QUALIFICATION_TABLE} SET enrollment_identity_id = 'later-identity'`),
		);
		await unchangedAfterFailure(f, () =>
			f.exec(`UPDATE ${QUALIFICATION_TABLE} SET enrollment_identity_id = X''`),
		);
	});
	test("prevents UPDATE OR REPLACE from erasing another qualification or link", async ({
		fixture: f,
	}) => {
		// Arrange
		await insertQualification(f, qualification);
		await insertQualification(f, {
			...qualification,
			qualification_id: "second",
			link_id: "second",
		});
		const before = await qualificationRows(f);
		// Act
		await f.exec(`UPDATE ${QUALIFICATION_TABLE} SET qualification_id = qualification_id`);
		// Assert
		expect(await qualificationRows(f)).toEqual(before);
		for (const assignment of ["qualification_id = 'second'", "link_id = 'second'"])
			await unchangedAfterFailure(f, () =>
				f.exec(
					`UPDATE OR REPLACE ${QUALIFICATION_TABLE} SET ${assignment} WHERE qualification_id = ?`,
					qualification.qualification_id,
				),
			);
	});
}
function changedBirthValue(column: string, value: Value): Value {
	if (["fingerprint", "key_id", "evidence_digest", "link_auth_config_revision"].includes(column))
		return "e".repeat(64);
	if (typeof value === "number") return value + 1;
	return `${value}-changed`;
}
function registerWithoutRowid(test: Test) {
	test.for(["rowid", "_rowid_", "oid"])(
		"has no %s alias and permits distinct appends after rejected access",
		async (alias, { fixture: f }) => {
			// Arrange: no hidden row identifier can participate in collision probes.
			await f.exec("PRAGMA recursive_triggers = OFF");
			expect(await qualificationRows(f)).toEqual([]);
			// Act / Assert: SELECT, INSERT and UPDATE cannot address an absent rowid alias.
			await expect(f.query(`SELECT ${alias} FROM ${QUALIFICATION_TABLE}`)).rejects.toThrow();
			for (const value of [-2, -1, 0, 10])
				await unchangedAfterFailure(f, () =>
					insertQualification(f, { ...qualification, [alias]: value }),
				);
			await seedQualification(f, { ...qualification, revoked_at_ms: 300 });
			const tombstone = (await qualificationRows(f))[0];
			const second = { ...qualification, qualification_id: "second", link_id: "second" };
			await expect(f.query(`SELECT ${alias} FROM ${QUALIFICATION_TABLE}`)).rejects.toThrow();
			for (const value of [-2, -1, 0, 10]) {
				await unchangedAfterFailure(f, () => insertQualification(f, { ...second, [alias]: value }));
				await unchangedAfterFailure(f, () =>
					f.exec(`UPDATE ${QUALIFICATION_TABLE} SET ${alias} = ?`, value),
				);
			}
			// Ordinary appends still work after failed rowid access on empty and populated storage.
			await insertQualification(f, second);
			const rows = await qualificationRows(f);
			expect(rows).toHaveLength(2);
			expect(rows[0]).toEqual(tombstone);
			expect(rows[1]).toMatchObject(second);
			expect(rows.every((row) => !(alias in row))).toBe(true);
			expect(
				(await f.query(`SELECT sql FROM sqlite_master WHERE name = '${QUALIFICATION_TABLE}'`))[0]
					?.sql,
			).toMatch(/WITHOUT ROWID/i);
		},
	);
}
const collisions: { name: string; patch: Record<string, Value> }[] = [
	{ name: "exact retry", patch: {} },
	{
		name: "global qualification PK across coordinators",
		patch: { coordinator_id: "other", link_id: "other" },
	},
	{ name: "coordinator/link with new qualification ID", patch: { qualification_id: "new" } },
	{
		name: "mixed collisions against two old rows",
		patch: { qualification_id: "second" },
	},
];
function registerCollisions(test: Test) {
	for (const revoked_at_ms of [null, 300]) {
		for (const mode of ["INSERT OR REPLACE", "UPSERT", "UPSERT NOTHING"]) {
			test.for(collisions)(
				`${mode} cannot replace $name (revoked=${revoked_at_ms})`,
				async ({ patch }, { fixture: f }) => {
					// Arrange: protection must not depend on recursive DELETE triggers.
					await f.exec("PRAGMA recursive_triggers = OFF");
					await seedQualification(f, { ...qualification, revoked_at_ms });
					await seedQualification(f, {
						...qualification,
						qualification_id: "second",
						link_id: "second",
						revoked_at_ms,
					});
					const options = { mode: "INSERT OR REPLACE", suffix: "" };
					if (mode.startsWith("UPSERT")) {
						options.mode = "INSERT";
						options.suffix = "ON CONFLICT DO UPDATE SET revoked_at_ms = excluded.revoked_at_ms";
						if (mode === "UPSERT NOTHING") options.suffix = "ON CONFLICT DO NOTHING";
					}
					// Act / Assert
					expect(await f.query("PRAGMA recursive_triggers")).toEqual([{ recursive_triggers: 0 }]);
					await unchangedAfterFailure(f, () =>
						insertQualification(f, { ...qualification, ...patch }, options),
					);
				},
			);
		}
	}
	test("allows unrelated rows and the same link in a different coordinator", async ({
		fixture: f,
	}) => {
		// Arrange
		await insertQualification(f);
		// Act
		await insertQualification(
			f,
			{ ...qualification, qualification_id: "second", link_id: "second" },
			{ mode: "INSERT OR REPLACE" },
		);
		await insertQualification(
			f,
			{ ...qualification, qualification_id: "third", coordinator_id: "other" },
			{ suffix: "ON CONFLICT DO UPDATE SET revoked_at_ms = excluded.revoked_at_ms" },
		);
		// Assert
		expect(await qualificationRows(f)).toHaveLength(3);
		await unchangedAfterFailure(f, () =>
			insertQualification(f, { ...qualification, qualification_id: "fourth" }),
		);
	});
}
function invalidValues(column: string): Value[] {
	if (column === "revoked_at_ms") return [199, -1, 200.5, MAX + 1, "invalid"];
	if (column === "created_at_ms") return [null, 99, -1, 200.5, MAX + 1, "invalid"];
	if (column === "link_created_at_ms") return [null, -1, 100.5, 201, MAX + 1, "invalid"];
	if (column === "controller_attestation_revision") return [null, 0, 2, 1.5, "invalid"];
	if (["fingerprint", "key_id", "evidence_digest", "link_auth_config_revision"].includes(column))
		return [
			null,
			"",
			"a".repeat(63),
			"a".repeat(65),
			"A".repeat(64),
			"g".repeat(64),
			`${"a".repeat(63)}\0`,
		];
	if (column === "public_key") return [null, "", " \t\n\r", "x".repeat(4097), "key\0suffix"];
	if (column === "controller_attestation_created_at") return [null, "", " \t\n\r", "time\0suffix"];
	const values: Value[] = ["", " \t\n\r", " leading", "trailing ", "x".repeat(257), "id\0suffix"];
	if (column !== "enrollment_identity_id") values.push(null);
	return values;
}
function registerValidation(test: Test) {
	test.for(Object.keys(qualification))(
		"validates %s on INSERT including BLOB storage",
		async (column, { fixture: f }) => {
			// Arrange / Act: a valid row is accepted with every stored fact preserved.
			await insertQualification(f);
			// Assert: each malformed value is checked on a fresh, noncolliding candidate.
			expect((await qualificationRows(f))[0]).toMatchObject(qualification);
			const fresh = { ...qualification, qualification_id: "invalid", link_id: "invalid" };
			for (const value of invalidValues(column))
				await unchangedAfterFailure(f, () => insertQualification(f, { ...fresh, [column]: value }));
			const columns = Object.keys(fresh);
			await unchangedAfterFailure(f, () =>
				f.exec(
					`INSERT INTO ${QUALIFICATION_TABLE} (${columns.join(",")}) VALUES (${columns.map((c) => (c === column ? "CAST(COALESCE(?, 'blob') AS BLOB)" : "?")).join(",")})`,
					...Object.values(fresh),
				),
			);
		},
	);
	test.for([0, MAX])(
		"accepts exact safe integer boundary %s for all timestamps",
		async (time, { fixture: f }) => {
			// Arrange
			const row = {
				...qualification,
				link_created_at_ms: time,
				created_at_ms: time,
				revoked_at_ms: time,
			};
			// Act
			await seedQualification(f, row);
			// Assert
			expect((await qualificationRows(f))[0]).toMatchObject(row);
			await unchangedAfterFailure(f, () =>
				insertQualification(f, {
					...row,
					qualification_id: "invalid",
					link_id: "invalid",
					created_at_ms: MAX + 1,
				}),
			);
		},
	);
}
function registerRevocation(test: Test) {
	test.for([200, 300, MAX])(
		"rejects revocation %s at birth without appending a row",
		async (revoked_at_ms, { fixture: f }) => {
			// Arrange: a non-NULL timestamp is invalid even when its value otherwise passes time checks.
			expect(await qualificationRows(f)).toEqual([]);
			// Act / Assert: rejection leaves empty storage empty and existing history untouched.
			await unchangedAfterFailure(f, () =>
				insertQualification(f, { ...qualification, revoked_at_ms }),
			);
			await insertQualification(f);
			const second = { ...qualification, qualification_id: "second", link_id: "second" };
			await unchangedAfterFailure(f, () => insertQualification(f, { ...second, revoked_at_ms }));
			await insertQualification(f, second);
			expect(await qualificationRows(f)).toEqual([qualification, second]);
		},
	);
	test.for([200, 300, MAX])(
		"revokes once at %s and permits only exact retry",
		async (time, { fixture: f }) => {
			// Arrange
			await insertQualification(f);
			// Act
			await f.exec(`UPDATE ${QUALIFICATION_TABLE} SET revoked_at_ms = ?`, time);
			await f.exec(`UPDATE ${QUALIFICATION_TABLE} SET revoked_at_ms = ?`, time);
			// Assert: every birth fact remains intact; later revocation dates are not rewrites either.
			expect((await qualificationRows(f))[0]).toMatchObject({
				...qualification,
				revoked_at_ms: time,
			});
			for (const value of [null, time - 1, time + 1, 199, 200.5, MAX + 1, "invalid"])
				await unchangedAfterFailure(f, () =>
					f.exec(`UPDATE ${QUALIFICATION_TABLE} SET revoked_at_ms = ?`, value),
				);
			await unchangedAfterFailure(f, () =>
				f.exec(`UPDATE ${QUALIFICATION_TABLE} SET revoked_at_ms = CAST(? AS BLOB)`, time),
			);
		},
	);
	test("retains NULL revocation on retry and rejects malformed initial revocation", async ({
		fixture: f,
	}) => {
		// Arrange
		await insertQualification(f);
		const before = await qualificationRows(f);
		// Act
		await f.exec(`UPDATE ${QUALIFICATION_TABLE} SET revoked_at_ms = NULL`);
		// Assert
		expect(await qualificationRows(f)).toEqual(before);
		for (const value of invalidValues("revoked_at_ms"))
			await unchangedAfterFailure(f, () =>
				f.exec(`UPDATE ${QUALIFICATION_TABLE} SET revoked_at_ms = ?`, value),
			);
	});
}
