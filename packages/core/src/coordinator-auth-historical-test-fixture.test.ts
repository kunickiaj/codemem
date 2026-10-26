import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { AUTH_ONLY_PREDECESSOR_MIGRATION_NAMES } from "./coordinator-auth-historical-migration-test-fixture.js";
import {
	historicalCallerMigrationNames,
	setupHistoricalStore,
} from "./coordinator-auth-historical-store-test-fixture.js";
import {
	type HistoricalAccountDefect,
	prepareHistoricalAccountDatabase,
} from "./coordinator-auth-historical-test-fixture.js";
import {
	AUTH_LIFECYCLE_CURRENT_READINESS_SQL,
	AUTH_LIFECYCLE_CURRENT_READY_COUNT,
} from "./coordinator-auth-lifecycle-current-readiness.js";
import { AUTH_SCHEMA_V2_READINESS_SQL } from "./coordinator-auth-lifecycle-predecessor.js";
import { upgradeAuthLifecycleSchema } from "./coordinator-auth-lifecycle-upgrade-sqlite.js";
import { columns, rawAuthSnapshot } from "./coordinator-auth-lifecycle-upgrade-test-fixture.js";
import { authDeviceClaimProvenanceSql } from "./coordinator-auth-link-provenance.js";
import { sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
function memory() {
	const db = new Database(":memory:");
	databases.push(db);
	return db;
}
function accountAuthState(db: Database.Database) {
	const definitions = db
		.prepare(
			"SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE instr(tbl_name,'coordinator_auth_') = 1 ORDER BY type,name",
		)
		.all() as { type: string; name: string; sql: string | null }[];
	const inventory = definitions
		.filter(({ type }) => type === "table")
		.map(({ name, sql }) => ({
			table: name,
			columns: columns(db, name),
			rowid: !/\bWITHOUT ROWID\b/iu.test(sql ?? ""),
		}));
	return { definitions, data: rawAuthSnapshot(db, inventory) };
}
const credentialHash = "7".repeat(64);
const profile = { displayName: "Historical Ω", email: "fixture@example.test", emailVerified: true };
const session = { credentialHash, profile };
const availableMigrations = readdirSync(
	new URL("../../cloudflare-coordinator-worker/migrations/", import.meta.url),
).filter((name) => name.endsWith(".sql"));

it("classifies every repository migration without replaying auth or excluded owner storage as caller tables", () => {
	// Arrange
	const excludedOwner = [
		"0030_add_owner_enrollment_attempts.sql",
		"0031_add_owner_enrollment_audit_log.sql",
		"0034_add_owner_admission_pin.sql",
		"0035_add_owner_enrollment_qualifications.sql",
		"0036_add_owner_attempt_qualification_pin.sql",
		"0037_add_legacy_owner_resolutions.sql",
		"0038_add_device_rebind.sql",
	];
	// Act
	const caller = historicalCallerMigrationNames(availableMigrations);
	// Assert
	expect(Object.isFrozen(caller)).toBe(true);
	expect(new Set([...caller, ...AUTH_ONLY_PREDECESSOR_MIGRATION_NAMES, ...excludedOwner])).toEqual(
		new Set(availableMigrations),
	);
	for (const name of [...AUTH_ONLY_PREDECESSOR_MIGRATION_NAMES, ...excludedOwner])
		expect(caller).not.toContain(name);
});

it.each([
	{ reason: "future auth", names: [...availableMigrations, "0034_add_auth_lifecycle.sql"] },
	{ reason: "future caller", names: [...availableMigrations, "9999_new_caller.sql"] },
	{
		reason: "missing known",
		names: availableMigrations.filter((name) => name !== "0001_init.sql"),
	},
	{ reason: "duplicate known", names: [...availableMigrations, "0001_init.sql"] },
])("requires deliberate migration classification review for $reason inputs", ({ names }) => {
	// Arrange
	const before = [...names];
	// Act: classification is pure and cannot mutate a historical database.
	const classify = () => historicalCallerMigrationNames(names);
	// Assert
	expect(classify).toThrow(/historical_auth_fixture_migration_inventory_requires_review/);
	expect(names).toEqual(before);
});

describe("explicit historical account bundles", () => {
	it.each(["controller_attestation", "device_claim"] as const)(
		"retains coherent %s session/profile evidence for current V2 readers",
		async (authority) => {
			// Arrange: reader-only synthetic history, not Google or enrollment authorization.
			const db = memory();
			const p = prepareHistoricalAccountDatabase(db, { authority, session });
			const store = new D1CoordinatorStore(sqliteD1(db), { authClock: () => p.bornAtMs + 20 });
			const before = rawAuthSnapshot(db);
			// Act
			const result = await store.readAuthSessionAccount(credentialHash, p.config);
			// Assert
			expect(result).toMatchObject({
				session: {
					sessionId: p.session?.sessionId,
					identityId: p.identityId,
					linkId: p.linkId,
					account: p.account,
				},
				profile,
			});
			expect(rawAuthSnapshot(db)).toEqual(before);
			expect(await store.readAuthSession("8".repeat(64), p.config)).toBeNull();
			expect(db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).get()).toEqual({ ready: 10 });
			expect(p.keyId).toBe(await ed25519KeyIdForRevocation(p.publicKey));
			expect(p.fingerprint).toBe(createHash("sha256").update(p.publicKey).digest("hex"));
			expect(
				db
					.prepare(
						"SELECT source_session_id,source_signed_in_at_ms FROM coordinator_auth_account_profiles",
					)
					.get(),
			).toEqual({
				source_session_id: p.session?.sessionId,
				source_signed_in_at_ms: p.session?.createdAtMs,
			});
		},
	);
	it("seeds a historical SQLite file before opening the current store", async () => {
		// Arrange
		const directory = mkdtempSync(join(tmpdir(), "historical-account-test-"));
		directories.push(directory);
		const path = join(directory, "fixture.sqlite");
		const seed = new Database(path);
		let p: ReturnType<typeof prepareHistoricalAccountDatabase>;
		let before: ReturnType<typeof accountAuthState>;
		try {
			p = prepareHistoricalAccountDatabase(seed, { authority: "device_claim", session });
			expect(seed.prepare(AUTH_SCHEMA_V2_READINESS_SQL).get()).toEqual({ ready: 10 });
			before = accountAuthState(seed);
		} finally {
			seed.close();
		}
		// Act: constructor observes existing V2 history; it did not create that history.
		const store = new BetterSqliteCoordinatorStore(path, { authClock: () => p.bornAtMs + 20 });
		databases.push(store.db);
		const result = await store.readAuthSessionAccount(credentialHash, p.config);
		// Assert
		expect(store.db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).get()).toEqual({ ready: 10 });
		expect(accountAuthState(store.db)).toEqual(before);
		expect(result?.profile).toEqual(profile);
		expect(result?.session.account).toEqual(p.account);
		expect(
			store.db.prepare("SELECT count(*) AS n FROM coordinator_auth_device_claims").get(),
		).toEqual({ n: 1 });
	});
	it("keeps current sign-in revision separate from immutable birth revision", async () => {
		// Arrange
		const db = memory();
		const p = prepareHistoricalAccountDatabase(db, {
			authority: "device_claim",
			session: { ...session, revision: "b".repeat(64) },
		});
		const store = new D1CoordinatorStore(sqliteD1(db), { authClock: () => p.bornAtMs + 20 });
		// Act
		const current = await store.readAuthSession(credentialHash, {
			...p.config,
			revision: "b".repeat(64),
		});
		const old = await store.readAuthSession(credentialHash, p.config);
		// Assert
		expect(current?.linkId).toBe(p.linkId);
		expect(old).toBeNull();
		expect(
			db.prepare("SELECT auth_config_revision FROM coordinator_auth_account_links").get(),
		).toEqual({ auth_config_revision: p.config.revision });
	});
	it("does not invent retained sessions or profile data when neither is requested", async () => {
		// Arrange
		const db = memory();
		const p = prepareHistoricalAccountDatabase(db, { authority: "controller_attestation" });
		const store = new D1CoordinatorStore(sqliteD1(db));
		// Act
		const missing = await store.readAuthSession(credentialHash, p.config);
		// Assert
		expect(p.session).toBeUndefined();
		expect(missing).toBeNull();
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE name = 'coordinator_owner_enrollment_attempts'",
				)
				.all(),
		).toEqual([]);
		for (const table of [
			"coordinator_auth_sessions",
			"coordinator_auth_session_receipts",
			"coordinator_auth_account_profiles",
		])
			expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
	});
});

