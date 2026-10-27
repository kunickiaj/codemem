import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinatorListDevicesAction } from "./coordinator-actions.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

function listWith(ownership: unknown) {
	const item = {
		group_id: "group-a",
		device_id: "device-d",
		public_key: "pk-d",
		fingerprint: "fp-d",
		identity_id: "identity-new",
		display_name: null,
		enabled: 1,
		created_at: "2026-10-27T00:00:00.000Z",
		...(ownership === undefined ? {} : { ownership_identity_id: ownership }),
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ items: [item] })),
	);
	return coordinatorListDevicesAction({
		groupId: "group-a",
		remoteUrl: "https://coordinator.example.test",
		adminSecret: "test-secret",
	});
}

describe("remote device list ownership", () => {
	it("keeps the Identity a coordinator binding names", async () => {
		// Arrange / Act
		const [device] = await listWith("identity-new");
		// Assert
		expect(device?.ownership_identity_id).toBe("identity-new");
	});

	it.each([
		["an older coordinator that omits it", undefined],
		["a malformed value", { id: "identity-new" }],
	])("leaves it out for %s", async (_label, ownership) => {
		// Arrange / Act
		const [device] = await listWith(ownership);
		// Assert
		expect(device).toBeDefined();
		expect(device).not.toHaveProperty("ownership_identity_id");
	});
});
