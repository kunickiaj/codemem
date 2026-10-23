import type {
	RecoveryPreview,
	RecoveryProfile,
	RecoveryResult,
} from "../../tabs/account-owner-recovery-types";

export interface RecoveryProfileEnvelope {
	version: 1;
	profile: RecoveryProfile;
	candidates: readonly { id: string; label?: string }[];
	reviewAccess: "operator" | "request";
}

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 2048): value is string =>
	typeof value === "string" && value.length <= max && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
const id = (value: unknown): value is string =>
	text(value, 256) && value.length > 0 && value.trim() === value;
const historyRowId = (value: unknown): value is string =>
	text(value, 512) && value.length > 0 && value.trim() === value;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const list = <T>(value: unknown, validate: (item: unknown) => item is T, max = 500): value is T[] =>
	Array.isArray(value) && value.length <= max && value.every(validate);
const ids = (value: unknown): value is string[] =>
	list(value, id) && new Set(value).size === value.length;
const fields = (value: Record<string, unknown>, keys: string[]) =>
	Object.keys(value).every((key) => keys.includes(key));
// The backend allows 500 manifest records, each with up to 500 device decisions.
const MAX_HISTORY_ROWS = 500 * 500;

export function validRecoveryProfile(value: unknown): value is RecoveryProfile {
	if (!record(value)) return false;
	const keys = [
		"contextId",
		"memoryActorId",
		"deviceId",
		"fingerprint",
		"coordinatorOrigin",
		"coordinatorId",
	];
	if (
		!fields(value, [...keys, "configuredGroups"]) ||
		!keys.every((key) => id(value[key])) ||
		!ids(value.configuredGroups)
	)
		return false;
	try {
		const url = new URL(String(value.coordinatorOrigin));
		return (
			url.origin === value.coordinatorOrigin &&
			(url.protocol === "https:" ||
				(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
		);
	} catch {
		return false;
	}
}

export function validRecoveryEnvelope(value: unknown): value is RecoveryProfileEnvelope {
	return (
		record(value) &&
		fields(value, ["version", "profile", "candidates", "reviewAccess"]) &&
		value.version === 1 &&
		validRecoveryProfile(value.profile) &&
		(value.reviewAccess === "operator" || value.reviewAccess === "request") &&
		list(
			value.candidates,
			(item): item is { id: string; label?: string } =>
				record(item) &&
				fields(item, ["id", "label"]) &&
				id(item.id) &&
				(item.label === undefined || text(item.label, 256)),
			256,
		)
	);
}

function validHistory(value: unknown): boolean {
	if (!record(value) || !fields(value, ["complete", "rows", "operatorHelp"])) return false;
	if (value.complete !== true && (value.complete !== false || !text(value.operatorHelp)))
		return false;
	return list(
		value.rows,
		(row): row is Record<string, unknown> =>
			record(row) &&
			fields(row, [
				"id",
				"groupId",
				"deviceId",
				"fingerprint",
				"identityId",
				"assignment",
				"relation",
				"reason",
			]) &&
			historyRowId(row.id) &&
			["groupId", "deviceId", "fingerprint"].every((key) => id(row[key])) &&
			text(row.identityId, 256) &&
			(row.assignment === "included" || row.assignment === "excluded") &&
			["exact_subject", "alias", "other"].includes(String(row.relation)) &&
			text(row.reason),
		MAX_HISTORY_ROWS,
	);
}

function validWeakLabel(value: unknown): value is Record<string, unknown> {
	return (
		record(value) &&
		fields(value, ["kind", "label", "group_id", "device_id", "evidence_ref", "effect"]) &&
		(value.kind === "legacy_included_owner_label" ||
			value.kind === "consumed_project_actor_label") &&
		["label", "group_id", "device_id", "evidence_ref"].every((key) => id(value[key])) &&
		value.effect === "account_owner_display_only"
	);
}

export function validRecoveryPreview(value: unknown): value is RecoveryPreview {
	if (
		!record(value) ||
		!fields(value, [
			"profile",
			"existingOwnerId",
			"groups",
			"requestId",
			"purpose",
			"scope",
			"approvalDigest",
			"groupPreviews",
			"history",
			"reviewedWeakLabels",
		])
	)
		return false;
	if (
		!validRecoveryProfile(value.profile) ||
		!id(value.existingOwnerId) ||
		!ids(value.groups) ||
		!value.groups.length ||
		!id(value.requestId)
	)
		return false;
	if (
		value.scope !== "historical_included_owner_labels_only" ||
		!hash(value.approvalDigest) ||
		!validHistory(value.history) ||
		!list(value.reviewedWeakLabels, validWeakLabel, 256)
	)
		return false;
	if (value.purpose !== undefined && value.purpose !== "review" && value.purpose !== "check_status")
		return false;
	return list(
		value.groupPreviews,
		(group): group is Record<string, unknown> =>
			record(group) &&
			fields(group, ["groupId", "action", "reason"]) &&
			id(group.groupId) &&
			["new", "reuse", "blocked"].includes(String(group.action)) &&
			text(group.reason),
	);
}

export function validRecoveryResult(value: unknown): value is RecoveryResult {
	if (
		!record(value) ||
		!fields(value, ["preview", "groups"]) ||
		!validRecoveryPreview(value.preview)
	)
		return false;
	const groups = value.preview.groups;
	return (
		list(
			value.groups,
			(group): group is Record<string, unknown> =>
				record(group) &&
				fields(group, ["groupId", "status", "message"]) &&
				id(group.groupId) &&
				groups.includes(group.groupId) &&
				["confirmed", "failed", "unknown"].includes(String(group.status)) &&
				text(group.message),
		) &&
		value.groups.length === groups.length &&
		new Set(value.groups.map((group) => group.groupId)).size === value.groups.length
	);
}
