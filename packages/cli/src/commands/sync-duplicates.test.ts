import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initTestSchema, insertTestSession } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSyncDuplicatesCommand } from "./sync-duplicates.js";

let dir: string;
let dbPath: string;
let defaultDbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-sync-duplicates-"));
	dbPath = join(dir, "mem.sqlite");
	// The store a command opens without --db. No test here may create it.
	defaultDbPath = join(dir, "default-store-must-not-open.sqlite");
	vi.stubEnv("CODEMEM_DB", defaultDbPath);
	const db = connect(dbPath);
	initTestSchema(db);
	const session = insertTestSession(db);
	const insert = db.prepare(
		`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at, import_key, scope_id)
		 VALUES (?, 'discovery', 'Title', 'Body', 'now', 'now', ?, ?)`,
	);
	insert.run(session, "key:twice", "scope-a");
	insert.run(session, "key:twice", "scope-a");
	insert.run(session, "key:once", "scope-a");
	insert.run(session, "key:twice", "scope-b");
	db.close();
});

afterEach(() => {
	expect(existsSync(defaultDbPath)).toBe(false);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

it("lists each memory stored more than once in one scope, by row ID", async () => {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});

	await buildSyncDuplicatesCommand().parseAsync(["--db", dbPath, "--json"], { from: "user" });

	expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
		count: 1,
		duplicates: [{ scope_id: "scope-a", memory_ids: [1, 2] }],
	});
});

it("repairs a memory only once it is the only copy left in its scope", async () => {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const repair = () =>
		buildSyncDuplicatesCommand().parseAsync(["repair", "1", "--db", dbPath, "--json"], {
			from: "user",
		});

	await repair();
	const db = connect(dbPath);
	db.prepare("DELETE FROM memory_items WHERE id = 2").run();
	db.close();
	await repair();
	await buildSyncDuplicatesCommand().parseAsync(["--db", dbPath, "--json"], { from: "user" });

	expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
		{ status: "copies_remain", memory_ids: [1, 2] },
		{ status: "repaired", scope_id: "scope-a" },
		{ count: 0, duplicates: [] },
	]);
	process.exitCode = undefined;
});

it("opens the store `repair --db` names, not the default one", async () => {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const db = connect(dbPath);
	db.prepare("DELETE FROM memory_items WHERE id = 2").run();
	db.close();

	await buildSyncDuplicatesCommand().parseAsync(["repair", "1", "--db", dbPath, "--json"], {
		from: "user",
	});

	expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
		status: "repaired",
		scope_id: "scope-a",
	});
	expect(existsSync(defaultDbPath)).toBe(false);
});

it.each([[[]], [["repair", "1"]]])(
	"reports a store that cannot be opened as a JSON error (%j)",
	async (args: string[]) => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		// A directory cannot be opened as a store.
		await buildSyncDuplicatesCommand().parseAsync([...args, "--db", dir, "--json"], {
			from: "user",
		});

		const output = [...log.mock.calls].map(([line]) => String(line)).join("\n");
		expect(output).toContain('"error"');
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;
	},
);
