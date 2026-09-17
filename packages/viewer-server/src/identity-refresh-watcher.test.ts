import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerIdentityRefreshWatcher } from "./index.js";

describe("registerIdentityRefreshWatcher", () => {
	it("refreshes cached target state after the invite route changes identity", async () => {
		const store = { actorId: "actor-before", deviceId: "device-1" };
		const refreshCurrentIdentity = vi.fn();
		const app = new Hono();
		registerIdentityRefreshWatcher(app, () => store, {
			dbPath: "/memory.sqlite",
			hasCurrentIdentity: () => true,
			refreshCurrentIdentity,
		});
		app.post("/api/sync/invites/import", (c) => {
			store.actorId = "actor-after";
			return c.json({ ok: true });
		});

		const response = await app.request("/api/sync/invites/import", { method: "POST" });

		expect(response.status).toBe(200);
		expect(refreshCurrentIdentity).toHaveBeenCalledOnce();
	});

	it("does not refresh cached target state when identity is unchanged", async () => {
		const store = { actorId: "actor-1", deviceId: "device-1" };
		const refreshCurrentIdentity = vi.fn();
		const app = new Hono();
		registerIdentityRefreshWatcher(app, () => store, {
			dbPath: "/memory.sqlite",
			hasCurrentIdentity: () => true,
			refreshCurrentIdentity,
		});
		app.post("/api/sync/invites/import", (c) => c.json({ ok: true }));

		await app.request("/api/sync/invites/import", { method: "POST" });

		expect(refreshCurrentIdentity).not.toHaveBeenCalled();
	});
});
