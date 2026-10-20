import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { AUTH_ONLY_PREDECESSOR_MIGRATION_NAMES } from "./coordinator-auth-historical-migration-test-fixture.js";
import {
	type HistoricalAccountOptions,
	type HistoricalAccountPins,
	prepareHistoricalAccountDatabase,
} from "./coordinator-auth-historical-test-fixture.js";
import {
	type Backend,
	type Fixture,
	type Store,
	sqliteD1,
} from "./coordinator-auth-store-test-fixtures.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

const callerMigrationNames = Object.freeze([
	"0001_init.sql",
	"0002_add_reciprocal_approvals.sql",
	"0003_harden_reciprocal_approval_pending_pairs.sql",
	"0004_add_group_archival.sql",
	"0005_add_scope_memberships.sql",
	"0006_add_scope_membership_audit_log.sql",
	"0007_add_invite_project_intent_reference.sql",
	"0008_add_project_invite_acceptance.sql",
	"0009_add_recipient_invite_kinds.sql",
	"0010_add_scope_membership_effect_receipts.sql",
	"0011_add_recipient_reviewed_intent.sql",
	"0012_add_enrolled_device_identity.sql",
	"0013_add_invite_assigned_identity.sql",
	"0014_add_legacy_team_completions.sql",
	"0014_add_request_nonces_created_at_index.sql",
	"0015_add_coordinator_invites_group_created_index.sql",
	"0026_add_identity_group_grants.sql",
	"0027_add_device_revocations.sql",
	"0028_add_device_ownership_bindings.sql",
]);
const excludedOwnerMigrationNames = [
	"0030_add_owner_enrollment_attempts.sql",
	"0031_add_owner_enrollment_audit_log.sql",
	"0034_add_owner_admission_pin.sql",
	"0035_add_owner_enrollment_qualifications.sql",
];

/** Closed fixture inputs only: unknown, missing or duplicate migrations require review. */
export function historicalCallerMigrationNames(available: readonly string[]): readonly string[] {
	const classified = [
		...AUTH_ONLY_PREDECESSOR_MIGRATION_NAMES,
		...callerMigrationNames,
		...excludedOwnerMigrationNames,
	];
	const known = new Set(classified);
	if (
		known.size !== classified.length ||
		new Set(available).size !== available.length ||
		available.some((name) => !known.has(name)) ||
		classified.some((name) => !available.includes(name))
	) {
		throw new Error("historical_auth_fixture_migration_inventory_requires_review");
	}
	return callerMigrationNames;
}

/** Historical reader fixtures only; never rebuild history through a constructor. */
export function setupHistoricalStore(
	backend: Backend,
	options: { history: HistoricalAccountOptions; authClock?: () => number },
): Fixture & { history: HistoricalAccountPins; close(): void } {
	const migrations = new URL("../../cloudflare-coordinator-worker/migrations/", import.meta.url);
	const callerMigrations = historicalCallerMigrationNames(
		readdirSync(migrations).filter((name) => name.endsWith(".sql")),
	);
	const directory =
		backend === "SQLite" ? mkdtempSync(join(tmpdir(), "historical-auth-store-")) : undefined;
	const path = directory ? join(directory, "fixture.sqlite") : ":memory:";
	let db = new Database(path);
	try {
		const history = prepareHistoricalAccountDatabase(db, options.history);
		// Caller tables are explicit; neither excluded owner storage nor future auth DDL is replayed.
		for (const name of callerMigrations) db.exec(readFileSync(new URL(name, migrations), "utf8"));
		// Atomic V3 activation: explicitly call upgradeAuthLifecycleSchema(db) here,
		// after seeding and before either current store opens. V2 intentionally stays V2 now.
		let store: Store;
		if (backend === "SQLite") {
			db.close();
			store = new BetterSqliteCoordinatorStore(path, options);
			db = store.db;
		} else store = new D1CoordinatorStore(sqliteD1(db), options);
		return {
			store,
			db,
			history,
			close: () => {
				if (db.open) db.close();
				if (directory) rmSync(directory, { recursive: true });
			},
		};
	} catch (error) {
		if (db.open) db.close();
		if (directory) rmSync(directory, { recursive: true });
		throw error;
	}
}
