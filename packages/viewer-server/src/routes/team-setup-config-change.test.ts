import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTestSchema, MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";

let directory: string;
let store: MemoryStore;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-team-setup-config-"));
	const dbPath = join(directory, "mem.sqlite");
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, JSON.stringify({ sync_coordinator_group: "group-a" }));
	vi.stubEnv("CODEMEM_CONFIG", configPath);
	const database = new Database(dbPath);
	initTestSchema(database);
	database.close();
	store = new MemoryStore(dbPath);
});

afterEach(() => {
	store.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

describe("Team setup and coordinator settings", () => {
	it("checks Team setup again when coordinator settings are saved", async () => {
		const loadSnapshots = vi.fn(async () => []);
		let check: { settle: () => Promise<void>; refresh: () => Promise<void> } | null = null;
		const app = createApp({
			storeFactory: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
			teamSetupCompletionDependencies: null,
			onTeamSetupReconciliation: (registered) => {
				check = registered;
			},
		});
		await check?.refresh();
		const checksBefore = loadSnapshots.mock.calls.length;

		const saved = await app.request("/api/config", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "http://localhost" },
			body: JSON.stringify({ config: { sync_coordinator_group: "group-b" } }),
		});
		await check?.settle();

		expect(saved.status).toBe(200);
		expect(checksBefore).toBe(1);
		expect(loadSnapshots.mock.calls.length).toBe(checksBefore + 1);
	});
});
