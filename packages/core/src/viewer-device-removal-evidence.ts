import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorDeviceRemovalListItem } from "./coordinator-device-removal-list.js";
import {
	type CoordinatorDeviceRemovalEnrollment,
	type CoordinatorDeviceRemovalPreviewResult,
	DEVICE_REMOVAL_MAX_DEVICE_IDS,
	DEVICE_REMOVAL_MAX_ENROLLMENTS,
} from "./coordinator-device-removal-target.js";

export type ViewerRemovalPreview = Extract<
	CoordinatorDeviceRemovalPreviewResult,
	{ kind: "ready" }
>;

export interface ViewerRemovalEvidence {
	removalId: string;
	removalSeq: number;
	source: "receipt" | "listing";
}

const HEX_DIGEST = /^[a-f0-9]{64}$/u;

function record(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function normalizedIds(value: unknown): string[] | null {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > DEVICE_REMOVAL_MAX_DEVICE_IDS ||
		!value.every(isAuthControllerId)
	)
		return null;
	return [...new Set(value as string[])].sort();
}

function matchesIds(value: unknown, expected: readonly string[]): boolean {
	const ids = normalizedIds(value);
	return (
		ids !== null &&
		ids.length === (value as unknown[]).length &&
		JSON.stringify(ids) === JSON.stringify([...new Set(expected)].sort())
	);
}

function pair(row: { group_id: string; device_id: string }): string {
	return JSON.stringify([row.group_id, row.device_id]);
}

function readEnrollment(value: unknown): CoordinatorDeviceRemovalEnrollment | null {
	const row = record(value);
	if (
		!row ||
		!isAuthControllerId(row.group_id) ||
		!isAuthControllerId(row.device_id) ||
		!isAuthControllerId(row.fingerprint) ||
		!(row.display_name === null || typeof row.display_name === "string") ||
		!(row.identity_id === null || isAuthControllerId(row.identity_id))
	)
		return null;
	return {
		group_id: row.group_id,
		device_id: row.device_id,
		fingerprint: row.fingerprint,
		display_name: row.display_name,
		identity_id: row.identity_id,
	};
}

export function readViewerRemovalPreview(
	payload: Record<string, unknown> | null,
	input: { deviceIds: string[]; expectedDigest: string },
): ViewerRemovalPreview | null {
	const ids = normalizedIds(input.deviceIds);
	if (
		payload?.version !== 1 ||
		payload.state !== "ready" ||
		!ids ||
		!HEX_DIGEST.test(input.expectedDigest) ||
		payload.expected_digest !== input.expectedDigest ||
		!matchesIds(payload.device_ids, ids) ||
		!(
			payload.key_id === null ||
			(typeof payload.key_id === "string" && HEX_DIGEST.test(payload.key_id))
		) ||
		!(
			payload.rejoin === "invitation" ||
			payload.rejoin === "sign_in" ||
			payload.rejoin === "none"
		) ||
		!Array.isArray(payload.enrollments) ||
		payload.enrollments.length < 1 ||
		payload.enrollments.length > DEVICE_REMOVAL_MAX_ENROLLMENTS
	)
		return null;
	const enrollments = payload.enrollments.map(readEnrollment);
	if (enrollments.some((row) => row === null)) return null;
	const rows = enrollments as CoordinatorDeviceRemovalEnrollment[];
	if (
		new Set(rows.map(pair)).size !== rows.length ||
		!rows.some((row) => ids.includes(row.device_id))
	)
		return null;
	return {
		kind: "ready",
		device_ids: ids,
		key_id: payload.key_id,
		enrollments: rows,
		rejoin: payload.rejoin as ViewerRemovalPreview["rejoin"],
		expected_digest: input.expectedDigest,
	};
}

function batchSequence(values: readonly unknown[], preview: ViewerRemovalPreview): number | null {
	if (values.length !== preview.enrollments.length || values.length === 0) return null;
	const expected = new Set(preview.enrollments.map(pair));
	const sequences = new Set<number>();
	for (const value of values) {
		const row = record(value);
		if (
			!row ||
			!isAuthControllerId(row.group_id) ||
			!isAuthControllerId(row.device_id) ||
			!Number.isSafeInteger(row.removal_seq) ||
			(row.removal_seq as number) < 1
		)
			return null;
		if (
			!expected.delete(pair({ group_id: row.group_id, device_id: row.device_id })) ||
			sequences.has(row.removal_seq as number)
		)
			return null;
		sequences.add(row.removal_seq as number);
	}
	if (expected.size !== 0) return null;
	return Math.max(...sequences);
}

export function readViewerRemovalReceipt(
	payload: Record<string, unknown> | null,
	preview: ViewerRemovalPreview,
): ViewerRemovalEvidence | null {
	if (
		payload?.version !== 1 ||
		payload.state !== "removed" ||
		!isAuthControllerId(payload.removal_id) ||
		!matchesIds(payload.device_ids, preview.device_ids) ||
		payload.key_id !== preview.key_id ||
		!Array.isArray(payload.removals)
	)
		return null;
	const seq = batchSequence(payload.removals, preview);
	if (seq === null || payload.removal_seq !== seq) return null;
	return { removalId: payload.removal_id, removalSeq: seq, source: "receipt" };
}

export function recoverViewerRemoval(
	rows: readonly CoordinatorDeviceRemovalListItem[],
	preview: ViewerRemovalPreview,
): ViewerRemovalEvidence | null {
	const batches = new Map<string, CoordinatorDeviceRemovalListItem[]>();
	for (const row of rows) {
		const batch = batches.get(row.removal_id) ?? [];
		batch.push(row);
		batches.set(row.removal_id, batch);
	}
	const fingerprints = new Map(preview.enrollments.map((row) => [pair(row), row.fingerprint]));
	for (const [removalId, batch] of batches) {
		if (
			!isAuthControllerId(removalId) ||
			batch.some(
				(row) =>
					row.revoked === true ||
					row.key_id !== preview.key_id ||
					row.fingerprint !== fingerprints.get(pair(row)),
			)
		)
			continue;
		const seq = batchSequence(batch, preview);
		if (seq !== null) return { removalId, removalSeq: seq, source: "listing" };
	}
	return null;
}
