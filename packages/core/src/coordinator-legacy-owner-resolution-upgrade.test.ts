import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import {
	applyAccountConnectionSchema,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { readLegacyOwnerResolutionSchemaState } from "./coordinator-legacy-owner-resolution-metadata.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS } from "./coordinator-legacy-owner-resolution-schema.js";

const table = "coordinator_legacy_owner_resolutions";
let dir: string;
beforeEach(() => {
	mkdirSync(".tmp", { recursive: true });
	dir = mkdtempSync(join(".tmp", "owner-resolution-upgrade-"));
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

function backend(db: Database.Database): AuthLinkBackend {
	return {
		first: async <T>({ sql, values }: AuthLinkStatement) =>
			(db.prepare(sql).get(...values) as T | undefined) ?? null,
		run: async ({ sql, values }) => db.prepare(sql).run(...values).changes,
		batch: async (statements) =>
			db
				.transaction(() =>
					statements.map(({ sql, values }) => db.prepare(sql).run(...values).changes),
				)
				.immediate(),
	};
}

async function fixture(current = true): Promise<string> {
	const path = join(dir, "coordinator.sqlite");
	const store = new BetterSqliteCoordinatorStore(path);
	try {
		await store.createGroup("synthetic-group");
		await store.enrollDevice("synthetic-group", {
			deviceId: "synthetic-device",
			publicKey: "synthetic public key\r\nexact bytes",
			fingerprint: "a".repeat(64),
		});
		if (current) await applyAccountConnectionSchema(backend(store.db));
	} finally {
		await store.close();
	}
	chmodSync(path, 0o600);
	return path;
}

function inspect<T>(path: string, read: (db: Database.Database) => T): T {
	const db = new Database(path, { fileMustExist: true });
	try {
		return read(db);
	} finally {
		db.close();
	}
}

function snapshot(path: string) {
	return inspect(path, (db) => {
		const schema = db
			.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
			.all();
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		const rows = tables
			.filter(({ name }) => name !== table)
			.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]);
		return { schema, rows, mode: statSync(path).mode };
	});
}

async function loadUpgrade() {
	// Delayed import lets the real fixture control run before the new product module exists.
	const { upgradeCoordinatorOwnerResolutionSchemaFile } = await import(
		"./coordinator-legacy-owner-resolution-upgrade.js"
	);
	return upgradeCoordinatorOwnerResolutionSchemaFile;
}

it("fixture control: installs the real current account schema but no receipt sidecar", async () => {
	// Arrange
	const path = await fixture();
	// Act
	const db = new Database(path, { fileMustExist: true });
	let states: { account: string; receipts: string };
	try {
		states = {
			account: await readConnectionSchemaState(backend(db)),
			receipts: await readLegacyOwnerResolutionSchemaState(backend(db)),
		};
	} finally {
		db.close();
	}
	// Assert
	expect(states).toEqual({ account: "ready", receipts: "missing" });
	expect(
		snapshot(path).rows.some(
			([name, rows]) => name === "enrolled_devices" && Array.isArray(rows) && rows.length === 1,
		),
	).toBe(true);
});

it("installs exactly the reviewed empty inert schema and preserves all business rows and file mode", async () => {
	// Arrange
	const path = await fixture();
	const before = snapshot(path);
	// Act
	const upgrade = await loadUpgrade();
	await upgrade(path);
	// Assert
	const after = snapshot(path);
	expect(after.rows).toEqual(before.rows);
	expect(after.mode).toBe(before.mode);
	const db = new Database(path, { fileMustExist: true });
	try {
		expect(await readConnectionSchemaState(backend(db))).toBe("ready");
		expect(await readLegacyOwnerResolutionSchemaState(backend(db))).toBe("ready");
		expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
		expect(after.schema.length - before.schema.length).toBe(
			LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS.length,
		);
	} finally {
		db.close();
	}
});

it("treats an exact installed schema as a byte-preserving no-op on repeat", async () => {
	// Arrange
	const path = await fixture();
	const upgrade = await loadUpgrade();
	await upgrade(path);
	const before = snapshot(path);
	const bytes = readFileSync(path);
	// Act
	await upgrade(path);
	// Assert
	expect(snapshot(path)).toEqual(before);
	expect(readFileSync(path)).toEqual(bytes);
});

it.each([":memory:", "file:synthetic.sqlite", "missing", "directory", "symlink"])(
	"rejects %s rather than selecting or creating another database",
	async (kind) => {
		// Arrange
		const target = await fixture();
		const before = snapshot(target);
		let path = kind;
		if (kind === "missing") path = join(dir, "absent.sqlite");
		if (kind === "directory") path = dir;
		if (kind === "symlink") {
			path = join(dir, "linked.sqlite");
			symlinkSync("coordinator.sqlite", path);
		}
		// Act / Assert
		const upgrade = await loadUpgrade();
		await expect(upgrade(path)).rejects.toThrow();
		expect(snapshot(target)).toEqual(before);
		if (kind === "missing") expect(existsSync(path)).toBe(false);
	},
);

it.each(["blank", "v2", "damaged-current"])(
	"rejects %s account schema without initializing or repairing it",
	async (kind) => {
		// Arrange
		const path = kind === "blank" ? join(dir, "blank.sqlite") : await fixture(kind !== "v2");
		if (kind === "blank") new Database(path).close();
		if (kind === "damaged-current")
			inspect(path, (db) => db.exec("DROP TRIGGER account_change_birth"));
		const before = snapshot(path);
		// Act / Assert
		const upgrade = await loadUpgrade();
		await expect(upgrade(path)).rejects.toThrow(/schema|upgrade|account/i);
		expect(snapshot(path)).toEqual(before);
	},
);

it.each(["partial", "unknown-table", "extra-index", "extra-trigger", "trigger-name-collision"])(
	"rejects %s sidecar state without repairing or leaving new DDL",
	async (kind) => {
		// Arrange
		const path = await fixture();
		inspect(path, (db) => {
			if (kind === "unknown-table") {
				db.exec(`CREATE TABLE ${table} (unexpected TEXT)`);
				return;
			}
			if (kind === "trigger-name-collision") {
				db.exec(
					"CREATE TRIGGER legacy_owner_resolution_immutable_delete BEFORE DELETE ON enrolled_devices BEGIN SELECT 1; END",
				);
				return;
			}
			const statements =
				kind === "partial"
					? LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS.slice(0, 1)
					: LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS;
			for (const sql of statements) db.exec(sql);
			if (kind === "extra-index")
				db.exec(`CREATE INDEX unexpected_owner_index ON ${table}(owner_identity_id)`);
			if (kind === "extra-trigger")
				db.exec(
					`CREATE TRIGGER unexpected_owner_trigger AFTER INSERT ON ${table} BEGIN SELECT 1; END`,
				);
		});
		const before = snapshot(path);
		// Act / Assert
		const upgrade = await loadUpgrade();
		await expect(upgrade(path)).rejects.toThrow(/schema|unsupported|collision|upgrade/i);
		expect(snapshot(path)).toEqual(before);
	},
);

it("rolls back real SQLite DDL after a late execution failure and retains original data on reopen", async () => {
	// Arrange: execute real statements before injecting a late failure, never fake SQL success.
	const path = await fixture();
	const before = snapshot(path);
	const exec = Database.prototype.exec;
	const prepare = Database.prototype.prepare;
	let failedInsideTransaction = false;
	function failLate(db: Database.Database, sql: string) {
		if (!/CREATE TRIGGER IF NOT EXISTS legacy_owner_resolution_immutable_delete/u.test(sql)) return;
		failedInsideTransaction = db.inTransaction;
		throw new Error("synthetic late DDL failure");
	}
	vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql) {
		const result = exec.call(this, sql);
		failLate(this, sql);
		return result;
	});
	vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
		this: Database.Database,
		sql,
	) {
		const statement: Database.Statement<unknown[]> = prepare.call(this, sql);
		if (/CREATE TRIGGER IF NOT EXISTS legacy_owner_resolution_immutable_delete/u.test(sql)) {
			const run = statement.run.bind(statement);
			vi.spyOn(statement, "run").mockImplementation((...values: unknown[]) => {
				const result = run(...values);
				failLate(this, sql);
				return result;
			});
		}
		return statement;
	});
	// Act / Assert
	const upgrade = await loadUpgrade();
	await expect(upgrade(path)).rejects.toThrow("synthetic late DDL failure");
	vi.restoreAllMocks();
	expect(failedInsideTransaction).toBe(true);
	expect(snapshot(path)).toEqual(before);
});
