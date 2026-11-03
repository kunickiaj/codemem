import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBetterSqliteCoordinatorApp } from "./better-sqlite-coordinator-runtime.js";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "./relay-admission-metadata-schema.js";
import { METADATA_CONTEXT, metadataSeed } from "./relay-admission-metadata-test-fixtures.js";
import type { RelayHealthMonitor } from "./relay-health.js";
import { healthFixture } from "./relay-health-test-fixtures.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

let directory: string;
let dbPath: string;
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "relay-health-runtime-"));
	dbPath = join(directory, "coordinator.sqlite");
	const store = new BetterSqliteCoordinatorStore(dbPath);
	try {
		await store.createGroup("group-a");
		await store.createScope({
			scopeId: "scope-a",
			groupId: "group-a",
			coordinatorId: "server-a",
			label: "Health fixture",
			membershipEpoch: 3,
		});
		await store.enrollDevice("group-a", {
			deviceId: "device-a",
			publicKey: CANONICAL_PUBLIC_KEY,
			fingerprint: fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
		});
		await store.grantScopeMembership({
			scopeId: "scope-a",
			deviceId: "device-a",
			effectId: "health-fixture-member",
			membershipEpoch: 3,
		});
		for (const sql of RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS) store.db.exec(sql);
		for (const { sql, values } of metadataSeed({
			group: "group-a",
			authorityState: "tripped",
			healthState: "tripped",
			authorityObserved: null,
			realmObserved: null,
		})) {
			store.db
				.prepare(sql)
				.run(Object.fromEntries(values.map((value, index) => [index + 1, value])));
		}
	} finally {
		store.close();
	}
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

function setup(enabled = true) {
	const f = healthFixture();
	vi.spyOn(Date, "now").mockImplementation(f.now);
	vi.spyOn(performance, "now").mockImplementation(f.now);
	let monitor: RelayHealthMonitor | undefined;
	const statuses: number[] = [];
	const app = createBetterSqliteCoordinatorApp({
		dbPath,
		runtime: { now: () => new Date(f.now()).toISOString(), adminSecret: () => null },
		relayHealth: enabled
			? {
					...f.options,
					enabled: true,
					authorityId: METADATA_CONTEXT.authority,
					onMonitor: (value) => {
						monitor = value;
					},
				}
			: undefined,
	});
	f.fetcher.mockImplementation(async (url, init) => {
		const response = await app.request(String(url), init);
		statuses.push(response.status);
		return response;
	});
	return { ...f, app, monitor, statuses };
}

describe("relay health through the SQLite coordinator factory", () => {
	it("recovers from real v2-authenticated catalogue and member routes and publishes both rows", async () => {
		// Arrange: no fixture calls the monitor's verifiedGroupMember hook.
		const f = setup();
		if (!f.monitor) throw new Error("missing configured monitor");
		const initial = f.monitor.snapshot();
		// Act
		for (let now = 120000; now <= 480000; now += 30000) {
			f.setNow(now);
			await f.monitor.runProbeCycle();
		}
		const snapshot = f.monitor.snapshot();
		const store = new BetterSqliteCoordinatorStore(dbPath, { existingOnly: true });
		let rows: unknown[];
		try {
			rows = store.db
				.prepare(
					"SELECT scope,revision,state,observed_at_ms FROM relay_admission_readiness ORDER BY scope",
				)
				.all();
		} finally {
			store.close();
		}
		// Assert: ready requires both server cohorts and both client cohorts.
		expect(initial.state).toBe("tripped");
		expect(f.statuses).toHaveLength(26);
		expect(f.statuses.every((status) => status === 200)).toBe(true);
		expect(snapshot).toMatchObject({
			state: "ready",
			healthyWindows: 5,
			observedAtMs: 480000,
			validUntilMs: 530000,
		});
		expect(rows).toEqual(
			["authority", "realm"].map((scope) => ({
				scope,
				revision: snapshot.revision,
				state: "ready",
				observed_at_ms: 480000,
			})),
		);
	});
	it("does not count unknown devices or invalid signatures as server successes", async () => {
		// Arrange
		const f = setup();
		if (!f.monitor) throw new Error("missing configured monitor");
		const statuses: number[] = [];
		// Act
		for (const path of [
			"/v1/scopes?group_id=group-a",
			"/v1/scopes/scope-a/members?group_id=group-a",
		]) {
			for (const fault of ["device", "signature"]) {
				const url = `https://coordinator.example.test${path}`;
				const headers = await f.signer({ url, method: "GET", body: new Uint8Array() });
				if (fault === "device") headers.set("X-Opencode-Device", "unknown-device");
				else headers.set("X-Opencode-Signature", `v2:${Buffer.alloc(64).toString("base64")}`);
				statuses.push((await f.app.request(url, { headers })).status);
			}
		}
		// Assert
		expect(statuses.every((status) => status === 401 || status === 403)).toBe(true);
		expect(f.monitor.snapshot()).toMatchObject({
			state: "tripped",
			samples: 0,
			observedAtMs: null,
		});
	});
});

describe("relay health rate-limit isolation and default-off routes", () => {
	it("keeps ready health and authenticated probes after anonymous reads exhaust their own bucket", async () => {
		// Arrange
		const f = setup();
		if (!f.monitor) throw new Error("missing configured monitor");
		for (let now = 120000; now <= 480000; now += 30000) {
			f.setNow(now);
			await f.monitor.runProbeCycle();
		}
		const before = f.monitor.snapshot();
		const statuses: number[] = [];
		// Act
		for (let i = 0; i < 21; i++) {
			statuses.push(
				(await f.app.request("https://coordinator.example.test/v1/scopes?group_id=group-a")).status,
			);
		}
		const afterFlood = f.monitor.snapshot();
		f.setNow(510000);
		await f.monitor.runProbeCycle();
		// Assert
		expect(before.state).toBe("ready");
		expect(statuses.slice(0, 20)).toEqual(Array(20).fill(401));
		expect(statuses[20]).toBe(429);
		expect(afterFlood).toMatchObject({ state: "ready", samples: before.samples });
		expect(f.statuses.slice(-2)).toEqual([200, 200]);
		expect(f.monitor.snapshot().state).toBe("ready");
	});
	it("keeps the normal authenticated routes working when health monitoring is omitted", async () => {
		// Arrange
		const f = setup(false);
		// Act
		const responses = [];
		for (const path of [
			"/v1/scopes?group_id=group-a",
			"/v1/scopes/scope-a/members?group_id=group-a",
		]) {
			const url = `https://coordinator.example.test${path}`;
			responses.push(
				await f.app.request(url, {
					headers: await f.signer({ url, method: "GET", body: new Uint8Array() }),
				}),
			);
		}
		// Assert
		expect(f.monitor).toBeUndefined();
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		expect(await responses[0]?.json()).toMatchObject({
			version: 1,
			items: [{ scope_id: "scope-a" }],
		});
		expect(await responses[1]?.json()).toMatchObject({
			authorization_version: 1,
			scope: { scope_id: "scope-a" },
		});
	});
});
