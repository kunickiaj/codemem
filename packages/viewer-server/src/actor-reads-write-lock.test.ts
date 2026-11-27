import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTestSchema, MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index.js";

/*
 * Reads that check this device's actor row used to run the repair in a write
 * transaction on every request, so another writer, such as the maintenance
 * worker, could hold them up for the whole busy timeout.
 */

let directory: string;
let dbPath: string;
let previousConfig: string | undefined;
let store: MemoryStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-actor-reads-"));
	dbPath = join(directory, "mem.sqlite");
	previousConfig = process.env.CODEMEM_CONFIG;
	writeFileSync(join(directory, "config.json"), JSON.stringify({ sync_enabled: false }));
	process.env.CODEMEM_CONFIG = join(directory, "config.json");
	const database = new Database(dbPath);
	initTestSchema(database);
	database.close();
	store = new MemoryStore(dbPath);
	app = createApp({ storeFactory: () => store });
});

afterEach(() => {
	store.close();
	if (previousConfig === undefined) delete process.env.CODEMEM_CONFIG;
	else process.env.CODEMEM_CONFIG = previousConfig;
	rmSync(directory, { recursive: true, force: true });
});

/** Runs `read` while another connection holds the write lock. */
async function whileAnotherWriterHoldsTheLock<T>(read: () => Promise<T>): Promise<T> {
	const writer = new Database(dbPath);
	writer.exec("BEGIN IMMEDIATE");
	store.db.pragma("busy_timeout = 100");
	try {
		return await read();
	} finally {
		writer.exec("ROLLBACK");
		writer.close();
	}
}

describe("actor reads", () => {
	it.each(["/api/sync/actors", "/api/sync/recipient-policy/v1/review"])(
		"%s answers while another writer holds the lock",
		async (path) => {
			// The first read creates this device's actor row.
			expect((await app.request(path)).status).toBe(200);

			const response = await whileAnotherWriterHoldsTheLock(async () => app.request(path));

			expect(response.status).toBe(200);
		},
	);

	it("still repairs a second local actor row", async () => {
		await app.request("/api/sync/actors");
		const now = new Date().toISOString();
		store.db
			.prepare(
				`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
				 VALUES ('stale-local-actor', 'Old identity', 1, 'active', ?, ?)`,
			)
			.run(now, now);

		expect((await app.request("/api/sync/actors")).status).toBe(200);

		const local = store.db.prepare("SELECT actor_id FROM actors WHERE is_local = 1").pluck().all();
		expect(local).toEqual([store.actorId]);
	});
});
