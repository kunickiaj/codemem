import { expect, it, vi } from "vitest";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	type DeviceRemovalBackend,
	DeviceRemovalOperations,
	ENROLLMENT_REMOVAL_TRIGGER_NAMES,
} from "./coordinator-device-removal.js";
import { NODE_ONLY_ALIASES } from "./coordinator-ed25519-key-id-test-fixtures.js";

const flags = { entry: 0, revoked: 0, removed: 1, enrolled: 1, key_removed: 0, key_enrolled: 0 };
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

it("malformed key flags cost only the key evidence, never the legacy reply", async () => {
	const state = { available: 1, removal_seq: 3 };
	const legacy = { revoked: [], removed: ["asked"], enrolled: ["asked"], removal_seq: 3 };
	for (const row of [
		{ entry: 0, revoked: 0, removed: 1, enrolled: 1 },
		{ ...flags, key_enrolled: 2 },
		{ ...flags, key_removed: null },
	])
		expect(await operations(reads([state], [row])).lookupPeerRemovals(request)).toEqual({
			...legacy,
			key_evidence: { removed: [], enrolled: [] },
		});
});

it("only captured requested IDs and the five result fields are returned, with global duplicate-ID revocation precedence", async () => {
	const store = operations(
		reads(
			[{ available: 1, removal_seq: 7 }],
			[
				{ ...flags, device_id: "unrequested", public_key: "evidence", group_id: "group" },
				{ entry: 1, revoked: 1, removed: 1, enrolled: 0, key_removed: 1, key_enrolled: 0 },
				{ entry: 2, revoked: 0, removed: 1, enrolled: 0, key_removed: 0, key_enrolled: 0 },
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
	).toEqual({
		revoked: ["asked"],
		removed: ["a"],
		enrolled: ["asked"],
		removal_seq: 7,
		// "asked" is blocked, so the backend's key flag for it is not reported.
		key_evidence: { removed: [], enrolled: [] },
	});
});

it("counts an ID as enrolled by key only when it was sent with a key and every entry for it says so", async () => {
	const row = (entry: number, keyEnrolled: 0 | 1) => ({
		entry,
		revoked: 0,
		removed: 1,
		enrolled: 1,
		key_removed: 0,
		key_enrolled: keyEnrolled,
	});
	const lookup = (rows: unknown[], peers: { deviceId: string; publicKey?: string }[]) =>
		operations(reads([{ available: 1, removal_seq: 2 }], rows)).lookupPeerRemovals({ peers });

	expect(
		(await lookup([row(0, 1)], [{ deviceId: "kept", publicKey: "current" }])).key_evidence,
	).toEqual({ removed: [], enrolled: ["kept"] });
	expect(
		(
			await lookup(
				[row(0, 1), row(1, 0)],
				[
					{ deviceId: "mixed", publicKey: "current" },
					{ deviceId: "mixed", publicKey: "old" },
				],
			)
		).key_evidence,
	).toEqual({ removed: [], enrolled: [] });
	// A backend that claims a key match for a keyless entry is not believed.
	expect(
		(
			await lookup(
				[row(0, 1), row(1, 1)],
				[{ deviceId: "keyless", publicKey: "current" }, { deviceId: "keyless" }],
			)
		).key_evidence,
	).toEqual({ removed: [], enrolled: [] });
});

it("captures caller-owned entries before asynchronous key derivation and uses one two-read batch", async () => {
	const peers = [{ deviceId: "asked", publicKey: NODE_ONLY_ALIASES[0]?.publicKey ?? "opaque" }];
	let batches = 0;
	const store = operations(async (statements) => {
		batches++;
		expect(statements.map((statement) => statement.read)).toEqual([true, true]);
		expect(statements.map((statement) => statement.values.length)).toEqual([0, 1]);
		expect(JSON.parse(String(statements[1]?.values[0])).entries[0].deviceId).toBe("asked");
		return reads(
			[{ available: 1, removal_seq: 0 }],
			[{ entry: 0, revoked: 0, removed: 0, enrolled: 0, key_removed: 0, key_enrolled: 0 }],
		)();
	});
	const pending = store.lookupPeerRemovals({ peers });
	peers[0] = { deviceId: "changed", publicKey: "changed" };
	await expect(pending).resolves.toEqual({
		revoked: [],
		removed: [],
		enrolled: [],
		removal_seq: 0,
		key_evidence: { removed: [], enrolled: [] },
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
