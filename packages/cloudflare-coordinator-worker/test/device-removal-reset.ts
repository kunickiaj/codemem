import type { D1Migration } from "cloudflare:test";
import {
	ENROLLMENT_REMOVAL_TRIGGER_NAMES,
	ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS,
} from "../../core/src/coordinator-device-removal.js";

const REMOVAL_MIGRATION = "0048_add_device_removals.sql";

const dropEnrollmentTriggers = ENROLLMENT_REMOVAL_TRIGGER_NAMES.map(
	(name) => `DROP TRIGGER IF EXISTS ${name}`,
);

/**
 * Test-only. Tombstones are permanent, so a test that needs a database without
 * any drops the tombstone table and re-creates it from the migration. It also
 * clears the rows that depend on enrollments, and leaves the enrollment
 * triggers of migration 0049 installed.
 */
export async function resetDeviceRemovals(
	db: D1Database,
	migrations: D1Migration[],
): Promise<void> {
	const migration = migrations.find((entry) => entry.name === REMOVAL_MIGRATION);
	if (!migration) throw new Error("Missing device removal migration");
	const create = migration.queries.filter((sql) => /^\s*CREATE /iu.test(sql));
	await db.batch(
		[
			...dropEnrollmentTriggers,
			"DELETE FROM presence_records",
			"DELETE FROM coordinator_join_requests",
			"DELETE FROM coordinator_invites",
			"DELETE FROM enrolled_devices",
			"DROP TABLE IF EXISTS coordinator_device_removals",
			...create,
			...ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS,
		].map((sql) => db.prepare(sql)),
	);
}

/** Leaves the database as migration 0048 created it, before 0049, apart from its rows. */
export async function dropEnrollmentRemovalTriggers(db: D1Database): Promise<void> {
	await db.batch(dropEnrollmentTriggers.map((sql) => db.prepare(sql)));
}

/** What migration 0049 installs. */
export async function installEnrollmentRemovalTriggers(db: D1Database): Promise<void> {
	await db.batch(ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS.map((sql) => db.prepare(sql)));
}
