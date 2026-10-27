import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { COORDINATOR_DEVICE_REBIND_SCHEMA_SQL } from "./coordinator-device-rebind-schema.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

/** The first release's table, which forbade target = current. */
const FIRST_RELEASE_SQL = COORDINATOR_DEVICE_REBIND_SCHEMA_SQL.replace(
	" PRIMARY KEY (coordinator_id, attempt_id),\n",
	" PRIMARY KEY (coordinator_id, attempt_id),\n CHECK (target_identity_id IS NULL OR target_identity_id <> current_identity_id),\n",
);

/** The first pre-release table: it forbade a review digest before OIDC. */
const PRE_RELEASE_SQL = FIRST_RELEASE_SQL.replace(
	" CHECK (review_digest IS NOT NULL),",
	"",
).replace(
	"  AND team_effects_json IS NULL AND enrollment_count IS NULL)),",
	"  AND review_digest IS NULL AND team_effects_json IS NULL AND enrollment_count IS NULL)),",
);

function pendingInsert(db: Database.Database, attemptId: string) {
	db.prepare(
		`INSERT INTO coordinator_device_rebind_attempts (coordinator_id, attempt_id, origin, device_id, public_key,
		 key_id, fingerprint, current_identity_id, issuer, auth_config_revision, browser_start_hash, review_digest,
		 state, created_at_ms, expires_at_ms)
		 VALUES ('c', ?, 'o', 'd', 'k', ?, 'f', 'local:d', 'i', 'r', ?, ?, 'pending', 1, 600001)`,
	).run(attemptId, "a".repeat(64), `start-${attemptId}`, "e".repeat(64));
}

function openWithPreReleaseTable(withRow: boolean) {
	const directory = mkdtempSync(join(tmpdir(), "rebind-upgrade-"));
	directories.push(directory);
	const path = join(directory, "coordinator.sqlite");
	const old = new Database(path);
	old.exec(PRE_RELEASE_SQL);
	if (withRow)
		old.exec(`INSERT INTO coordinator_device_rebind_attempts (coordinator_id, attempt_id, origin,
	 device_id, public_key, key_id, fingerprint, current_identity_id, issuer, auth_config_revision,
	 browser_start_hash, state, created_at_ms, expires_at_ms)
	 VALUES ('c', 'old', 'o', 'd', 'k', '${"a".repeat(64)}', 'f', 'local:d', 'i', 'r', 's', 'pending', 1, 600001)`);
	old.close();
	return new BetterSqliteCoordinatorStore(path);
}

describe("pre-release rebind attempts table upgrade", () => {
	it("recreates an empty pre-release table so starts can pin the review digest", async () => {
		// Arrange / Act
		const store = openWithPreReleaseTable(false);
		// Assert
		expect(() => pendingInsert(store.db, "new")).not.toThrow();
		await store.close();
	});

	it("leaves a pre-release table with rows untouched", async () => {
		// Arrange / Act
		const store = openWithPreReleaseTable(true);
		// Assert: the old row survives and the old constraint still applies (fail closed).
		expect(
			store.db.prepare("SELECT attempt_id FROM coordinator_device_rebind_attempts").pluck().all(),
		).toEqual(["old"]);
		expect(() => pendingInsert(store.db, "new")).toThrow();
		await store.close();
	});
});

describe("rebind attempts table upgrade for self-binds", () => {
	it("keeps existing attempts and then accepts a self-bind", async () => {
		// Arrange
		const directory = mkdtempSync(join(tmpdir(), "rebind-self-bind-"));
		directories.push(directory);
		const path = join(directory, "coordinator.sqlite");
		const old = new Database(path);
		old.exec(FIRST_RELEASE_SQL);
		expect(() =>
			old.exec(`INSERT INTO coordinator_device_rebind_attempts (coordinator_id, attempt_id, origin, device_id,
			 public_key, key_id, fingerprint, current_identity_id, issuer, auth_config_revision, browser_start_hash,
			 review_digest, state, created_at_ms, expires_at_ms, account_subject, target_identity_id)
			 VALUES ('c', 'x', 'o', 'd', 'k', '${"a".repeat(64)}', 'f', 'local:d', 'i', 'r', 's', '${"e".repeat(64)}',
			 'oidc_verified', 1, 600001, 'sub', 'local:d')`),
		).toThrow();
		pendingInsert(old, "kept");
		old.close();
		// Act
		const store = new BetterSqliteCoordinatorStore(path);
		// Assert: the row survived, and target = current is allowed now.
		const db = store.db;
		expect(
			db.prepare("SELECT attempt_id FROM coordinator_device_rebind_attempts").pluck().all(),
		).toEqual(["kept"]);
		db.exec(`UPDATE coordinator_device_rebind_attempts SET state = 'browser_claimed',
		 browser_transaction_hash = 't', browser_binder_hash = 'b' WHERE attempt_id = 'kept'`);
		expect(() =>
			db.exec(`UPDATE coordinator_device_rebind_attempts SET state = 'oidc_verified',
			 account_subject = 'sub', target_identity_id = current_identity_id WHERE attempt_id = 'kept'`),
		).not.toThrow();
		expect(
			db
				.prepare("SELECT sql FROM sqlite_master WHERE name = 'coordinator_device_rebind_attempts'")
				.pluck()
				.get(),
		).not.toContain("target_identity_id <> current_identity_id");
		expect(
			db
				.prepare(
					"SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'coordinator_device_rebind_attempts'",
				)
				.pluck()
				.get(),
		).toBe(4);
		await store.close();
	});
});
