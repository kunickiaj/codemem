import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCoordinatorPresence } from "./coordinator-runtime.js";
import { readCoordinatorSyncConfig } from "./coordinator-sync-config.js";
import { withdrawProjectScope } from "./project-scope-withdrawal.js";
import * as syncAuth from "./sync-auth.js";
import * as syncHttpClient from "./sync-http-client.js";
import * as syncIdentity from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue(["dev-local", "fp-local"]);
	vi.spyOn(syncIdentity, "loadPublicKey").mockReturnValue("ed25519 AAAA");
	vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});
});

afterEach(() => {
	vi.restoreAllMocks();
	db.close();
});

describe("a device that withdrew from a Project", () => {
	it("still posts its presence to every coordinator group", async () => {
		// Arrange: other devices' migrations wait for this device's presence.
		withdrawProjectScope(db, {
			canonicalProjectIdentity: "git:example/atlas",
			groupId: "group-a",
			now: "2026-11-18T10:00:00.000Z",
		});
		const request = vi.spyOn(syncHttpClient, "requestJson").mockResolvedValue([200, { ok: true }]);
		const config = readCoordinatorSyncConfig({
			sync_coordinator_url: "https://coord.example.test",
			sync_coordinator_groups: ["group-a", "group-b"],
		});

		// Act
		const result = await registerCoordinatorPresence({ db, dbPath: ":memory:" }, config);

		// Assert
		expect(result?.groups).toEqual(["group-a", "group-b"]);
		expect(request.mock.calls.map(([method, url]) => `${method} ${url}`)).toEqual([
			"POST https://coord.example.test/v1/presence",
			"POST https://coord.example.test/v1/presence",
		]);
	});
});
