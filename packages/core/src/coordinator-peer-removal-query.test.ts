import { expect, it, vi } from "vitest";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	type DeviceRemovalBackend,
	DeviceRemovalOperations,
	ENROLLMENT_REMOVAL_TRIGGER_NAMES,
} from "./coordinator-device-removal.js";
import { NODE_ONLY_ALIASES } from "./coordinator-ed25519-key-id-test-fixtures.js";

const flags = { entry: 0, revoked: 0, removed: 1, enrolled: 1 };
const reads = (states: unknown[], rows: unknown[]) => async () => [
	{ results: states },
	{ results: rows },
];
const operations = (batch: DeviceRemovalBackend["batch"]) =>
	new DeviceRemovalOperations({
		batch,
		all: async () => {
			throw new Error("Must batch");
		},
	});
const request = { peers: [{ deviceId: "asked" }] };

it("partial and malformed snapshots fail closed, including on an empty request", async () => {
	const state = { available: 1, removal_seq: 3 };
	const invalid = [
		reads([], [flags]),
		reads([state, state], [flags]),
		reads([{ ...state, available: 2 }], [flags]),
		reads([{ ...state, removal_seq: -1 }], [flags]),
		reads([{ ...state, removal_seq: Number.MAX_SAFE_INTEGER + 1 }], [flags]),
		reads([state], []),
		reads([state], [flags, flags]),
		reads([state], [{ ...flags, entry: 1 }]),
		reads([state], [{ ...flags, removed: true }]),
		reads([state], [{ entry: 0, revoked: 0, removed: 0 }]),
		async () => [{ results: [state] }],
		async () => [{ success: false, results: [state] }, { results: [flags] }],
		async () => {
			throw new Error("backend failure");
		},
	];
	for (const batch of invalid)
		await expect(operations(batch).lookupPeerRemovals(request)).rejects.toThrow(
			"device_removal_incomplete",
		);
	await expect(operations(reads([], [])).lookupPeerRemovals({ peers: [] })).rejects.toThrow(
		"device_removal_incomplete",
	);
	await expect(
		operations(reads([{ available: 0, removal_seq: 0 }], [])).lookupPeerRemovals({ peers: [] }),
	).rejects.toThrow("device_removal_unavailable");
});

it("only captured requested IDs and the four result fields are returned, with global duplicate-ID revocation precedence", async () => {
	const store = operations(
		reads(
			[{ available: 1, removal_seq: 7 }],
			[
				{ ...flags, device_id: "unrequested", public_key: "evidence", group_id: "group" },
				{ entry: 1, revoked: 1, removed: 1, enrolled: 0 },
				{ entry: 2, revoked: 0, removed: 1, enrolled: 0 },
			],
		),
	);
	expect(
		await store.lookupPeerRemovals({
			peers: [
				{ deviceId: "asked" },
				{ deviceId: "asked", publicKey: "another" },
				{ deviceId: "a" },
			],
		}),
	).toEqual({ revoked: ["asked"], removed: ["a"], enrolled: ["asked"], removal_seq: 7 });
});

it("captures caller-owned entries before asynchronous key derivation and uses one two-read batch", async () => {
	const peers = [{ deviceId: "asked", publicKey: NODE_ONLY_ALIASES[0]?.publicKey ?? "opaque" }];
	let batches = 0;
	const store = operations(async (statements) => {
		batches++;
		expect(statements.map((statement) => statement.read)).toEqual([true, true]);
		expect(statements.map((statement) => statement.values.length)).toEqual([0, 1]);
		expect(JSON.parse(String(statements[1]?.values[0]))[0].deviceId).toBe("asked");
		return reads(
			[{ available: 1, removal_seq: 0 }],
			[{ entry: 0, revoked: 0, removed: 0, enrolled: 0 }],
		)();
	});
	const pending = store.lookupPeerRemovals({ peers });
	peers[0] = { deviceId: "changed", publicKey: "changed" };
	await expect(pending).resolves.toEqual({
		revoked: [],
		removed: [],
		enrolled: [],
		removal_seq: 0,
	});
	expect(batches).toBe(1);
});

it.each(["SQLite", "D1"] as const)(
	"%s actual lookup uses exactly two reads and one JSON binding for 0, 1 and 25 entries",
	async (backend) => {
		const f = setupStore(backend);
		const prepare = vi.spyOn(f.db, "prepare");
		try {
			for (const count of [0, 1, 25]) {
				prepare.mockClear();
				await f.store.lookupPeerRemovals({
					peers: Array.from({ length: count }, (_, i) => ({ deviceId: `d${i}` })),
				});
				expect(prepare.mock.calls).toHaveLength(2);
				expect(prepare.mock.calls.map(([sql]) => sql.match(/\?/gu)?.length ?? 0)).toEqual([0, 1]);
			}
		} finally {
			prepare.mockRestore();
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	},
);

it.each(["SQLite", "D1"] as const)(
	"%s lookup refuses pre-0048 storage rather than reporting absence",
	async (backend) => {
		const f = setupStore(backend);
		try {
			for (const name of ENROLLMENT_REMOVAL_TRIGGER_NAMES) f.db.exec(`DROP TRIGGER ${name}`);
			f.db.exec(`DROP TABLE coordinator_device_removals;
			ALTER TABLE enrolled_devices DROP COLUMN key_id;
			ALTER TABLE coordinator_invites DROP COLUMN issued_after_removal_seq;
			ALTER TABLE coordinator_join_requests DROP COLUMN issued_after_removal_seq;`);
			await expect(f.store.lookupPeerRemovals({ peers: [] })).rejects.toThrow(
				"device_removal_unavailable",
			);
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	},
);
