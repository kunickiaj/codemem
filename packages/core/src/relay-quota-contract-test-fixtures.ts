import { describe, expect, it } from "vitest";
import {
	initializeRelayQuotaSchema,
	provisionLocalRelayQuota,
	type RelayQuotaDatabase,
	type RelayQuotaProfile,
	type SqliteRelayQuotaPort,
	setRelayQuotaEnabled,
} from "./relay-quota-sqlite.js";

type Binding = string | number;
type Row = Record<string, unknown>;

/** One live connection to durable quota storage, valid only inside `use`. */
export interface RelayQuotaContractStorage {
	readonly database: RelayQuotaDatabase;
	rows(sql: string, ...bindings: Binding[]): Row[];
	quota(options: { readonly realmId: string; readonly enabled?: boolean }): SqliteRelayQuotaPort;
}

/** A storage host: better-sqlite3 in Node, or a Durable Object's SQLite storage. */
export interface RelayQuotaContractHost {
	use<T>(operation: (storage: RelayQuotaContractStorage) => T | Promise<T>): Promise<T>;
	/** Drops every in-memory object (process restart or object eviction) and keeps storage. */
	restart(): Promise<void>;
}

export const relayQuotaRealmId = "a".repeat(64);
const realmId = relayQuotaRealmId;
const signal = () => new AbortController().signal;
const allocation = { ratePerMinute: 1, burst: 4 };
export const relayQuotaProfile: RelayQuotaProfile = {
	upgrade: { service: allocation, realm: allocation },
	control: { service: allocation, realm: allocation, device: allocation },
	open: {
		service: allocation,
		realm: allocation,
		device: allocation,
		pair: { ...allocation, burst: 2 },
	},
	traffic: { service: allocation, realm: allocation, device: allocation, pair: allocation },
};
const profile = relayQuotaProfile;
// A real clock may advance a few milliseconds between calls, and each one refills
// one fixed-point unit at rate 1. Cases stay far from the 60,000-unit token edge.
const MINUTE_MS = 60_000;

export function relayQuotaRequest(
	purpose: "control" | "open" | "traffic" = "traffic",
	units = 1,
	deviceId = "a",
	peerDeviceId = "b",
) {
	return {
		purpose,
		units,
		realmId,
		deviceId,
		peerDeviceId: purpose === "control" ? null : peerDeviceId,
	};
}
const request = relayQuotaRequest;

export function relayQuotaFixture(storage: RelayQuotaContractStorage, selected = profile): void {
	initializeRelayQuotaSchema(storage.database);
	provisionLocalRelayQuota(storage.database, { realmId, profile: selected });
	setRelayQuotaEnabled(storage.database, { realmId, enabled: true });
}

function client(host: RelayQuotaContractHost) {
	return {
		setup: (selected = profile) => host.use((storage) => relayQuotaFixture(storage, selected)),
		reserve: (selected = request(), options: { enabled?: boolean } = { enabled: true }) =>
			host.use((storage) => storage.quota({ realmId, ...options }).reserve(selected, signal())),
		upgrade: () =>
			host.use((storage) => storage.quota({ realmId, enabled: true }).reserveUpgrade(signal())),
		sql: (sql: string, ...bindings: Binding[]) =>
			host.use((storage) => {
				storage.database.prepare(sql).run(...bindings);
			}),
		rows: (sql: string, ...bindings: Binding[]) =>
			host.use((storage) => storage.rows(sql, ...bindings)),
		buckets: () =>
			host.use((storage) =>
				storage.rows("SELECT * FROM relay_quota_buckets ORDER BY purpose,scope,subject"),
			),
		switch: (enabled: boolean) =>
			host.use((storage) => setRelayQuotaEnabled(storage.database, { realmId, enabled })),
		/** Moves every bucket's last refill into the past, as if time elapsed. */
		elapse: (ms: number) =>
			host.use((storage) => {
				storage.database
					.prepare("UPDATE relay_quota_buckets SET refilled_at_ms = refilled_at_ms - ?")
					.run(ms);
			}),
	};
}

