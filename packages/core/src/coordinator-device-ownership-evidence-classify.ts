import {
	type ControllerHistorySnapshot,
	parseControllerHistoryRecord,
} from "./coordinator-auth-controller-history.js";
import { RESOLUTION_COLUMNS } from "./coordinator-device-ownership-evidence-queries.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	captureLegacyOwnerResolutionRecord,
	type ReviewedWeakLabel,
} from "./coordinator-legacy-owner-resolution-metadata.js";

export type EvidenceRow = (string | number | null)[];
export type EvidenceRows = Record<string, EvidenceRow[]>;
export function evidenceRows(rows: EvidenceRows, name: string): EvidenceRow[] {
	const result = rows[name];
	if (!result) throw new Error("missing_evidence");
	return result;
}
export interface EvidenceSubject {
	coordinatorId: string;
	groupId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	keyId: string;
}
export type OwnershipDecision =
	| "compatible"
	| "owner_transfer_required"
	| "weak_label_review_required"
	| "device_revoked";

export function identifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		value.trim() === value &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	);
}
export function hash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function timestamp(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value))
		return false;
	return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function requireValid(condition: unknown): asserts condition {
	if (!condition) throw new Error("ownership_evidence_unavailable");
}
export async function keyId(value: unknown): Promise<string> {
	requireValid(typeof value === "string" && value.length > 0 && value.length <= 4096);
	const result = await ed25519KeyIdForRevocation(value);
	requireValid(result);
	return result;
}

function validateBinding(row: EvidenceRow) {
	requireValid(
		row.length === 8 &&
			[0, 2, 3, 4, 6].every((i) => identifier(row[i])) &&
			hash(row[1]) &&
			timestamp(row[7]),
	);
	requireValid(row[5] === "owner_enrollment" || row[5] === "reviewed_legacy_migration");
}
async function validateClaim(row: EvidenceRow) {
	requireValid(
		row.length === 12 &&
			[0, 1, 2, 3, 4, 8, 9].every((i) => identifier(row[i])) &&
			hash(row[6]) &&
			hash(row[7]) &&
			hash(row[10]),
	);
	requireValid(Number.isSafeInteger(row[11]) && Number(row[11]) >= 0);
	// Device collisions remain negative facts even when a stored key ID differs.
	await keyId(row[5]);
}
async function validateController(row: EvidenceRow) {
	requireValid(
		row.length === 13 &&
			[0, 1, 2, 3, 4, 7].every((i) => identifier(row[i])) &&
			hash(row[6]) &&
			hash(row[8]),
	);
	requireValid(
		(row[9] === null || identifier(row[9])) &&
			row[10] === 1 &&
			timestamp(row[11]) &&
			(row[12] === null || timestamp(row[12])),
	);
	return keyId(row[5]);
}
async function validateInvite(row: EvidenceRow) {
	requireValid(row.length === 15 && identifier(row[0]) && identifier(row[1]) && identifier(row[2]));
	requireValid([3, 4, 5].every((i) => timestamp(row[i])) && (row[6] === null || timestamp(row[6])));
	requireValid(String(row[3]) <= String(row[5]) && String(row[5]) <= String(row[4]));
	requireValid(row[6] === null || String(row[5]) < String(row[6]));
	requireValid(identifier(row[7]) && hash(row[9]) && hash(row[14]));
	requireValid([11, 12, 13].every((i) => row[i] === null || identifier(row[i])));
	requireValid(["team_member", "add_device", "project_share"].includes(String(row[10])));
	if (row[10] === "team_member") requireValid(identifier(row[11]) && row[13] === row[11]);
	if (row[10] === "add_device") requireValid(identifier(row[12]) && row[13] === row[12]);
	if (row[10] === "project_share") requireValid(identifier(row[13]));
	return keyId(row[8]);
}

function legacyLabels(
	history: ControllerHistorySnapshot,
	subject: EvidenceSubject,
): ReviewedWeakLabel[] {
	return history.records.flatMap((record) => {
		const { manifest } = parseControllerHistoryRecord(record, subject.coordinatorId);
		return manifest.device_decisions.flatMap((decision) => {
			if (decision.decision !== "included" || !decision.enabled || !decision.identity_id) return [];
			if (
				decision.device_id !== subject.deviceId &&
				!history.fingerprints.includes(decision.key_fingerprint)
			)
				return [];
			return [
				{
					label: decision.identity_id,
					kind: "legacy_included_owner_label" as const,
					group_id: record.group_id,
					device_id: decision.device_id,
					evidence_ref: manifest.source_digest,
					effect: "account_owner_display_only" as const,
				},
			];
		});
	});
}

