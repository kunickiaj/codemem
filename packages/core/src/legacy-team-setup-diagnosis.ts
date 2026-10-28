import { canonicalCoordinatorLegacyTeamCompletionManifestJson } from "./coordinator-legacy-team-completion.js";
import type { Database } from "./db.js";
import type { LegacyTeamRosterDeviceSnapshot } from "./legacy-team-candidate.js";
import {
	applyLegacyTeamSetupCompletionManifest,
	areLegacyTeamSetupCompletionPolicyFactsAdditivelyCompatible,
	reconstructLegacyTeamSetupCompletionManifest,
	validateLegacyTeamSetupCompletionManifest,
} from "./legacy-team-setup-completion-manifest.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

/** A failed setup step: the public error code plus the internal check that raised it. */
export interface LegacyTeamSetupDiagnosisFailure {
	ok: false;
	code: string;
	check: string | null;
}

export type LegacyTeamSetupDiagnosisStep<T> = ({ ok: true } & T) | LegacyTeamSetupDiagnosisFailure;

export interface LegacyTeamSetupCompletionDiagnosis {
	candidateRef: string;
	groupId: string;
	completedAt: string | null;
	manifest: LegacyTeamSetupDiagnosisStep<{ projectMappings: number }>;
	/** Mapped Spaces that are not active coordinator Spaces in this database. */
	unavailableScopeIds: string[];
	localCompletion: LegacyTeamSetupDiagnosisStep<{ identical: boolean; additive: boolean }>;
	apply: LegacyTeamSetupDiagnosisStep<{
		teamStatus: string | null;
		migrationState: string | null;
		grantedProjects: number;
	}> | null;
}

const INTERNAL_FAILURE_FRAMES = new Set(["fail", "activationError"]);

/**
 * Names the function and source line that raised a setup error. Public error
 * codes are shared by dozens of checks, so the stack frame is the only stable
 * way to tell them apart without changing every call site.
 */
export function legacyTeamSetupFailureCheck(error: unknown): string | null {
	const chain: Error[] = [];
	const seen = new Set<Error>();
	while (error instanceof Error && !seen.has(error) && chain.length < 32) {
		chain.push(error);
		seen.add(error);
		error = error.cause;
	}
	for (const cause of chain.toReversed()) {
		const check = failureStackCheck(cause);
		if (check) return check;
	}
	return null;
}

function failureStackCheck(error: Error): string | null {
	if (!error.stack) return null;
	for (const line of error.stack.split("\n").slice(1)) {
		const match = /^\s*at (?:async )?([^\s(]+) \((?:.*[\\/])?([^\\/:()]+):(\d+):\d+\)$/u.exec(line);
		if (!match) continue;
		const [, name, file, row] = match;
		const shortName = name?.split(".").at(-1) ?? "";
		if (INTERNAL_FAILURE_FRAMES.has(shortName)) continue;
		return `${shortName} (${file}:${row})`;
	}
	return null;
}

function failure(error: unknown): LegacyTeamSetupDiagnosisFailure {
	let code = "unknown";
	if (error instanceof Error) code = error.message;
	const errorCode = (error as { code?: unknown } | null)?.code;
	if (typeof errorCode === "string") code = errorCode;
	return { ok: false, code, check: legacyTeamSetupFailureCheck(error) };
}

function unavailableScopeIds(
	db: Database,
	coordinatorId: string,
	groupId: string,
	scopeIds: string[],
): string[] {
	const active = new Set(
		db
			.prepare(
				`SELECT scope_id FROM replication_scopes
				 WHERE coordinator_id = ? AND group_id = ?
				   AND authority_type = 'coordinator' AND status = 'active'`,
			)
			.pluck()
			.all(coordinatorId, groupId) as string[],
	);
	return [...new Set(scopeIds)].filter((scopeId) => !active.has(scopeId)).toSorted();
}

function diagnoseLocalCompletion(
	db: Database,
	candidateRef: string,
	manifest: ReturnType<typeof validateLegacyTeamSetupCompletionManifest>,
): LegacyTeamSetupCompletionDiagnosis["localCompletion"] {
	try {
		const local = reconstructLegacyTeamSetupCompletionManifest(db, { candidateRef });
		return {
			ok: true,
			identical:
				canonicalCoordinatorLegacyTeamCompletionManifestJson(local) ===
				canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest),
			additive: areLegacyTeamSetupCompletionPolicyFactsAdditivelyCompatible(local, manifest),
		};
	} catch (error) {
		return failure(error);
	}
}

