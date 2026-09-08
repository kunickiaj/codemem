import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireLegacyTeamSetupReachableDevicesWithinLimit } from "./legacy-team-setup-limits.js";

describe("legacy Team readiness traversal limit", () => {
	let db: InstanceType<typeof Database>;
	const devices = Array.from({ length: 500 }, (_, index) => ({ deviceId: `device-${index}` }));
	const projects = Array.from({ length: 20 }, (_, index) => `project-${index}`);

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec("CREATE TABLE identity_devices (device_id TEXT PRIMARY KEY)");
		db.transaction(() => {
			const insert = db.prepare("INSERT INTO identity_devices VALUES (?)");
			for (const device of devices) insert.run(device.deviceId);
		})();
	});
	afterEach(() => db.close());

	it("counts already assigned roster devices once at the supported boundary", () => {
		expect(() =>
			requireLegacyTeamSetupReachableDevicesWithinLimit(db, devices, projects),
		).not.toThrow();
	});

	it("still counts assignments outside the roster", () => {
		db.prepare("INSERT INTO identity_devices VALUES (?)").run("outside-roster");
		expect(() => requireLegacyTeamSetupReachableDevicesWithinLimit(db, devices, projects)).toThrow(
			"legacy_team_setup_roster_too_large",
		);
	});

	it("counts an unassigned roster even when there are no persisted assignments", () => {
		db.exec("DELETE FROM identity_devices");
		expect(() =>
			requireLegacyTeamSetupReachableDevicesWithinLimit(db, devices, [...projects, "extra"]),
		).toThrow("legacy_team_setup_roster_too_large");
	});
});
