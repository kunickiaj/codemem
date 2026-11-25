import { expect, it, vi } from "vitest";
import { coordinatorListRemovedDevicesAction } from "./coordinator-actions.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	type DeviceRemovalBackend,
	DeviceRemovalOperations,
	ENROLLMENT_REMOVAL_TRIGGER_NAMES,
} from "./coordinator-device-removal.js";
import { parseDeviceRemovalListPage } from "./coordinator-device-removal-list.js";

const ROW = {
	removal_id: "r1",
	removal_seq: 3,
	group_id: "g1",
	device_id: "d1",
	fingerprint: "fp",
	key_id: null,
	display_name: null,
	identity_id: null,
	removed_at: "then",
	revoked: 0,
};
const reads = (state: unknown, rows: unknown[]) => async () => [
	{ results: state === undefined ? [] : [state] },
	{ results: rows },
];
const operations = (batch: DeviceRemovalBackend["batch"]) =>
	new DeviceRemovalOperations({
		batch,
		all: async () => {
			throw new Error("Must use one batch");
		},
	});

it("listing backend errors and inconsistent results become device_removal_incomplete", async () => {
	const malformed = [
		async () => [],
		reads(undefined, [ROW]),
		reads({ available: 2 }, [ROW]),
		reads({ available: 1 }, [{ ...ROW, removed_at: null }]),
		reads({ available: 1 }, [{ ...ROW, removal_seq: 0 }]),
		reads({ available: 1 }, [{ ...ROW, revoked: 2 }]),
		reads({ available: 1 }, [{ ...ROW, revoked: 1 }]),
		reads({ available: 1 }, [ROW, ROW]),
		reads({ available: 1 }, [{ ...ROW, removal_seq: 4 }]),
		async () => [{ success: false, results: [{ available: 1 }] }, { results: [ROW] }],
		async () => {
			throw new Error("backend failure");
		},
	];
	for (const batch of malformed)
		await expect(operations(batch).listDeviceRemovals({ beforeSeq: 4 })).rejects.toThrow(
			"device_removal_incomplete",
		);
	await expect(operations(reads({ available: 0 }, [])).listDeviceRemovals()).rejects.toThrow(
		"device_removal_unavailable",
	);
});

it("listing captures options and reads readiness plus one extra matching row in a single batch", async () => {
	const options = { beforeSeq: 4, deviceId: "d1", limit: 2, includeBlocked: false };
	const calls: unknown[] = [];
	const store = operations(async (statements) => {
		calls.push(statements);
		expect(statements.map((statement) => statement.read)).toEqual([true, true]);
		expect(statements[0]?.sql).toContain("AS available");
		expect(statements[1]?.values).toEqual([4, "d1", 3]);
		options.beforeSeq = 0;
		return reads({ available: 1 }, [ROW, { ...ROW, removal_seq: 2 }, { ...ROW, removal_seq: 1 }])();
	});
	const page = await store.listDeviceRemovals(options);
	expect(calls).toHaveLength(1);
	const { revoked: _, ...item } = ROW;
	expect(page).toEqual({ items: [item, { ...item, removal_seq: 2 }], next_before_seq: 2 });
});

it("listing never returns extra backend columns, including public_key or a false revoked flag", async () => {
	const page = await operations(
		reads({ available: 1 }, [{ ...ROW, public_key: "private listing field" }]),
	).listDeviceRemovals({ includeBlocked: true });
	const { revoked: _, ...item } = ROW;
	expect(page).toEqual({ items: [item], next_before_seq: null });
});

it("reads a blocked removal from the coordinator when explicitly requested", async () => {
	const item = { ...ROW, revoked: true };
	const page = { version: 1, items: [item], next_before_seq: null };
	const fetchPage = vi.fn(async () => Response.json(page));
	vi.stubGlobal("fetch", fetchPage);
	try {
		await expect(
			coordinatorListRemovedDevicesAction({
				includeBlocked: true,
				remote: { url: "https://coordinator.example.invalid", adminSecret: "test-secret" },
			}),
		).resolves.toEqual([item]);
		expect(fetchPage).toHaveBeenCalledWith(
			"https://coordinator.example.invalid/v1/admin/devices/removals?include_blocked=1",
			expect.objectContaining({ method: "GET" }),
		);
	} finally {
		vi.unstubAllGlobals();
	}
	expect(() => parseDeviceRemovalListPage(page)).toThrow("coordinator_removal_list_malformed");
	expect(() =>
		parseDeviceRemovalListPage({ ...page, items: [{ ...item, revoked: false }] }, undefined, {
			includeBlocked: true,
		}),
	).toThrow("coordinator_removal_list_malformed");
});

it.each(["SQLite", "D1"] as const)(
	"D6 %s listing is unavailable on pre-0048 storage",
	async (backend) => {
		const f = setupStore(backend);
		try {
			for (const name of ENROLLMENT_REMOVAL_TRIGGER_NAMES) f.db.exec(`DROP TRIGGER ${name}`);
			f.db.exec(`DROP TABLE coordinator_device_removals;
			ALTER TABLE enrolled_devices DROP COLUMN key_id;
			ALTER TABLE coordinator_invites DROP COLUMN issued_after_removal_seq;
			ALTER TABLE coordinator_join_requests DROP COLUMN issued_after_removal_seq;`);
			await expect(f.store.listDeviceRemovals()).rejects.toThrow("device_removal_unavailable");
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	},
);