function readTeamOutcome(db: Database, teamId: string) {
	const team = db
		.prepare("SELECT status, migration_state FROM policy_teams WHERE team_id = ?")
		.get(teamId) as { status: string; migration_state: string } | undefined;
	const grantedProjects = db
		.prepare(
			`SELECT COUNT(*) FROM project_recipients
			 WHERE recipient_kind = 'team' AND recipient_id = ? AND status = 'active'`,
		)
		.pluck()
		.get(teamId) as number;
	return {
		teamStatus: team?.status ?? null,
		migrationState: team?.migration_state ?? null,
		grantedProjects,
	};
}

/**
 * Applies the coordinator's completion inside a transaction that is always
 * rolled back, so the result shows what the viewer would do without changing
 * this database.
 */
async function dryRunApply(
	db: Database,
	input: {
		coordinatorId: string;
		groupId: string;
		manifest: ReturnType<typeof validateLegacyTeamSetupCompletionManifest>;
		freshRoster: readonly LegacyTeamRosterDeviceSnapshot[];
	},
): Promise<NonNullable<LegacyTeamSetupCompletionDiagnosis["apply"]>> {
	if (db.inTransaction) throw new Error("legacy_team_setup_diagnosis_requires_idle_database");
	db.exec("BEGIN IMMEDIATE");
	try {
		await applyLegacyTeamSetupCompletionManifest(db, input);
		return { ok: true, ...readTeamOutcome(db, input.manifest.team_id) };
	} catch (error) {
		return failure(error);
	} finally {
		if (db.inTransaction) db.exec("ROLLBACK");
	}
}

/** Explains why a coordinator completion does or does not apply on this device. */
export async function diagnoseLegacyTeamSetupCompletion(
	db: Database,
	input: {
		coordinatorId: string;
		groupId: string;
		completionManifest: unknown | null;
		freshRoster: readonly LegacyTeamRosterDeviceSnapshot[];
	},
): Promise<LegacyTeamSetupCompletionDiagnosis> {
	const { coordinatorId, groupId } = input;
	const candidateRef = legacyTeamCandidateId(coordinatorId, groupId);
	const base = { candidateRef, groupId, completedAt: null, unavailableScopeIds: [] };
	if (input.completionManifest == null) {
		return {
			...base,
			manifest: { ok: false, code: "coordinator_completion_absent", check: null },
			localCompletion: { ok: false, code: "coordinator_completion_absent", check: null },
			apply: null,
		};
	}
	let manifest: ReturnType<typeof validateLegacyTeamSetupCompletionManifest>;
	try {
		manifest = validateLegacyTeamSetupCompletionManifest(input.completionManifest, {
			coordinatorId,
			groupId,
		});
	} catch (error) {
		const invalid = failure(error);
		return { ...base, manifest: invalid, localCompletion: invalid, apply: null };
	}
	return {
		...base,
		completedAt: manifest.completed_at,
		manifest: { ok: true, projectMappings: manifest.project_mappings.length },
		unavailableScopeIds: unavailableScopeIds(
			db,
			coordinatorId,
			groupId,
			manifest.project_mappings.map((mapping) => mapping.scope_id),
		),
		localCompletion: diagnoseLocalCompletion(db, candidateRef, manifest),
		apply: await dryRunApply(db, {
			coordinatorId,
			groupId,
			manifest,
			freshRoster: input.freshRoster,
		}),
	};
}
