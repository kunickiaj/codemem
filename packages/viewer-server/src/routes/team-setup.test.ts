import { fingerprintPublicKey, readCoordinatorSyncConfig } from "@codemem/core";
import { describe, expect, it, vi } from "vitest";
import { __teamSetupTestHooks } from "./team-setup.js";

describe("Team setup roster loading", () => {
	it.each([
		{ configuredTimeoutS: 17, expectedTimeoutS: 17 },
		{ configuredTimeoutS: 0, expectedTimeoutS: 1 },
	])("uses normalized coordinator settings with timeout $expectedTimeoutS", async ({
		configuredTimeoutS,
		expectedTimeoutS,
	}) => {
		const publicKey = "public-key-a";
		const listGroups = vi.fn(async () => [
			{
				group_id: "group-alpha",
				display_name: "Migration Team",
				archived_at: null,
				created_at: "2026-08-24T00:00:00.000Z",
			},
		]);
		const listDevices = vi.fn(async () => [
			{
				group_id: "group-alpha",
				device_id: "device-a",
				public_key: publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
				identity_id: null,
				display_name: "Laptop",
				enabled: 1,
				created_at: "2026-08-24T00:00:00.000Z",
			},
		]);

		const snapshots = await __teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith({
			readConfig: () => ({
				...readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: "localhost:8787/",
				syncCoordinatorGroups: ["group-alpha"],
				syncCoordinatorAdminSecret: "private-admin-secret",
				syncCoordinatorTimeoutS: configuredTimeoutS,
			}),
			listGroups,
			listDevices,
		});

		expect(snapshots[0]?.coordinatorId).toBe("http://localhost:8787");
		expect(listGroups).toHaveBeenCalledWith(
			expect.objectContaining({
				remoteUrl: "http://localhost:8787",
				timeoutS: expectedTimeoutS,
			}),
		);
		expect(listDevices).toHaveBeenCalledWith(
			expect.objectContaining({
				remoteUrl: "http://localhost:8787",
				timeoutS: expectedTimeoutS,
			}),
		);
	});
});