/** Exhausted buckets hold under one unit; a real clock may refill a few fixed-point units. */
async function expectEveryBalanceBelowOneUnit(quota: ReturnType<typeof client>): Promise<void> {
	const balances = (await quota.rows("SELECT balance FROM relay_quota_buckets")).map(
		(row) => row.balance,
	);
	expect(balances).toHaveLength(5);
	for (const balance of balances) expect(balance).toBeLessThan(60000);
}

async function expectOnlyQuotaTables(quota: ReturnType<typeof client>): Promise<void> {
	expect(
		await quota.rows(
			"SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'relay_quota%' ORDER BY name",
		),
	).toEqual([
		{ name: "relay_quota_allocations" },
		{ name: "relay_quota_buckets" },
		{ name: "relay_quota_root" },
	]);
	expect(await quota.rows("SELECT name FROM pragma_table_info('relay_quota_buckets')")).toEqual(
		["purpose", "scope", "subject", "balance", "refilled_at_ms", "last_rate", "last_capacity"].map(
			(name) => ({ name }),
		),
	);
}

function registerSwitchCases(createHost: () => Promise<RelayQuotaContractHost>): void {
	describe("relay quota switches and fail-closed state", () => {
		it("installs only inert quota metadata and requires both explicit switches", async () => {
			// Arrange
			const host = await createHost();
			const quota = client(host);
			await host.use(({ database }) => {
				initializeRelayQuotaSchema(database);
				provisionLocalRelayQuota(database, { realmId, profile });
			});
			// Act
			const disabled = await quota.reserve();
			await quota.switch(true);
			const defaultAdapter = await quota.reserve(request(), {});
			// Assert
			expect(disabled).toBe("denied");
			expect(defaultAdapter).toBe("denied");
			expect(await quota.reserve()).toBe("reserved");
			await expectOnlyQuotaTables(quota);
		});

		it.each(["absent schema", "absent root", "zero profile", "missing allocation"])(
			"fails closed for %s",
			async (state) => {
				// Arrange
				const host = await createHost();
				const quota = client(host);
				await host.use((storage) => {
					if (state !== "absent schema") initializeRelayQuotaSchema(storage.database);
					if (state === "zero profile") {
						provisionLocalRelayQuota(storage.database, { realmId });
						setRelayQuotaEnabled(storage.database, { realmId, enabled: true });
					}
					if (state !== "missing allocation") return;
					relayQuotaFixture(storage);
					storage.database.prepare("DELETE FROM relay_quota_allocations WHERE scope='pair'").run();
				});
				// Act
				const result = await quota.reserve();
				// Assert: unavailable storage is unknown, never permission to send.
				expect(result).toBe(state === "absent schema" ? "unknown" : "denied");
				if (state !== "absent schema") expect(await quota.buckets()).toEqual([]);
			},
		);

		it("checks protection on each reservation after a live adapter loses a trigger", async () => {
			// Arrange
			const host = await createHost();
			const quota = client(host);
			await quota.setup();
			expect(await quota.reserve()).toBe("reserved");
			const snapshot = await quota.buckets();
			await host.use(({ database }) => database.exec("DROP TRIGGER relay_quota_policy_update"));
			// Act
			const unprotected = await quota.reserve();
			const unchanged = await quota.buckets();
			await host.use(({ database }) => initializeRelayQuotaSchema(database));
			const repaired = await quota.reserve();
			// Assert
			expect(unprotected).toBe("unknown");
			expect(unchanged).toEqual(snapshot);
			expect(repaired).toBe("reserved");
		});
	});
}

