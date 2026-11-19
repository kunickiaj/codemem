import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncRoutes } from "./sync.js";

// Without a coordinator URL these actions fall back to a coordinator database on
// this machine. The mocks keep the tests away from any real one.
vi.mock("@codemem/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@codemem/core")>()),
	coordinatorCreateInviteAction: vi.fn(async () => ({ encoded: "invite", mode: "local" })),
	coordinatorRevokeBootstrapGrantAction: vi.fn(async () => true),
	coordinatorListBootstrapGrantsAction: vi.fn(async () => []),
}));

let directory: string;
let store: core.MemoryStore;

function configure(config: Record<string, unknown>): void {
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(config));
	vi.stubEnv("CODEMEM_CONFIG", path);
}

function send(path: string, body: unknown) {
	const url = `http://localhost${path}`;
	if (body === null) return syncRoutes(() => store).request(url);
	return syncRoutes(() => store).request(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

const routes = [
	{
		path: "/api/sync/invites/create",
		body: { group_id: "group-a", policy: "auto_admit", ttl_hours: 24 },
		action: () => vi.mocked(core.coordinatorCreateInviteAction),
	},
	{
		path: "/api/sync/bootstrap-grants/revoke",
		body: { grant_id: "grant-1" },
		action: () => vi.mocked(core.coordinatorRevokeBootstrapGrantAction),
	},
	{
		// Reading grants opens, and can migrate, the coordinator database too.
		path: "/api/sync/bootstrap-grants?group_id=group-a",
		body: null,
		action: () => vi.mocked(core.coordinatorListBootstrapGrantsAction),
	},
];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-coordinator-authority-"));
	// Scoped test overrides only; never read the user's config or signing keys.
	vi.stubEnv("CODEMEM_KEYS_DIR", join(directory, "keys"));
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", "");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "");
	store = new core.MemoryStore(join(directory, "store.sqlite"));
});

afterEach(() => {
	store.close();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

describe("Viewer coordinator actions without the configured coordinator", () => {
	it.each(routes)("refuses $path with no coordinator URL", async ({ path, body, action }) => {
		configure({ sync_coordinator_group: "group-a" });

		const response = await send(path, body);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "coordinator_not_configured" });
		expect(action()).not.toHaveBeenCalled();
	});

	it.each(routes)("refuses $path without the admin secret", async ({ path, body, action }) => {
		configure({ sync_coordinator_url: "https://coord.example.test" });

		const response = await send(path, body);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "coordinator_admin_secret_missing" });
		expect(action()).not.toHaveBeenCalled();
	});

	it.each(routes)("sends $path to the configured coordinator", async ({ path, body, action }) => {
		configure({
			sync_coordinator_url: "https://coord.example.test",
			sync_coordinator_admin_secret: "secret",
		});

		const response = await send(path, body);

		expect(response.status).toBe(200);
		expect(action()).toHaveBeenCalledWith(
			expect.objectContaining({
				remoteUrl: "https://coord.example.test",
				adminSecret: "secret",
			}),
		);
	});
});