it.each(["SQLite", "D1"] as const)(
	"opens %s historical readers with caller tables and explicit issuer/time pins",
	async (backend) => {
		// Arrange: these overrides serve the account-page/status readers' Google config and clock.
		const now = 1_791_028_800_000;
		const f = setupHistoricalStore(backend, {
			history: {
				authority: "controller_attestation",
				issuer: "https://accounts.google.com",
				bornAtMs: now - 10,
				session,
			},
			authClock: () => now,
		});
		try {
			const before = rawAuthSnapshot(f.db);
			// Act
			await f.store.createGroup("caller-group");
			const result = await f.store.readAuthSessionAccount(credentialHash, f.history.config);
			const wrongIssuer = await f.store.readAuthSession(credentialHash, {
				...f.history.config,
				issuer: "https://accounts.example.test",
			});
			// Assert
			expect(result?.session.account.issuer).toBe("https://accounts.google.com");
			expect(result?.profile).toEqual(profile);
			expect(f.history.session?.createdAtMs).toBe(now);
			expect(wrongIssuer).toBeNull();
			expect(f.db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).get()).toEqual({ ready: 10 });
			expect(rawAuthSnapshot(f.db)).toEqual(before);
		} finally {
			f.close();
		}
	},
);

describe("deliberately inconsistent historical facts", () => {
	it.each([
		"missing_link",
		"missing_creation_audit",
		"link_identity",
		"link_subject",
		"link_issuer",
		"link_attempt",
		"link_revision",
	] as const)(
		"denies device-claim historical defect %s without modifying evidence",
		async (defect) => {
			// Arrange
			const db = memory();
			const p = prepareHistoricalAccountDatabase(db, {
				authority: "device_claim",
				defect,
				session,
			});
			const store = new D1CoordinatorStore(sqliteD1(db), { authClock: () => p.bornAtMs + 20 });
			const before = rawAuthSnapshot(db);
			// Act
			const account = await store.readAuthSessionAccount(credentialHash, p.config);
			// Assert
			expect(account).toBeNull();
			expect(rawAuthSnapshot(db)).toEqual(before);
		},
	);
	it("seeds the requested inconsistent controller link and attempt pins", () => {
		// Arrange: owner-enrollment tests will consume the mismatched historical controller pin.
		const db = memory();
		// Act
		const p = prepareHistoricalAccountDatabase(db, {
			authority: "controller_attestation",
			defect: "link_controller",
		});
		// Assert
		expect(
			db.prepare("SELECT controller_attestation_id FROM coordinator_auth_account_links").get(),
		).toEqual({ controller_attestation_id: "other-controller" });
		expect(
			db.prepare("SELECT controller_attestation_id FROM coordinator_auth_link_attempts").get(),
		).toEqual({ controller_attestation_id: p.controllerAttestationId });
	});
});

