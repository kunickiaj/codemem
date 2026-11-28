import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { prepareOfflineScopeServingStore } from "./offline-serving-preparation.js";

/**
 * Modules that may construct a SQLite connection, and why it is not a device store
 * connection. Everything else opens device stores through `device-database-open.ts`.
 */
const reviewedConstructors: Record<string, string> = {
	"core/src/device-database-open.ts": "Selects the store's names on every device handle.",
	"core/src/viewer-writer-lock.ts": "Opens the separate `.viewer-lock` file.",
	"core/src/native-runtime.ts": "Probes the native binding with an in-memory database.",
	"core/src/vector-metadata-snapshot.ts": "Builds an in-memory snapshot.",
	"core/src/better-sqlite-coordinator-store.ts": "Opens the coordinator database.",
	"core/src/coordinator-auth-schema-operator.ts": "Upgrades a selected coordinator database.",
	"core/src/coordinator-legacy-owner-resolution-upgrade.ts":
		"Upgrades a selected coordinator database.",
};

const packagesRoot = join(import.meta.dirname, "..", "..");
const sqliteImport =
	/^\s*import\s+(?!type\b)[^;]*from\s+["'](?:better-sqlite3|node:sqlite)["']|\b(?:require|import)\(\s*["'](?:better-sqlite3|node:sqlite)["']\s*\)(?!\.)/m;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		if (entry === "node_modules" || entry === "dist") return [];
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry)) return [];
		if (/\.test\.|test-|-test|fixture|harness|\.d\.ts$/.test(entry)) return [];
		return [path];
	});
}

describe("device store connections", () => {
	it("are constructed only by the shape-aware opener or a reviewed non-device module", () => {
		const roots = readdirSync(packagesRoot)
			.map((name) => join(packagesRoot, name, "src"))
			.filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory());
		const constructors = roots
			.flatMap(sourceFiles)
			.filter((path) => sqliteImport.test(readFileSync(path, "utf8")))
			.map((path) => relative(packagesRoot, path));
		expect(constructors).toContain("core/src/device-database-open.ts");
		expect(constructors.filter((path) => !Object.hasOwn(reviewedConstructors, path))).toEqual([]);
	});

	describe("shape", () => {
		let home: string;
		let path: string;
		beforeEach(() => {
			home = mkdtempSync(join(tmpdir(), "device-shape-"));
			path = join(home, "device.sqlite");
			connect(path).close();
		});
		afterEach(() => rmSync(home, { recursive: true, force: true }));

		it("reads the names a store uses without changing it", async () => {
			const { readDeviceStorageShape } = await import("./device-database-open.js");
			expect(readDeviceStorageShape(path)).toBe("legacy");
			prepareOfflineScopeServingStore(
				path,
				{
					coordinatorId: "fixture",
					groupId: "team",
					generation: "ddc460b1-6dd8-4489-ab5c-799c2319af62",
				},
				[],
			);
			const before = readFileSync(path);
			expect(readDeviceStorageShape(path)).toBe("transitioned");
			expect(readFileSync(path)).toEqual(before);
		});
	});
});
