import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { syncRoutes } from "./sync.js";

const CONFIG = {
	sync_coordinator_url: "https://coord.example.test",
	sync_coordinator_group: "team-a",
	sync_coordinator_groups: ["team-a", "team-b"],
	sync_coordinator_admin_secret: "secret",
};

function createArchiveRouteFixture(config: Record<string, unknown> = CONFIG) {
	const configDir = mkdtempSync(join(tmpdir(), "codemem-archive-route-test-"));
	const configPath = join(configDir, "config.json");
	const previousConfig = process.env.CODEMEM_CONFIG;
	const previousFetch = globalThis.fetch;
	process.env.CODEMEM_CONFIG = configPath;
	writeFileSync(configPath, JSON.stringify(config));
	const app = syncRoutes(() => {
		throw new Error("archive route should not access the memory store");
	});
	return {
		app,
		configPath,
		cleanup: () => {
			rmSync(configDir, { recursive: true, force: true });
			if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
			else process.env.CODEMEM_CONFIG = previousConfig;
			globalThis.fetch = previousFetch;
		},
	};
}

function archiveRetryFetch() {
	let archiveAttempts = 0;
	return vi.fn(async (input: RequestInfo | URL) => {
		if (!String(input).includes("/v1/admin/groups/archive")) {
			return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
		}
		archiveAttempts += 1;
		if (archiveAttempts === 1) {
			return new Response(
				JSON.stringify({
					group: {
						group_id: "team-a",
						display_name: "Team A",
						archived_at: "2026-04-14T00:00:00Z",
					},
				}),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify({ error: "group_not_found_or_already_archived" }), {
			status: 404,
		});
	});
}

function invalidArchiveResponses(): Response[] {
	return [
		new Response(JSON.stringify({ ok: true }), { status: 200 }),
		new Response(JSON.stringify({ group: {} }), { status: 200 }),
		new Response(
			JSON.stringify({ group: { group_id: "team-b", archived_at: "2026-04-14T00:00:00Z" } }),
			{ status: 200 },
		),
		new Response(JSON.stringify({ group: { group_id: "team-a", archived_at: null } }), {
			status: 200,
		}),
		new Response(JSON.stringify({ group: { group_id: "team-a", archived_at: "invalid" } }), {
			status: 200,
		}),
		new Response(JSON.stringify({ error: "group_not_found_or_already_archived" }), {
			status: 500,
		}),
	];
}

describe("coordinator archive routes", () => {
	it("converges local config when archive is retried after cleanup fails", async () => {
		const fixture = createArchiveRouteFixture();
		const lockPath = `${fixture.configPath}.lock`;
		const fetchMock = archiveRetryFetch();
		try {
			writeFileSync(lockPath, "active writer", "utf8");
			globalThis.fetch = fetchMock as typeof fetch;

			const first = await fixture.app.request("/api/coordinator/admin/groups/team-a/archive", {
				method: "POST",
			});
			expect(first.status).toBe(400);
			expect(await first.json()).toMatchObject({
				error: expect.stringContaining("another writer is updating"),
				status: { groups: ["team-a", "team-b"], active_group: "team-a" },
			});

			rmSync(lockPath);
			const second = await fixture.app.request("/api/coordinator/admin/groups/team-a/archive", {
				method: "POST",
			});
			expect(second.status).toBe(404);
			expect(await second.json()).toMatchObject({
				error: "group_not_found_or_already_archived",
				disconnected_group_id: "team-a",
				groups: ["team-b"],
				status: { groups: ["team-b"], active_group: "team-b" },
			});
			expect(JSON.parse(readFileSync(fixture.configPath, "utf8"))).toMatchObject({
				sync_coordinator_group: "team-b",
				sync_coordinator_groups: ["team-b"],
			});
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			fixture.cleanup();
		}
	});

	it("preserves local config without authoritative archive evidence", async () => {
		const fixture = createArchiveRouteFixture();
		const responses = invalidArchiveResponses();
		try {
			globalThis.fetch = vi.fn(async () => responses.shift() as Response) as typeof fetch;
			for (let attempt = 0; attempt < 6; attempt += 1) {
				const response = await fixture.app.request("/api/coordinator/admin/groups/team-a/archive", {
					method: "POST",
				});
				expect(response.status).toBe(400);
				expect(JSON.parse(readFileSync(fixture.configPath, "utf8"))).toMatchObject({
					sync_coordinator_group: "team-a",
					sync_coordinator_groups: ["team-a", "team-b"],
				});
			}
		} finally {
			fixture.cleanup();
		}
	});

	it("clears an archived singular group omitted from the plural list", async () => {
		const fixture = createArchiveRouteFixture({
			...CONFIG,
			sync_coordinator_groups: ["team-b"],
		});
		try {
			globalThis.fetch = vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "group_not_found_or_already_archived" }), {
						status: 404,
					}),
			) as typeof fetch;

			const response = await fixture.app.request("/api/coordinator/admin/groups/team-a/archive", {
				method: "POST",
			});

			expect(response.status).toBe(404);
			expect(JSON.parse(readFileSync(fixture.configPath, "utf8"))).toMatchObject({
				sync_coordinator_group: "team-b",
				sync_coordinator_groups: ["team-b"],
			});
		} finally {
			fixture.cleanup();
		}
	});
});
