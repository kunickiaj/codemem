import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	RelayHealthInstrumentation,
	RelayHealthMonitor,
	type RelayHealthServerEvent,
} from "./relay-health.js";
import type { RelayHealthPublication } from "./relay-health-storage.js";
import { healthCatalogue, healthFixture, healthMembers } from "./relay-health-test-fixtures.js";

/**
 * A monitor driven the way a Durable Object drives it: no start(), a frozen
 * monotonic clock, and server samples recorded through the producer link.
 */
function setup() {
	const f = healthFixture();
	// Workers timers do not advance during compute, so the monotonic guard never opens.
	vi.spyOn(performance, "now").mockReturnValue(0);
	let revision = 0;
	const published: RelayHealthPublication[] = [];
	const publish = vi.fn(async (value: RelayHealthPublication): Promise<number | null> => {
		published.push(value);
		return ++revision;
	});
	const create = () => new RelayHealthMonitor({ ...f.options, enabled: true, publish });
	let monitor = create();
	const app = new Hono();
	const instrumentation = new RelayHealthInstrumentation(
		{ groups: new Map([["group-a", "scope-a"]]), probeDeviceId: "device-a", clock: f.clock },
		async ({ sample }) => {
			if (sample) await monitor.recordServerSample(sample);
		},
	);
	instrumentation.install(app);
	app.get("*", (c) => {
		instrumentation.verifiedGroupMember(c.req.raw, "device-a", "group-a");
		return Response.json(c.req.path.endsWith("/members") ? healthMembers : healthCatalogue);
	});
	f.fetcher.mockImplementation(async (url, init) => app.request(String(url), init));
	return {
		...f,
		publish,
		published,
		monitor: () => monitor,
		/** Replaces the monitor with a new one restored from the old one's exported state. */
		evict: () => {
			const state = structuredClone(monitor.exportState());
			monitor = create();
			return monitor.importState(state);
		},
		/** Replaces the monitor with a new one, as an owner that persisted nothing would. */
		forget: () => {
			monitor = create();
		},
	};
}
afterEach(() => {
	vi.restoreAllMocks();
});

describe("relay health driven by an external scheduler", () => {
	it("recovers through scheduled cycles when every cycle runs on a restored monitor", async () => {
		// Arrange
		const f = setup();
		const imported: boolean[] = [];
		// Act
		for (let now = 120000; now <= 480000; now += 30000) {
			f.setNow(now);
			imported.push(f.evict());
			await f.monitor().runScheduledCycle();
		}
		// Assert
		expect(imported.every(Boolean)).toBe(true);
		expect(f.fetcher).toHaveBeenCalledTimes(26);
		expect(f.monitor().snapshot()).toMatchObject({
			state: "ready",
			healthyWindows: 5,
			observedAtMs: 480000,
		});
		expect(f.published.at(-1)).toMatchObject({ state: "ready", observedAtMs: 480000 });
	});

	it("stays tripped when the windows are lost between cycles", async () => {
		// Arrange
		const f = setup();
		const imported: boolean[] = [];
		// Act
		for (let now = 120000; now <= 480000; now += 30000) {
			f.setNow(now);
			f.forget();
			imported.push(f.monitor().importState({ version: 1, windows: {} }));
			await f.monitor().runScheduledCycle();
		}
		// Assert: a malformed import keeps the conservative state of a new monitor.
		expect(imported.some(Boolean)).toBe(false);
		expect(f.monitor().snapshot()).toMatchObject({ state: "tripped", healthyWindows: 0 });
	});

	it("refuses a restore after a gap longer than maxGapMs, so recovery starts over", async () => {
		// Arrange
		const f = setup();
		for (let now = 120000; now <= 480000; now += 30000) {
			f.setNow(now);
			await f.monitor().runScheduledCycle();
		}
		const state = structuredClone(f.monitor().exportState());
		const restore = (now: number) => {
			f.setNow(now);
			f.forget();
			return f.monitor().importState(state, { maxGapMs: 120000 });
		};
		// Act
		const withinGap = restore(600000);
		// Stale but not tripped: one fresh cycle would make it ready again.
		const stateWithin = f.monitor().snapshot().state;
		const pastGap = restore(600001);
		// Assert
		expect([withinGap, stateWithin]).toEqual([true, "paused"]);
		expect(pastGap).toBe(false);
		expect(f.monitor().snapshot()).toMatchObject({ state: "tripped", healthyWindows: 0 });
	});

	it("trips from a forwarded real-client failure and ignores other groups", async () => {
		// Arrange
		const f = setup();
		for (let now = 120000; now <= 480000; now += 30000) {
			f.setNow(now);
			await f.monitor().runScheduledCycle();
		}
		const failure = {
			endpoint: "members" as const,
			completedAt: f.clock(),
			durationMs: 12,
			outcome: "failure" as const,
		};
		// Act
		await f.monitor().recordServerSample({
			groupId: "group-b",
			cohort: "real-client",
			observation: failure,
		});
		const afterOtherGroup = f.monitor().snapshot().state;
		await f.monitor().recordServerSample({
			groupId: "group-a",
			cohort: "real-client",
			observation: failure,
		});
		// Assert
		expect(afterOtherGroup).toBe("ready");
		expect(f.monitor().snapshot().state).toBe("paused");
		expect(f.published.at(-1)).toMatchObject({ state: "paused" });
	});
});

describe("relay health instrumentation for several groups", () => {
	it("classifies verified reads per group and forwards nothing for others", async () => {
		// Arrange
		const f = healthFixture();
		const events: RelayHealthServerEvent[] = [];
		const app = new Hono();
		const instrumentation = new RelayHealthInstrumentation(
			{
				groups: new Map([
					["group-a", "scope-a"],
					["group-b", "scope-b"],
				]),
				probeDeviceId: "probe",
				clock: f.clock,
			},
			(event) => {
				events.push(event);
			},
		);
		instrumentation.install(app);
		app.get("*", (c) => {
			const device = c.req.header("X-Device") ?? "";
			const group = c.req.query("group_id") ?? "";
			if (device) instrumentation.verifiedGroupMember(c.req.raw, device, group);
			return Response.json({});
		});
		const get = (path: string, device = "") =>
			app.request(`https://coordinator.example.test${path}`, { headers: { "X-Device": device } });
		// Act
		await get("/v1/scopes/scope-b/members?group_id=group-b", "probe");
		await get("/v1/scopes/scope-a/members?group_id=group-b", "probe");
		await get("/v1/scopes?group_id=group-a", "peer");
		await get("/v1/scopes?group_id=group-a");
		await get("/v1/scopes?group_id=group-c", "probe");
		await get("/v1/peers?group_id=group-a", "probe");
		// Assert: unmatched paths and groups never reach the sink.
		expect(events.map(({ sample, fault }) => [sample?.groupId, sample?.cohort, fault])).toEqual([
			["group-b", "probe-server", false],
			["group-b", "real-client", false],
			["group-a", "real-client", false],
			[undefined, undefined, false],
		]);
	});
});
