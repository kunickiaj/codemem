import { expect, it } from "vitest";
import {
	type DeviceRemovalBackend,
	DeviceRemovalOperations,
} from "./coordinator-device-removal.js";
import {
	captureRemovalDeviceIds,
	deviceRemovalDigest,
	type RemovalTargetState,
} from "./coordinator-device-removal-target.js";

const STATE: RemovalTargetState = {
	available: 1,
	named: 1,
	canonical_keys: 0,
	opaque_texts: 1,
	targets: 1,
	bound: 0,
};
const ROW = {
	group_id: "g1",
	device_id: "d1",
	public_key: "opaque",
	fingerprint: "fp",
	key_id: "",
	display_name: null,
	identity_id: null,
};

/** A backend whose batch answers with these results, whatever the statements. */
function preview(batch: () => Promise<unknown[]>) {
	const backend: DeviceRemovalBackend = { batch, all: async () => ({ results: [] }) };
	return new DeviceRemovalOperations(backend)
		.previewDeviceRemoval({ deviceIds: ["d1"] })
		.catch((error: Error) => error.message);
}
const reads = (state: unknown, rows: unknown[]) => async () => [
	{ results: state === undefined ? [] : [state] },
	{ results: rows },
];

it("reports reads that do not describe one consistent target set as device_removal_incomplete", async () => {
	// Arrange: each answer is malformed in one way.
	const malformed = [
		async () => [{ results: [STATE] }],
		reads(undefined, [ROW]),
		reads({ ...STATE, available: 2 }, [ROW]),
		reads({ ...STATE, targets: "1" }, [ROW]),
		reads(STATE, []),
		reads(STATE, [{ ...ROW, public_key: null }]),
		reads({ ...STATE, canonical_keys: 1, opaque_texts: 0 }, [ROW]),
		async () => [{ success: false, results: [STATE] }, { results: [ROW] }],
		async () => {
			throw new Error("backend failure");
		},
	];
	// Act
	const outcomes = await Promise.all(malformed.map(preview));
	const complete = await preview(reads(STATE, [ROW]));
	const unavailable = await preview(reads({ ...STATE, available: 0 }, []));
	// Assert
	expect(outcomes).toEqual(malformed.map(() => "device_removal_incomplete"));
	expect(complete).toMatchObject({ kind: "ready", key_id: null, rejoin: "invitation" });
	expect(unavailable).toBe("device_removal_unavailable");
});

it("sorts device IDs and tuples by code unit, so both stores bind the same digest", async () => {
	// Arrange: an astral character sorts after U+FFFF as UTF-8 bytes and before it as code units.
	const ids = captureRemovalDeviceIds({ deviceIds: ["\uffff", "\u{1f600}", "a", "a"] });
	// Act
	const digest = await deviceRemovalDigest({ deviceIds: ids, keyId: null, tuples: [] });
	// Assert: the value is fixed, so a change of the domain or the encoding shows here.
	expect(ids).toEqual(["a", "\u{1f600}", "\uffff"]);
	expect(digest).toBe("a4e0eb116892f6b97a5e50c4a24f88efd8f1da92c366a99e3ca3bdc4c824e122");
});
