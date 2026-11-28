import { existsSync, linkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { connect } from "./db.js";
import { prepareOfflineScopeServingStore } from "./offline-serving-preparation.js";

const prep = {
	coordinatorId: "fixture",
	groupId: "team",
	generation: "e650c576-e1e0-4050-833a-77615ed34bbf",
};
let home: string;
let path: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "offline-serving-preparation-"));
	path = join(home, "device.sqlite");
	connect(path).close();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function counts() {
	const db = new Database(path, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT count(*) FROM sqlite_schema WHERE name IN ('scope_serving_preparations','scope_serving_proofs_v2')",
			)
			.pluck()
			.get();
	} finally {
		db.close();
	}
}

it("refuses an idle WAL reader before creating either table; succeeds only after it closes", () => {
	const reader = new Database(path, { readonly: true });
	try {
		reader.prepare("SELECT count(*) FROM sessions").get();
		expect(reader.inTransaction).toBe(false);
		// A normal BEGIN EXCLUSIVE is only a writer lock in WAL mode. The
		// reader would not prevent preparation if we relied on that alone.
		const ordinary = new Database(path, { timeout: 0 });
		try {
			ordinary.transaction(() => expect(ordinary.inTransaction).toBe(true)).exclusive();
		} finally {
			ordinary.close();
		}
		expect(() => prepareOfflineScopeServingStore(path, prep, [])).toThrow("store is in use");
		expect(counts()).toBe(0);
	} finally {
		reader.close();
	}
	prepareOfflineScopeServingStore(path, prep, []);
	expect(counts()).toBe(2);
});

it("holds the exclusive lock through envelope storage and releases it on rollback", () => {
	const envelope = {
		scopeId: "s",
		deviceId: "d",
		keyId: "ab".repeat(32),
		get envelope(): Uint8Array {
			const late = new Database(path, { readonly: true, timeout: 0 });
			try {
				expect(() => late.prepare("SELECT count(*) FROM sessions").get()).toThrow(/locked/i);
			} finally {
				late.close();
			}
			throw new Error("fixture write interrupted");
		},
	};
	expect(() => prepareOfflineScopeServingStore(path, prep, [envelope])).toThrow(
		"fixture write interrupted",
	);
	expect(counts()).toBe(0);
	prepareOfflineScopeServingStore(path, prep, []);
	expect(counts()).toBe(2);
});

it("refuses rollback journal mode without switching it", () => {
	const db = new Database(path);
	try {
		expect(db.pragma("journal_mode=DELETE", { simple: true })).toBe("delete");
	} finally {
		db.close();
	}
	expect(() => prepareOfflineScopeServingStore(path, prep, [])).toThrow("WAL");
	expect(counts()).toBe(0);
	const check = new Database(path, { readonly: true });
	try {
		expect(check.pragma("journal_mode", { simple: true })).toBe("delete");
	} finally {
		check.close();
	}
});

it("refuses missing files and hard-linked stores", () => {
	const missing = join(home, "missing");
	expect(() => prepareOfflineScopeServingStore(missing, prep, [])).toThrow("existing device store");
	expect(existsSync(missing)).toBe(false);
	linkSync(path, join(home, "second-name"));
	expect(() => prepareOfflineScopeServingStore(path, prep, [])).toThrow("single-link");
	expect(counts()).toBe(0);
});