it.each(["controller_attestation", "device_claim"] as const)(
	"explicitly upgrades healthy %s evidence before sealing immutable guards",
	(authority) => {
		// Arrange
		const db = memory();
		const p = prepareHistoricalAccountDatabase(db, { authority, session });
		const before = rawAuthSnapshot(db);
		// Act: no current V2 store reader runs against this V3 database.
		upgradeAuthLifecycleSchema(db);
		// Assert
		expect(rawAuthSnapshot(db, before)).toEqual(before);
		expect(db.prepare(AUTH_LIFECYCLE_CURRENT_READINESS_SQL).get()).toEqual({
			ready: AUTH_LIFECYCLE_CURRENT_READY_COUNT,
		});
		expect(
			db
				.prepare("SELECT identity_id,first_link_id FROM coordinator_auth_account_associations")
				.get(),
		).toEqual({ identity_id: p.identityId, first_link_id: p.linkId });
		expect(
			db
				.prepare("SELECT generation,signin_sequence_floor FROM coordinator_auth_account_links")
				.get(),
		).toEqual({ generation: 1, signin_sequence_floor: 0 });
		if (authority === "device_claim")
			expect(
				db
					.prepare(
						`SELECT ${authDeviceClaimProvenanceSql({ link: "l" })} AS valid FROM coordinator_auth_account_links l`,
					)
					.get(),
			).toEqual({ valid: 1 });
		expect(() =>
			db.exec("UPDATE coordinator_auth_account_links SET subject = 'rewritten'"),
		).toThrow(/auth_account_link_immutable/);
		expect(() => db.exec("DELETE FROM coordinator_auth_link_audit_log")).toThrow(
			/auth_link_audit_immutable/,
		);
	},
);

it.each([
	"CREATE TABLE retained(value)",
	"CREATE TEMP TABLE shadow(value)",
	"ATTACH DATABASE ':memory:' AS attached",
	"BEGIN",
	"PRAGMA ignore_check_constraints = ON",
])("refuses a nonfresh or unsafe fixture connection: %s", (setup) => {
	// Arrange
	const db = memory();
	db.exec(setup);
	const before = db.prepare("SELECT * FROM main.sqlite_master").all();
	// Act
	const build = () => prepareHistoricalAccountDatabase(db, { authority: "device_claim" });
	// Assert
	expect(build).toThrow(/historical_auth_fixture_requires_fresh_database/);
	expect(db.prepare("SELECT * FROM main.sqlite_master").all()).toEqual(before);
	if (db.inTransaction) db.exec("ROLLBACK");
});

it.each(["invalid credential", "mixed claim controller"])(
	"rejects invalid bundle input atomically: %s",
	(fault) => {
		// Arrange
		const db = memory();
		const defect: HistoricalAccountDefect | undefined =
			fault === "mixed claim controller" ? "link_controller" : undefined;
		// Act
		const build = () =>
			prepareHistoricalAccountDatabase(db, {
				authority: "device_claim",
				defect,
				session: { credentialHash: fault === "invalid credential" ? "invalid" : credentialHash },
			});
		// Assert
		expect(build).toThrow(
			fault === "invalid credential" ? /CHECK/ : /historical_auth_fixture_invalid_defect/,
		);
		expect(db.prepare("SELECT * FROM main.sqlite_master").all()).toEqual([]);
	},
);
