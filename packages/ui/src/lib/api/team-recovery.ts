/* Viewer calls for recovering a Team that was turned off after device removals:
 * a preview of what a recovery restores and leaves out, and the recovery itself.
 * Answers are checked before use, and only known error codes reach the UI. */

import { readJsonPayload } from "./internal";

export const TEAM_RECOVERY_ERROR_CODES = [
	"invalid_input",
	"coordinator_admin_required",
	"admin_authority_changed",
	"team_not_found",
	"team_coordinator_not_configured",
	"team_not_quarantined",
	"team_setup_busy",
	"setup_record_missing",
	"roster_unavailable",
	"device_removals_unavailable",
	"device_blocks_unavailable",
	"completion_unavailable",
	"member_removals_unavailable",
	"team_group_unavailable",
	"evidence_stale",
	"completion_missing",
	"completion_invalid",
	"setup_differs_from_completion",
	"team_group_conflict",
	"team_group_mismatch",
	"team_policy_blocked",
	"device_blocked",
	"device_evidence_contradictory",
	"device_key_unverified",
	"device_key_changed",
	"device_disabled",
	"device_block_unchecked",
	"device_missing_without_removal",
	"device_decision_changed",
	"recovery_preview_stale",
	"recovery_state_changed",
	"recovery_superseded",
	"recovery_unverified",
	"recovery_quarantined_again",
	"team_recovery_failed",
] as const;

export type TeamRecoveryErrorCode = (typeof TEAM_RECOVERY_ERROR_CODES)[number];

const KNOWN_ERRORS = new Set<string>(TEAM_RECOVERY_ERROR_CODES);

/** Why a recovery that was written did not leave the Team recovered. */
export type TeamRecoveryUnsettledReason =
	| "evidence_changed"
	| "evidence_unavailable"
	| "disabled_before_verification"
	| "evidence_stale"
	| "admin_authority_changed";

const UNSETTLED_REASONS = new Set<string>([
	"evidence_changed",
	"evidence_unavailable",
	"disabled_before_verification",
	"evidence_stale",
	"admin_authority_changed",
]);

export class TeamRecoveryApiError extends Error {
	constructor(
		readonly statusCode: number,
		readonly errorCode: TeamRecoveryErrorCode,
		readonly detail: { reason?: TeamRecoveryUnsettledReason; deviceIds?: string[] } = {},
	) {
		super(errorCode);
		this.name = "TeamRecoveryApiError";
	}
}

export interface TeamRecoveryPersonV1 {
	identityId: string;
	displayName: string | null;
	outcome: "member" | "left_out";
	reason?: string;
}

export interface TeamRecoveryDeviceV1 {
	deviceId: string;
	displayName: string | null;
	outcome: "regains_access" | "stays_out";
	reason?: string;
}

export interface TeamRecoveryProjectV1 {
	projectIdentity: string;
	displayName: string | null;
	outcome: "restored" | "resumes" | "skipped";
	reason?: string;
}

export interface TeamRecoveryPreviewV1 {
	teamId: string;
	teamName: string;
	people: TeamRecoveryPersonV1[];
	devices: TeamRecoveryDeviceV1[];
	projects: TeamRecoveryProjectV1[];
	/** Unfinished setup attempts started after the Team was turned off. Recovery discards them. */
	discardedSetupAttempts: number;
	expectedDigest: string;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isName = (value: unknown): value is string | null => value === null || isText(value);

function failed(status: number): never {
	throw new TeamRecoveryApiError(status, "team_recovery_failed");
}

/** The refusal an error answer carries, with its reason and devices when they are well formed. */
function refusal(status: number, payload: unknown): TeamRecoveryApiError {
	const body = isObject(payload) ? payload : {};
	const code = typeof body.error === "string" && KNOWN_ERRORS.has(body.error) ? body.error : "";
	if (!code) return new TeamRecoveryApiError(status, "team_recovery_failed");
	const reason = UNSETTLED_REASONS.has(String(body.reason))
		? (body.reason as TeamRecoveryUnsettledReason)
		: undefined;
	const deviceIds =
		Array.isArray(body.deviceIds) && body.deviceIds.every(isText) ? body.deviceIds : undefined;
	return new TeamRecoveryApiError(status, code as TeamRecoveryErrorCode, { reason, deviceIds });
}

async function post(path: string, body: unknown): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch {
		failed(0);
	}
	const { payload } = await readJsonPayload<unknown>(response);
	if (!response.ok) throw refusal(response.status, payload);
	return payload;
}

const recoveryPath = (teamId: string) =>
	`/api/sync/recipient-policy/v1/teams/${encodeURIComponent(teamId)}/recovery`;

/** Rows of one preview list, or null when any row is malformed. */
function rows<T>(value: unknown, idField: string, outcomes: readonly string[]): T[] | null {
	if (!Array.isArray(value)) return null;
	const valid = value.every(
		(row) =>
			isObject(row) &&
			isText(row[idField]) &&
			isName(row.displayName) &&
			outcomes.includes(String(row.outcome)) &&
			(row.reason === undefined || isText(row.reason)),
	);
	return valid ? (value as T[]) : null;
}

function parsePreview(payload: unknown, teamId: string): TeamRecoveryPreviewV1 | null {
	if (!isObject(payload) || payload.state !== "ready" || payload.teamId !== teamId) return null;
	const people = rows<TeamRecoveryPersonV1>(payload.people, "identityId", ["member", "left_out"]);
	const devices = rows<TeamRecoveryDeviceV1>(payload.devices, "deviceId", [
		"regains_access",
		"stays_out",
	]);
	const projects = rows<TeamRecoveryProjectV1>(payload.projects, "projectIdentity", [
		"restored",
		"resumes",
		"skipped",
	]);
	const discarded = payload.discardedSetupAttempts;
	if (!people || !devices || !projects || !isText(payload.teamName)) return null;
	if (!isText(payload.expectedDigest) || !Number.isSafeInteger(discarded)) return null;
	return {
		teamId,
		teamName: payload.teamName,
		people,
		devices,
		projects,
		discardedSetupAttempts: discarded as number,
		expectedDigest: payload.expectedDigest,
	};
}

/** Reviews a recovery: who and what comes back, what stays out, and a digest to confirm. */
export async function previewTeamRecovery(input: {
	teamId: string;
}): Promise<TeamRecoveryPreviewV1> {
	const payload = await post(`${recoveryPath(input.teamId)}/preview`, {});
	return parsePreview(payload, input.teamId) ?? failed(200);
}

/**
 * Recovers the Team as reviewed. Resolves only when the Team is recovered and
 * verified. Anything else throws, with `recovery_unverified` and
 * `recovery_quarantined_again` for a recovery that was written and not settled.
 */
export async function commitTeamRecovery(input: {
	teamId: string;
	expectedDigest: string;
}): Promise<void> {
	const payload = await post(`${recoveryPath(input.teamId)}/commit`, {
		expectedDigest: input.expectedDigest,
	});
	if (!isObject(payload) || payload.state !== "recovered") failed(200);
}
