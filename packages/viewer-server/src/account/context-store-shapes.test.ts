import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, ensureDeviceIdentity } from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { prepareOfflineScopeServingStore } from "../../../core/src/offline-serving-preparation.js";
import { createAccountContextReader } from "../index.js";

let dir = "";
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

it("reads the same account context from a store before and after its transition", () => {
	for (const name of ["CODEMEM_ACTOR_ID", "CODEMEM_DEVICE_ID", "CODEMEM_SYNC_COORDINATOR_URL"])
		vi.stubEnv(name, undefined);
	dir = mkdtempSync(join(tmpdir(), "account-context-shapes-"));
	const dbPath = join(dir, "device.sqlite");
	const keysDir = join(dir, "keys");
	const db = connect(dbPath);
	let deviceId: string;
	try {
		[deviceId] = ensureDeviceIdentity(db, { keysDir });
	} finally {
		db.close();
	}
	const read = createAccountContextReader({
		getProfile: () => ({ dbPath, deviceId, identityId: `local:${deviceId}` }),
		readConfig: () => ({
			sync_coordinator_url: "https://coordinator.example.test",
			sync_coordinator_groups: ["group-a"],
		}),
		configPath: join(dir, "config.json"),
		keysDir,
	});
	const before = read();
	expect(before).toMatchObject({ setup: "ready", context: { deviceId } });
	prepareOfflineScopeServingStore(
		dbPath,
		{
			coordinatorId: "fixture",
			groupId: "group-a",
			generation: "ddc460b1-6dd8-4489-ab5c-799c2319af62",
		},
		[],
	);
	const raw = new Database(dbPath, { readonly: true });
	try {
		expect(raw.prepare("SELECT name FROM sqlite_schema WHERE name = 'sync_device'").get()).toBe(
			undefined,
		);
	} finally {
		raw.close();
	}
	expect(read()).toEqual(before);
});
