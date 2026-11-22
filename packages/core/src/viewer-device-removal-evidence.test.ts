import { expect, test } from "vitest";
import type { CoordinatorDeviceRemovalListItem } from "./coordinator-device-removal-list.js";
import {
	readViewerRemovalPreview,
	readViewerRemovalReceipt,
	recoverViewerRemoval,
	type ViewerRemovalPreview,
} from "./viewer-device-removal-evidence.js";

const preview: ViewerRemovalPreview = {
	kind: "ready",
	device_ids: ["device-a"],
	key_id: "a".repeat(64),
	expected_digest: "b".repeat(64),
	rejoin: "invitation",
	enrollments: ["group-a", "group-b"].map((group_id) => ({
		group_id,
		device_id: "device-a",
		fingerprint: "fingerprint",
		display_name: null,
		identity_id: null,
	})),
};
const payload = { ...preview, version: 1, state: "ready" };
const input = { deviceIds: ["device-a"], expectedDigest: preview.expected_digest };
const receipt = {
	version: 1,
	state: "removed",
	removal_id: "removal-a",
	removal_seq: 9,
	device_ids: preview.device_ids,
	key_id: preview.key_id,
	removals: preview.enrollments.map((row, i) => ({ ...row, removal_seq: 8 + i })),
};
const rows: CoordinatorDeviceRemovalListItem[] = receipt.removals.map((row) => ({
	...row,
	removal_id: receipt.removal_id,
	key_id: preview.key_id,
	removed_at: "unused",
}));

test("reads ready previews and exact receipts, independently of entry order", () => {
	expect(readViewerRemovalPreview(payload, input)).toEqual(preview);
	expect(
		readViewerRemovalReceipt({ ...receipt, removals: [...receipt.removals].reverse() }, preview),
	).toEqual({ removalId: "removal-a", removalSeq: 9, source: "receipt" });
});

test("allows requested local aliases without requiring their enrollment", () => {
	const deviceIds = ["device-a", "local-alias"];
	expect(
		readViewerRemovalPreview({ ...payload, device_ids: deviceIds }, { ...input, deviceIds }),
	).toEqual({ ...preview, device_ids: deviceIds });
});

test.each([
	{ version: 2 },
	{ state: "removed" },
	{ expected_digest: "c".repeat(64) },
	{ device_ids: ["other"] },
	{ device_ids: ["device-a", "device-a"] },
	{ key_id: "" },
	{ rejoin: "unknown" },
	{ rejoin: { toString: () => "invitation" } },
	{ enrollments: [] },
	{ enrollments: [preview.enrollments[0], preview.enrollments[0]] },
	{ enrollments: [{ ...preview.enrollments[0], fingerprint: "" }] },
	{
		enrollments: Array.from({ length: 51 }, (_, i) => ({
			...preview.enrollments[0],
			group_id: `group-${i}`,
		})),
	},
])("rejects malformed preview %#", (change) => {
	expect(readViewerRemovalPreview({ ...payload, ...change }, input)).toBeNull();
});

test.each([
	{ version: 2 },
	{ state: "ready" },
	{ removal_id: "" },
	{ removal_seq: 8 },
	{ device_ids: ["other"] },
	{ key_id: null },
	{ removals: [] },
	{ removals: [...receipt.removals, receipt.removals[0]] },
	{ removals: [receipt.removals[0], receipt.removals[0]] },
	{ removals: receipt.removals.map((row) => ({ ...row, removal_seq: 8 })) },
	{
		removals: receipt.removals.map((row) => ({ ...row, removal_seq: Number.MAX_SAFE_INTEGER + 1 })),
	},
	{ removals: receipt.removals.map((row) => ({ ...row, removal_seq: 0 })) },
])("rejects malformed receipt %#", (change) => {
	expect(readViewerRemovalReceipt({ ...receipt, ...change }, preview)).toBeNull();
});

test("recovers matching removed state without using timestamps", () => {
	expect(recoverViewerRemoval(rows, preview)).toEqual({
		removalId: "removal-a",
		removalSeq: 9,
		source: "listing",
	});
});

test.each(
	[
		rows.slice(1),
		[...rows, rows[0]],
		rows.map((row, i) => ({ ...row, removal_id: `removal-${i}` })),
		rows.map((row) => ({ ...row, key_id: null })),
		rows.map((row) => ({ ...row, fingerprint: "other" })),
		rows.map((row) => ({ ...row, removal_seq: 8 })),
		rows.map((row) => ({ ...row, revoked: true as const })),
		[...rows, { ...rows[0], group_id: "extra" }],
	].map((batch) => ({ batch })),
)("rejects incomplete or mismatched listing batch %#", ({ batch }) => {
	expect(recoverViewerRemoval(batch, preview)).toBeNull();
});

test("does not combine batches and can skip an unrelated batch", () => {
	const unrelated = { ...rows[0], removal_id: "other", device_id: "other" };
	expect(recoverViewerRemoval([unrelated, ...rows], preview)).toEqual({
		removalId: "removal-a",
		removalSeq: 9,
		source: "listing",
	});
});
