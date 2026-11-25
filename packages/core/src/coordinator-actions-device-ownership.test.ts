import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinatorListDevicesAction } from "./coordinator-actions.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

function listWith(ownership: unknown, extra: Record<string, unknown> = {}) {
	const item = {
		...extra,
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

describe("remote device list service role", () => {
	it("keeps the relay health probe role the coordinator reports", async () => {
		const [device] = await listWith(undefined, { service_role: "relay_health_probe" });

		expect(device?.service_role).toBe("relay_health_probe");
	});

	it("keeps the coordinator's revoked mark only when it is exactly true", async () => {
		const [marked] = await listWith(undefined, { revoked: true });
		const [loose] = await listWith(undefined, { revoked: "yes" });

		expect(marked?.revoked).toBe(true);
		expect(loose).not.toHaveProperty("revoked");
	});

	it("drops an unknown service role", async () => {
		const [device] = await listWith(undefined, { service_role: "admin" });

		expect(device).not.toHaveProperty("service_role");
	});
});

describe("remote device list rejoin marker", () => {
	it("keeps a safe nonnegative timestamp", async () => {
		const [device] = await listWith(undefined, { rejoined_at_ms: 1_700_000_000_000 });

		expect(device?.rejoined_at_ms).toBe(1_700_000_000_000);
	});

	it.each([
		["a negative value", -1],
		["a fractional value", 1.5],
		["a string", "1700000000000"],
		["a value no Date can hold", 8.64e15 + 1],
		["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
		["null", null],
	])("drops %s", async (_label, marker) => {
		const [device] = await listWith(undefined, { rejoined_at_ms: marker });

		expect(device).toBeDefined();
		expect(device).not.toHaveProperty("rejoined_at_ms");
	});
});
