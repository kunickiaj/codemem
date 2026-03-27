import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	coordinatorCreateGroupAction,
	coordinatorDisableDeviceAction,
	coordinatorEnrollDeviceAction,
	coordinatorListDevicesAction,
	coordinatorListGroupsAction,
	coordinatorRemoveDeviceAction,
	coordinatorRenameDeviceAction,
} from "./coordinator-actions.js";

describe("coordinator local admin actions", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "coord-actions-test-"));
		dbPath = join(tmpDir, "coordinator.sqlite");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates and lists groups", () => {
		const group = coordinatorCreateGroupAction({
			groupId: "team-a",
			displayName: "Team A",
			dbPath,
		});
		expect(group.group_id).toBe("team-a");
		expect(coordinatorListGroupsAction({ dbPath })).toEqual([
			expect.objectContaining({ group_id: "team-a", display_name: "Team A" }),
		]);
	});

	it("enrolls and lists devices for an existing group", () => {
		coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const enrollment = coordinatorEnrollDeviceAction({
			groupId: "team-a",
			deviceId: "device-1",
			fingerprint: "fp-1",
			publicKey: "pk-1",
			displayName: "Laptop",
			dbPath,
		});
		expect(enrollment.device_id).toBe("device-1");
		expect(coordinatorListDevicesAction({ groupId: "team-a", dbPath })).toEqual([
			expect.objectContaining({ device_id: "device-1", display_name: "Laptop" }),
		]);
	});

	it("renames, disables, and removes devices", () => {
		coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		coordinatorEnrollDeviceAction({
			groupId: "team-a",
			deviceId: "device-1",
			fingerprint: "fp-1",
			publicKey: "pk-1",
			dbPath,
		});
		expect(
			coordinatorRenameDeviceAction({
				groupId: "team-a",
				deviceId: "device-1",
				displayName: "Work Laptop",
				dbPath,
			}),
		).toEqual(expect.objectContaining({ display_name: "Work Laptop" }));
		expect(
			coordinatorDisableDeviceAction({ groupId: "team-a", deviceId: "device-1", dbPath }),
		).toBe(true);
		expect(coordinatorListDevicesAction({ groupId: "team-a", dbPath })).toEqual([]);
		expect(
			coordinatorListDevicesAction({ groupId: "team-a", includeDisabled: true, dbPath }),
		).toEqual([expect.objectContaining({ device_id: "device-1", enabled: 0 })]);
		expect(coordinatorRemoveDeviceAction({ groupId: "team-a", deviceId: "device-1", dbPath })).toBe(
			true,
		);
		expect(
			coordinatorListDevicesAction({ groupId: "team-a", includeDisabled: true, dbPath }),
		).toEqual([]);
	});

	it("rejects enrollment into a missing group", () => {
		expect(() =>
			coordinatorEnrollDeviceAction({
				groupId: "missing",
				deviceId: "device-1",
				fingerprint: "fp-1",
				publicKey: "pk-1",
				dbPath,
			}),
		).toThrow("Group not found: missing");
	});
});
