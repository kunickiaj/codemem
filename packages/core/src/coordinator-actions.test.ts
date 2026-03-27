import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	coordinatorCreateGroupAction,
	coordinatorCreateInviteAction,
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
	let prevConfigPath: string | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "coord-actions-test-"));
		dbPath = join(tmpDir, "coordinator.sqlite");
		prevConfigPath = process.env.CODEMEM_CONFIG;
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
	});

	afterEach(() => {
		if (prevConfigPath == null) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevConfigPath;
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

	it("warns when local invite coordinator URL looks private-only", async () => {
		coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const invite = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "http://100.103.98.49:7347",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
		});
		expect(invite.warnings).toEqual([
			"Invite uses a CGNAT/Tailscale-style coordinator IP address. This can be correct for Tailnet-only teams, but other teammates may not be able to join unless they share that network.",
		]);
	});

	it("does not warn for public-looking invite coordinator URLs", async () => {
		coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const invite = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "https://coord.example.test",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
		});
		expect(invite.warnings).toEqual([]);
	});

	it("warns when local invite coordinator URL uses private IPv6 space", async () => {
		coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const invite = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "http://[fd7a:115c:a1e0::1234]:7347",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
		});
		expect(invite.warnings).toEqual([
			"Invite uses a ULA/Tailnet-style coordinator IPv6 address. This can be correct for private-network teams, but other teammates may not be able to join unless they share that network.",
		]);
	});

	it("warns when local invite coordinator URL uses link-local IPv6 space", async () => {
		coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const invite = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "http://[fe80::1]:7347",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
		});
		expect(invite.warnings).toEqual([
			"Invite uses a link-local coordinator IPv6 address. It usually only works on the same local network segment.",
		]);
	});
});
