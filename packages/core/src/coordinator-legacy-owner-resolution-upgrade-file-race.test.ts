import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import {
	applyAccountConnectionSchema,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { readLegacyOwnerResolutionSchemaState } from "./coordinator-legacy-owner-resolution-metadata.js";
import { upgradeCoordinatorOwnerResolutionSchemaFile } from "./coordinator-legacy-owner-resolution-upgrade.js";

// Instrument only the synthetic filesystem boundary; SQLite always opens real files.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

const nativeProbe = vi.hoisted(() => ({
	afterOpen: null as null | ((db: import("better-sqlite3").Database, path: string) => void),
}));
vi.mock("better-sqlite3", async (importOriginal) => {
	const actual = await importOriginal<{ default: typeof Database }>();
	return {
		...actual,
		default: new Proxy(actual.default, {
			construct(target, args) {
				const db = Reflect.construct(target, args) as Database.Database;
				nativeProbe.afterOpen?.(db, args[0]);
				return db;
			},
		}),
	};
});

const table = "coordinator_legacy_owner_resolutions";
let dir: string;
const owned = new Set<number>();

beforeEach(() => {
	fs.mkdirSync(".tmp", { recursive: true });
	dir = fs.mkdtempSync(join(".tmp", "owner-resolution-file-race-"));
	fs.chmodSync(dir, 0o700);
	owned.clear();
});

afterEach(() => {
	nativeProbe.afterOpen = null;
	vi.restoreAllMocks();
	vi.mocked(fs.lstatSync).mockReset();
	vi.mocked(fs.lstatSync).mockImplementation(realLstat);
	// Remove only files belonging to this fixture, never follow a replacement link.
	for (const name of fs.readdirSync(dir)) {
		const path = join(dir, name);
		const stat = realLstat(path);
		if (stat.isSymbolicLink() || (stat.isFile() && owned.has(stat.ino))) fs.unlinkSync(path);
	}
	fs.rmdirSync(dir);
});

const realLstat = vi.mocked(fs.lstatSync).getMockImplementation() as typeof fs.lstatSync;

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

async function fixture(name: string) {
	const path = join(dir, `${name}.sqlite`);
	const store = new BetterSqliteCoordinatorStore(path);
	try {
		await store.createGroup(`synthetic-${name}`);
		await store.enrollDevice(`synthetic-${name}`, {
			deviceId: `synthetic-device-${name}`,
			publicKey: `synthetic-key-${name}`,
			fingerprint: name.repeat(64),
		});
		await applyAccountConnectionSchema(backend(store.db));
		expect(await readConnectionSchemaState(backend(store.db))).toBe("ready");
		expect(await readLegacyOwnerResolutionSchemaState(backend(store.db))).toBe("missing");
		// Close these synthetic fixtures without WAL companions before renaming their main files.
		store.db.pragma("journal_mode = DELETE");
	} finally {
		await store.close();
	}
	owned.add(realLstat(path).ino);
	return path;
}

function snapshot(path: string) {
	const db = new Database(path, { fileMustExist: true });
	try {
		const schema = db
			.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
			.all();
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		const rows = tables.map(({ name }) => [
			name,
			db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
		]);
		return { schema, rows, receiptTableExists: tables.some(({ name }) => name === table) };
	} finally {
		db.close();
	}
}

function rememberFixtureCompanions() {
	for (const name of fs.readdirSync(dir)) {
		if (!/^(?:a|b|saved-a)\.sqlite-(?:wal|shm|journal)$/u.test(name)) continue;
		const stat = realLstat(join(dir, name));
		if (stat.isFile()) owned.add(stat.ino);
	}
}

it.each(["symlink", "regular-replacement"] as const)(
	"rejects a %s redirect after the real pre-open lstat without writing either database",
	async (kind) => {
		// Arrange: both real native databases satisfy the account prerequisite, with distinct rows.
		const selected = await fixture("a");
		const unintended = await fixture("b");
		const saved = join(dir, "saved-a.sqlite");
		const beforeA = snapshot(selected);
		const beforeB = snapshot(unintended);
		const originalInode = realLstat(selected).ino;
		let checkedInode: number | undefined;
		let redirected = false;
		vi.mocked(fs.lstatSync).mockImplementation(((path: fs.PathLike) => {
			const stat = realLstat(path);
			if (path === selected && !redirected) {
				checkedInode = stat.ino;
				fs.renameSync(selected, saved);
				if (kind === "symlink") fs.symlinkSync("b.sqlite", selected);
				else fs.renameSync(unintended, selected);
				redirected = true;
			}
			return stat;
		}) as typeof fs.lstatSync);

		// Act: preserve the actual outcome so native file evidence is asserted even on baseline failure.
		const outcome = await upgradeCoordinatorOwnerResolutionSchemaFile(selected).then(
			() => ({ rejected: false }),
			(error: unknown) => ({ rejected: true, error }),
		);
		vi.mocked(fs.lstatSync).mockImplementation(realLstat);
		const afterA = snapshot(saved);
		const afterB = snapshot(kind === "symlink" ? unintended : selected);

		// Assert: soft assertions report actual committed DDL in B as well as the missing rejection.
		expect(redirected).toBe(true);
		expect(checkedInode).toBe(originalInode);
		expect.soft(afterB.receiptTableExists, "real unintended B gained receipt DDL").toBe(false);
		expect.soft(afterA).toEqual(beforeA);
		expect.soft(afterB).toEqual(beforeB);
		expect.soft(afterB.rows.filter(([name]) => name !== table)).toEqual(beforeB.rows);
		expect.soft(outcome.rejected).toBe(true);
		expect
			.soft(fs.readdirSync(dir).sort())
			.toEqual(
				kind === "symlink"
					? ["a.sqlite", "b.sqlite", "saved-a.sqlite"]
					: ["a.sqlite", "saved-a.sqlite"],
			);
	},
);

it.each(["normal", "system-temp", "root-sticky-temp"])(
	"protected %s file installs empty receipt storage and repeat is byte-preserving",
	async (location) => {
		// Arrange
		if (location !== "normal") {
			fs.rmdirSync(dir);
			const parent = location === "root-sticky-temp" ? "/tmp" : tmpdir();
			dir = fs.mkdtempSync(join(parent, "owner-resolution-file-race-"));
			fs.chmodSync(dir, 0o700);
		}
		const path = await fixture("a");
		const before = snapshot(path);
		const openedDevices: unknown[] = [];
		nativeProbe.afterOpen = (db, openedPath) => {
			if (openedPath === fs.realpathSync(path)) {
				openedDevices.push(db.prepare("SELECT device_id FROM enrolled_devices").pluck().get());
			}
		};
		// Act
		await upgradeCoordinatorOwnerResolutionSchemaFile(path);
		const probe = nativeProbe.afterOpen;
		nativeProbe.afterOpen = null;
		const installed = snapshot(path);
		const bytes = fs.readFileSync(path);
		nativeProbe.afterOpen = probe;
		await upgradeCoordinatorOwnerResolutionSchemaFile(path);
		nativeProbe.afterOpen = null;
		// Assert
		expect(openedDevices).toEqual(["synthetic-device-a", "synthetic-device-a"]);
		expect(installed.receiptTableExists).toBe(true);
		expect(installed.rows.filter(([name]) => name !== table)).toEqual(before.rows);
		expect(installed.rows.find(([name]) => name === table)).toEqual([table, []]);
		expect(snapshot(path)).toEqual(installed);
		expect(fs.readFileSync(path)).toEqual(bytes);
	},
);

it("rejects a direct symlink without touching its target", async () => {
	// Arrange
	const path = await fixture("a");
	const before = snapshot(path);
	const linked = join(dir, "linked.sqlite");
	fs.symlinkSync("a.sqlite", linked);
	// Act
	const outcome = await upgradeCoordinatorOwnerResolutionSchemaFile(linked).catch(
		(error: unknown) => error,
	);
	// Assert
	expect(outcome).toBeInstanceOf(Error);
	expect(snapshot(path)).toEqual(before);
});

it.each(["DELETE", "WAL"])(
	"rejects the attempted open-B/restore-A redirect before opening or writing (%s)",
	async (mode) => {
		// Arrange: forward the unmodified constructor/options to the real native driver.
		const selected = await fixture("a");
		const unintended = await fixture("b");
		for (const path of [selected, unintended]) {
			const db = new Database(path, { fileMustExist: true });
			db.pragma(`journal_mode = ${mode}`);
			db.close();
		}
		const beforeA = snapshot(selected);
		const beforeB = snapshot(unintended);
		const saved = join(dir, "saved-a.sqlite");
		const trace: string[] = [];
		let openedDevice: unknown;
		let restored = false;
		vi.mocked(fs.lstatSync).mockImplementation(((path: fs.PathLike) => {
			const stat = realLstat(path);
			if (path === selected) {
				fs.renameSync(selected, saved);
				fs.renameSync(unintended, selected);
				vi.mocked(fs.lstatSync).mockImplementation(realLstat);
			}
			return stat;
		}) as typeof fs.lstatSync);
		nativeProbe.afterOpen = (db, path) => {
			if (path !== resolve(selected)) return;
			nativeProbe.afterOpen = null;
			openedDevice = db.prepare("SELECT device_id FROM enrolled_devices").pluck().get();
			rememberFixtureCompanions();
			fs.renameSync(selected, unintended);
			fs.renameSync(saved, selected);
			restored = true;
			const exec = db.exec.bind(db);
			vi.spyOn(db, "exec").mockImplementation((sql) => {
				trace.push(sql.trim().split("\n")[0]);
				return exec(sql);
			});
		};

		// Act: the path snapshot must reject the redirect before the native-open hook can restore A.
		const outcome = await upgradeCoordinatorOwnerResolutionSchemaFile(selected).then(
			() => null,
			(error: unknown) => error,
		);
		nativeProbe.afterOpen = null;
		rememberFixtureCompanions();
		const afterA = snapshot(restored ? selected : saved);
		const afterB = snapshot(restored ? unintended : selected);
		rememberFixtureCompanions();

		// Assert: both journal modes now reject before BEGIN, DDL, or COMMIT, not via an engine error.
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toContain("protected operator-owned folder");
		expect(openedDevice).toBeUndefined();
		expect(restored).toBe(false);
		expect(trace).toEqual([]);
		expect(afterA.receiptTableExists).toBe(false);
		expect(afterB.receiptTableExists).toBe(false);
		expect(afterA).toEqual(beforeA);
		expect(afterB).toEqual(beforeB);
	},
);

it.each([
	["database", 0o620],
	["database", 0o602],
	["parent", 0o720],
	["parent", 0o702],
] as const)(
	"rejects unsafe %s mode %i before opening, preserving all data",
	async (target, mode) => {
		// Arrange: change permissions only on owned fixtures, never their ancestors.
		const path = await fixture("a");
		const before = snapshot(path);
		const bytes = fs.readFileSync(path);
		const changedPath = target === "database" ? path : dir;
		const originalMode = realLstat(changedPath).mode & 0o777;
		const opened = vi.fn();
		nativeProbe.afterOpen = opened;
		fs.chmodSync(changedPath, mode);
		let outcome: unknown;
		// Act
		try {
			outcome = await upgradeCoordinatorOwnerResolutionSchemaFile(path).catch(
				(error: unknown) => error,
			);
		} finally {
			fs.chmodSync(changedPath, originalMode);
			nativeProbe.afterOpen = null;
		}
		// Assert
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toContain("protected operator-owned folder");
		expect(opened).not.toHaveBeenCalled();
		expect(snapshot(path)).toEqual(before);
		expect(fs.readFileSync(path)).toEqual(bytes);
	},
);

it.each(["DELETE", "WAL"])(
	"rolls back an observed asynchronous pre-DDL replacement (%s)",
	async (mode) => {
		// Arrange: inject a deterministic microtask at BEGIN, during the first readiness await.
		const selected = await fixture("a");
		const unintended = await fixture("b");
		for (const path of [selected, unintended]) {
			const db = new Database(path, { fileMustExist: true });
			db.pragma(`journal_mode = ${mode}`);
			db.close();
		}
		const beforeA = snapshot(selected);
		const beforeB = snapshot(unintended);
		const saved = join(dir, "saved-a.sqlite");
		const trace: string[] = [];
		let replaced = false;
		nativeProbe.afterOpen = (db, path) => {
			if (path !== resolve(selected)) return;
			nativeProbe.afterOpen = null;
			const exec = db.exec.bind(db);
			vi.spyOn(db, "exec").mockImplementation((sql) => {
				trace.push(sql.trim().split("\n")[0]);
				const result = exec(sql);
				if (sql === "BEGIN IMMEDIATE")
					queueMicrotask(() => {
						rememberFixtureCompanions();
						fs.renameSync(selected, saved);
						fs.renameSync(unintended, selected);
						replaced = true;
					});
				return result;
			});
		};
		// Act
		const outcome = await upgradeCoordinatorOwnerResolutionSchemaFile(selected).catch(
			(error: unknown) => error,
		);
		rememberFixtureCompanions();
		const afterA = snapshot(saved);
		const afterB = snapshot(selected);
		rememberFixtureCompanions();
		// Assert: detection precedes DDL and neither real database gains schema or business rows.
		expect(replaced).toBe(true);
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toContain("changed during maintenance");
		expect(trace).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
		expect(afterA).toEqual(beforeA);
		expect(afterB).toEqual(beforeB);
		expect(afterA.receiptTableExists).toBe(false);
		expect(afterB.receiptTableExists).toBe(false);
	},
);