function registerChargeCases(createHost: () => Promise<RelayQuotaContractHost>): void {
	describe("relay quota charges and intersections", () => {
		it.each(["upgrade", "control", "open", "traffic"] as const)(
			"charges whole bursts for %s",
			async (purpose) => {
				// Arrange
				const host = await createHost();
				const quota = client(host);
				await quota.setup();
				const burst = purpose === "open" ? 2 : 4;
				const reserve = () =>
					purpose === "upgrade" ? quota.upgrade() : quota.reserve(request(purpose));
				// Act
				const results = [];
				for (let index = 0; index < burst; index++) results.push(await reserve());
				const snapshot = await quota.buckets();
				const exhausted = await reserve();
				// Assert
				expect(results).toEqual(Array(burst).fill("reserved"));
				expect(exhausted).toBe("denied");
				expect(await quota.buckets()).toEqual(snapshot);
			},
		);

		it.each(["service", "realm", "source", "target", "pair"] as const)(
			"intersects %s capacity and rolls back earlier charges",
			async (limited) => {
				// Arrange
				const host = await createHost();
				const quota = client(host);
				await quota.setup();
				expect(await quota.reserve(request("traffic", 1))).toBe("reserved");
				const scope = limited === "source" || limited === "target" ? "device" : limited;
				const subject = { service: "", realm: "", source: "a", target: "b", pair: '["a","b"]' }[
					limited
				];
				await quota.sql(
					"UPDATE relay_quota_buckets SET balance=0 WHERE scope=? AND subject=?",
					scope,
					subject,
				);
				const snapshot = await quota.buckets();
				// Act: reverse participants to prove pair keys are unordered and both devices count.
				const result = await quota.reserve(request("traffic", 1, "b", "a"));
				// Assert
				expect(result).toBe("denied");
				expect(await quota.buckets()).toEqual(snapshot);
			},
		);
	});
}

function registerRefillCases(createHost: () => Promise<RelayQuotaContractHost>): void {
	describe("relay quota parent capacity and refill", () => {
		it.each(["service", "realm"])(
			"does not multiply %s capacity across fresh devices and pairs",
			async (scope) => {
				// Arrange
				const host = await createHost();
				const quota = client(host);
				await quota.setup({
					...profile,
					traffic: { ...profile.traffic, [scope]: { ...allocation, burst: 1 } },
				});
				// Act
				const first = await quota.reserve();
				const freshPair = await quota.reserve(request("traffic", 1, "c", "d"));
				// Assert
				expect(first).toBe("reserved");
				expect(freshPair).toBe("denied");
			},
		);

		it("refills at the allocated rate and never above the burst", async () => {
			// Arrange
			const host = await createHost();
			const quota = client(host);
			await quota.setup();
			expect(await quota.reserve(request("traffic", 4))).toBe("reserved");
			// Act
			await quota.elapse(MINUTE_MS / 2);
			const halfMinute = await quota.reserve();
			await quota.elapse(MINUTE_MS / 2);
			const oneMinute = await quota.reserve();
			await quota.elapse(MINUTE_MS * 60);
			const settled = await quota.reserve(request("traffic", 4));
			const overBurst = await quota.reserve();
			// Assert
			expect([halfMinute, oneMinute, settled, overBurst]).toEqual([
				"denied",
				"reserved",
				"reserved",
				"denied",
			]);
		});

		it("denies a database clock rollback without changing any bucket", async () => {
			// Arrange
			const host = await createHost();
			const quota = client(host);
			await quota.setup();
			expect(await quota.reserve()).toBe("reserved");
			await quota.sql(
				"UPDATE relay_quota_buckets SET refilled_at_ms=refilled_at_ms+? WHERE scope='pair'",
				MINUTE_MS,
			);
			const snapshot = await quota.buckets();
			// Act
			const result = await quota.reserve();
			// Assert
			expect(result).toBe("denied");
			expect(await quota.buckets()).toEqual(snapshot);
		});
	});
}