async function validateResolutionRows(rows: EvidenceRow[]) {
	for (const row of rows) {
		requireValid(row.length === RESOLUTION_COLUMNS.length);
		requireValid(
			await captureLegacyOwnerResolutionRecord(
				Object.fromEntries(RESOLUTION_COLUMNS.map((field, i) => [field, row[i]])),
			),
		);
	}
}

async function strongSources(
	rows: EvidenceRows,
	subject: EvidenceSubject,
	owner: string,
	weakLabels: ReviewedWeakLabel[],
): Promise<boolean> {
	let otherOwner = false;
	for (const row of evidenceRows(rows, "bindings")) {
		validateBinding(row);
		if (row[2] !== owner) otherOwner = true;
	}
	for (const row of evidenceRows(rows, "claims")) {
		await validateClaim(row);
		if (row[2] !== owner) otherOwner = true;
	}
	for (const row of evidenceRows(rows, "controllers")) {
		const canonicalKey = await validateController(row);
		if ((row[4] === subject.deviceId || canonicalKey === subject.keyId) && row[2] !== owner)
			otherOwner = true;
	}
	const inviteConflict = await classifyInvites(
		evidenceRows(rows, "invites"),
		subject,
		owner,
		weakLabels,
	);
	return otherOwner || inviteConflict;
}

async function classifyInvites(
	rows: EvidenceRow[],
	subject: EvidenceSubject,
	owner: string,
	weakLabels: ReviewedWeakLabel[],
): Promise<boolean> {
	let otherOwner = false;
	for (const row of rows) {
		const canonicalKey = await validateInvite(row);
		if (row[7] !== subject.deviceId && canonicalKey !== subject.keyId) continue;
		if (row[10] === "project_share") {
			weakLabels.push({
				label: String(row[13]),
				kind: "consumed_project_actor_label",
				group_id: String(row[1]),
				device_id: String(row[7]),
				evidence_ref: String(row[14]),
				effect: "account_owner_display_only",
			});
			continue;
		}
		const invitedOwner = row[10] === "team_member" ? row[11] : row[12];
		if (invitedOwner !== owner) otherOwner = true;
	}
	return otherOwner;
}

export async function classifyEvidence(
	rows: EvidenceRows,
	subject: EvidenceSubject,
	owner: string,
	history: ControllerHistorySnapshot,
): Promise<{ decision: OwnershipDecision; weakLabels: ReviewedWeakLabel[] }> {
	const enrollment = evidenceRows(rows, "enrollment");
	requireValid(enrollment.length === 1);
	const current = enrollment[0];
	requireValid(current);
	const [group, device, publicKey, fingerprint, label, enabled, archived] = current;
	requireValid(
		group === subject.groupId &&
			device === subject.deviceId &&
			publicKey === subject.publicKey &&
			fingerprint === subject.fingerprint &&
			enabled === 1 &&
			archived === null,
	);
	requireValid(label === null || identifier(label));
	await validateResolutionRows(evidenceRows(rows, "resolutions"));
	const weakLabels = legacyLabels(history, subject);
	const otherOwner = await strongSources(rows, subject, owner, weakLabels);
	// Resolution receipts are metadata only, but conflicting owner collisions must
	// not disappear just because their original positive source no longer verifies.
	const resolutionConflict = evidenceRows(rows, "resolutions").some((row) => row[5] !== owner);
	if (evidenceRows(rows, "revocations").length) return { decision: "device_revoked", weakLabels };
	if (otherOwner || resolutionConflict) return { decision: "owner_transfer_required", weakLabels };
	requireValid(
		label === null || label === owner || weakLabels.some((weak) => weak.label === label),
	);
	const relevantLabels = weakLabels.filter((weak) => weak.label !== owner);
	return {
		decision: relevantLabels.length ? "weak_label_review_required" : "compatible",
		weakLabels: relevantLabels,
	};
}
