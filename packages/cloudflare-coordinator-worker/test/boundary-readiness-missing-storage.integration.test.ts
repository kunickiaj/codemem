import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BOUNDARY_READINESS_STORAGE_PRESENT_SQL } from "../../core/src/coordinator-boundary-readiness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

// A deployment whose Worker is newer than its database: every migration except 0050.
beforeAll(async () => {
	const db = env.COORDINATOR_DB;
	await db.batch([
		db.prepare("DROP TABLE coordinator_boundary_readiness_projects"),
		db.prepare("DROP TABLE coordinator_boundary_readiness"),
	]);
});

describe("native D1 without readiness storage", () => {
	const store = () => new D1CoordinatorStore(env.COORDINATOR_DB);
	const device = { groupId: "group-a", deviceId: "device-a" };

	it("has no readiness storage", async () => {
		const row = await env.COORDINATOR_DB.prepare(BOUNDARY_READINESS_STORAGE_PRESENT_SQL).first<{
			present: number;
		}>();

		expect(row?.present).toBe(0);
	});

	it("answers that readiness records are unavailable", async () => {
		const result = await store().putBoundaryReadiness({ ...device, sequence: 1, projects: [] });

		expect(result).toEqual({ kind: "unavailable" });
	});

	it("reads no record", async () => {
		expect(await store().getBoundaryReadiness(device)).toBeNull();
	});

	it("has nothing to discard, which is what every presence post asks for", async () => {
		expect(await store().discardBoundaryReadiness(device)).toBe(false);
	});
});