function registerFloorCases(createHost: () => Promise<RelayQuotaContractHost>): void {
	describe("relay quota floors after policy changes", () => {
		it("retains tightening after an oversized denial and an enable pause", async () => {
			// Arrange
			const host = await createHost();
			const quota = client(host);
			await quota.setup();
			await quota.sql("UPDATE relay_quota_allocations SET rate=2 WHERE purpose='traffic'");
			expect(await quota.reserve()).toBe("reserved");
			// Act: rejection before the bucket upsert must not erase the policy minimum.
			await quota.sql("UPDATE relay_quota_allocations SET rate=1,burst=1 WHERE purpose='traffic'");
			const oversized = await quota.reserve(request("traffic", 2));
			await quota.sql("UPDATE relay_quota_allocations SET rate=2,burst=4 WHERE purpose='traffic'");
			await quota.switch(false);
			const paused = await quota.reserve();
			await quota.switch(true);
			const restored = await quota.reserve(request("traffic", 3));
			// Assert
			expect({
				oversized,
				paused,
				restored,
				floors: await quota.rows(
					"SELECT DISTINCT last_rate,last_capacity FROM relay_quota_buckets",
				),
			}).toEqual({
				oversized: "denied",
				paused: "denied",
				restored: "denied",
				floors: [{ last_rate: 1, last_capacity: 60000 }],
			});
		});

		it("resumes after a zero allocation without exceeding the prior positive minimum", async () => {
			// Arrange
			const host = await createHost();
			const quota = client(host);
			await quota.setup();
			await quota.sql("UPDATE relay_quota_allocations SET rate=2 WHERE purpose='traffic'");
			expect(await quota.reserve()).toBe("reserved");
			await quota.sql("UPDATE relay_quota_allocations SET rate=1,burst=1 WHERE purpose='traffic'");
			// Act
			await quota.sql("UPDATE relay_quota_allocations SET rate=0,burst=0 WHERE purpose='traffic'");
			const disabled = await quota.reserve();
			await quota.sql("UPDATE relay_quota_allocations SET rate=2,burst=4 WHERE purpose='traffic'");
			const resumed = await quota.reserve();
			const exhausted = await quota.reserve();
			// Assert: zero disables access, while only positive policy values reduce historical capacity.
			expect({ disabled, resumed, exhausted }).toEqual({
				disabled: "denied",
				resumed: "reserved",
				exhausted: "denied",
			});
			expect(
				await quota.rows("SELECT DISTINCT last_rate,last_capacity FROM relay_quota_buckets"),
			).toEqual([{ last_rate: 1, last_capacity: 60000 }]);
			await expectEveryBalanceBelowOneUnit(quota);
		});
	});
}

function registerRaisedFloorCases(createHost: () => Promise<RelayQuotaContractHost>): void {
	describe("relay quota floors after raising policy", () => {
		it("retains historical minimum rate and capacity when a lowered profile is raised again", async () => {
			// Arrange
			const host = await createHost();
			const quota = client(host);
			await quota.setup();
			await quota.sql("UPDATE relay_quota_allocations SET rate=2 WHERE purpose='traffic'");
			expect(await quota.reserve()).toBe("reserved");
			await quota.sql("UPDATE relay_quota_allocations SET burst=2,rate=1 WHERE purpose='traffic'");
			// Act
			const lowered = await quota.reserve();
			await quota.sql("UPDATE relay_quota_allocations SET burst=4,rate=2 WHERE purpose='traffic'");
			const remaining = await quota.reserve();
			const exhausted = await quota.reserve();
			// Assert
			expect([lowered, remaining, exhausted]).toEqual(["reserved", "reserved", "denied"]);
			expect(
				await quota.rows("SELECT DISTINCT last_rate,last_capacity FROM relay_quota_buckets"),
			).toEqual([{ last_rate: 1, last_capacity: 120000 }]);
			await expectEveryBalanceBelowOneUnit(quota);
		});
	});
}

function registerRestartCases(createHost: () => Promise<RelayQuotaContractHost>): void {
	describe("relay quota durability", () => {
		it("keeps consumed buckets after restart, switching and rejected reprovision", async () => {
			// Arrange
			const host = await createHost();
			const quota = client(host);
			await quota.setup();
			expect(await quota.reserve(request("traffic", 4))).toBe("reserved");
			const snapshot = await quota.buckets();
			// Act
			await host.restart();
			await quota.switch(false);
			const disabled = await quota.reserve();
			await quota.switch(true);
			const reprovision = await host.use(({ database }) => {
				try {
					provisionLocalRelayQuota(database, { realmId, profile });
					return "provisioned";
				} catch {
					return "rejected";
				}
			});
			await host.restart();
			const reversed = await quota.reserve(request("traffic", 1, "b", "a"));
			// Assert
			expect({ disabled, reprovision, reversed }).toEqual({
				disabled: "denied",
				reprovision: "rejected",
				reversed: "denied",
			});
			expect(await quota.buckets()).toEqual(snapshot);
		});
	});
}

/** Behavior every relay quota storage host must share. Hosts must start empty per call. */
export function registerRelayQuotaContract(
	createHost: () => Promise<RelayQuotaContractHost>,
): void {
	registerSwitchCases(createHost);
	registerChargeCases(createHost);
	registerRefillCases(createHost);
	registerFloorCases(createHost);
	registerRaisedFloorCases(createHost);
	registerRestartCases(createHost);
}
